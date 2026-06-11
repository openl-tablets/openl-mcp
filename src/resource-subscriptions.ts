/**
 * Per-MCP-session manager for `openl://status/...` resource subscriptions.
 *
 * Wires the MCP `resources/subscribe` lifecycle to the studio's STOMP status
 * topic. On subscribe, the manager:
 *   1. Parses the URI into `(projectId, branch?)`.
 *   2. Does a one-shot HTTP fetch (`getProjectStatus`) to seed the JSESSIONID
 *      cookie needed for the WS handshake and — when the URI omits a branch
 *      on a branch-supporting project — to discover the actual branch.
 *   3. Opens a long-lived STOMP subscription via `subscribeProjectStatus`
 *      (with reconnect enabled).
 *   4. On each STOMP frame, calls `sendUpdated(originalUri)` to emit a
 *      payload-less `notifications/resources/updated` doorbell. Per the MCP
 *      spec, the notification URI must match what the client subscribed to,
 *      so we preserve the original URI verbatim regardless of any branch
 *      resolution we did internally.
 *
 * Each MCP session gets its own `ResourceSubscriptionManager`. Subscriptions
 * are tracked per-URI; duplicate subscribes are idempotent (spec). Session
 * teardown (`closeAll`) tears down every STOMP connection this manager
 * opened. No shared state across sessions — different sessions use different
 * studio cookies and may have different identities.
 *
 * The `subscribeImpl` test seam mirrors the pattern used by
 * `stomp-waits.ts`: production code uses `subscribeProjectStatus`
 * from `stomp-client.ts`; tests inject a fake that delivers scripted frames.
 */

import { subscribeProjectStatus, Subscription, SubscribeProjectStatusOpts } from "./stomp-client.js";
import { OpenLClient } from "./client.js";
import { sanitizeError } from "./utils.js";

/** Test seam for `subscribeProjectStatus`. */
export type SubscribeFn = (opts: SubscribeProjectStatusOpts) => Promise<Subscription>;

/**
 * Fire-and-forget doorbell emitter. Provided by the per-session MCP `Server`
 * — typically `(uri) => server.sendResourceUpdated({ uri })`. Wrapped here
 * so notification-send failures are non-fatal (we still want to keep the
 * STOMP subscription alive even if one outbound notification fails).
 */
export type SendUpdatedFn = (uri: string) => Promise<void> | void;

/**
 * Default reconnect delay (ms) for resource-level STOMP subscriptions.
 * Long-lived subscriptions need reconnect; transient drops shouldn't kill them.
 */
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

/** URI prefix this manager handles. Other URIs are rejected at subscribe time. */
const STATUS_URI_PREFIX = "openl://status/";

/**
 * Opt-in verbose logging. Set `DEBUG_RESOURCE_SUB=true` on the container to
 * trace subscription lifecycle + every notification dispatch on stderr.
 * Errors are always logged regardless of this flag.
 */
const DEBUG = process.env.DEBUG_RESOURCE_SUB === "true";

function debug(message: string, context?: Record<string, unknown>): void {
  if (!DEBUG) return;
  console.error(`[ResourceSub] ${message}`, context ? JSON.stringify(context) : "");
}

interface SubscriptionEntry {
  /** The exact URI the client subscribed to — used verbatim in notifications. */
  uri: string;
  /** Underlying STOMP subscription handle. */
  stomp: Subscription;
}

/**
 * Parse `openl://status/{projectId}[/{branch}]` into its components.
 * Returns `null` if the URI doesn't match the status schema.
 */
export function parseStatusUri(uri: string): { projectId: string; branch?: string } | null {
  if (!uri.startsWith(STATUS_URI_PREFIX)) return null;
  const path = uri.substring(STATUS_URI_PREFIX.length);
  if (path.length === 0) return null;
  const slashIndex = path.indexOf("/");
  if (slashIndex < 0) {
    return { projectId: decodeURIComponent(path) };
  }
  const projectId = decodeURIComponent(path.substring(0, slashIndex));
  const branch = decodeURIComponent(path.substring(slashIndex + 1));
  return { projectId, branch: branch.length > 0 ? branch : undefined };
}

export class ResourceSubscriptionManager {
  private readonly subscriptions = new Map<string, SubscriptionEntry>();

  constructor(
    private readonly client: OpenLClient,
    private readonly sendUpdated: SendUpdatedFn,
    private readonly subscribeImpl: SubscribeFn = subscribeProjectStatus,
    private readonly reconnectDelayMs: number = DEFAULT_RECONNECT_DELAY_MS,
  ) {}

  /**
   * Handle `resources/subscribe { uri }`. Idempotent — duplicate subscribes
   * on the same URI are a no-op.
   *
   * Throws `Error` with a descriptive message for URIs that don't match the
   * `openl://status/...` schema. The caller (MCP SDK request handler) should
   * convert this to an MCP error response.
   */
  async subscribe(uri: string): Promise<void> {
    debug("subscribe.start", { uri });
    const parsed = parseStatusUri(uri);
    if (!parsed) {
      throw new Error(
        `Unsupported subscribe URI: ${uri}. This server only supports openl://status/{projectId}[/{branch}].`,
      );
    }

    if (this.subscriptions.has(uri)) {
      // Idempotent: spec allows duplicate subscribes; just return success.
      debug("subscribe.duplicate", { uri });
      return;
    }

    // Step 1: seed the JSESSIONID cookie and (when the URI omits a branch)
    // discover the project's actual branch from the response. The wait flow
    // uses the same pattern (`stomp-waits.ts`).
    debug("subscribe.seed", { projectId: parsed.projectId, branchInUri: parsed.branch ?? null });
    const initial = await this.client.getProjectStatus(parsed.projectId);
    const cookie = this.client.getSessionCookie();
    if (!cookie) {
      // Degraded mode: studio didn't issue a session cookie. Skip STOMP
      // (we'd connect anonymously and never receive user-routed frames).
      // Reads still work via the resource read handler; the client just
      // won't get push notifications until something seeds the cookie.
      console.error(
        `[ResourceSub] ⚠️  No JSESSIONID after initial fetch for ${uri}; subscribing without STOMP push (degraded).`,
      );
      return;
    }

    // If the URI omits a branch but the project supports branches, use the
    // project's actual branch for the STOMP destination. Notifications still
    // reference the original (no-branch) URI per spec.
    const branchForStomp = parsed.branch ?? initial.branch;
    debug("subscribe.stomp.opening", {
      uri,
      projectId: parsed.projectId,
      branchUsedForStomp: branchForStomp ?? null,
      cookiePrefix: cookie.substring(0, 12) + "…",
    });

    // The WS upgrade is authenticated by the Authorization header (the session
    // cookie alone is rejected for user-routed /user/topic destinations).
    // Without credentials the subscription connects anonymously and never
    // receives frames, so surface that instead of failing silently.
    const authorizationHeader = this.client.getAuthorizationHeader();
    if (!authorizationHeader) {
      console.error(
        `[ResourceSub] ⚠️  Subscribing to ${uri} without credentials; the studio rejects ` +
          "anonymous subscriptions to user-routed topics, so push notifications may never arrive.",
      );
    }

    // Step 2: open the STOMP subscription. Reconnect is on for resource-level
    // subscriptions so transient WS drops don't lose the subscription.
    const stomp = await this.subscribeImpl({
      studioBaseUrl: this.client.getBaseUrl(),
      cookieHeader: `JSESSIONID=${cookie}`,
      authorizationHeader,
      projectId: parsed.projectId,
      branch: branchForStomp,
      reconnectDelay: this.reconnectDelayMs,
      onMessage: (status) => {
        // Per MCP spec, notifications/resources/updated carries only `{ uri }`
        // — no payload. Client must re-read to fetch current state.
        // Notification failures must NOT tear down the STOMP subscription,
        // so we swallow them with a warn log.
        debug("frame.received → emitting doorbell", {
          uri,
          compileState: status.compileState,
        });
        try {
          const result = this.sendUpdated(uri);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>)
              .then(() => debug("doorbell.sent", { uri }))
              .catch((err) => {
                console.error(
                  `[ResourceSub] sendResourceUpdated failed for ${uri}: ${sanitizeError(err)}`,
                );
              });
          } else {
            debug("doorbell.sent", { uri });
          }
        } catch (err) {
          console.error(
            `[ResourceSub] sendResourceUpdated threw for ${uri}: ${sanitizeError(err)}`,
          );
        }
      },
      onError: (err) => {
        // STOMP/WS errors don't tear down the subscription (reconnect handles
        // transient drops); just log so they're visible in container logs.
        console.error(`[ResourceSub] STOMP error for ${uri}: ${sanitizeError(err)}`);
      },
    });

    // Re-check after the await chain above. Two concurrent subscribe() calls
    // for the same URI can both pass the early `has(uri)` guard (lines 116-120)
    // before either of them awaits `getProjectStatus + subscribeImpl`. Without
    // this guard, both would `set()` and the second would overwrite the first,
    // leaking the first STOMP subscription with no reference left to close it.
    // On race loss: tear down the freshly-opened STOMP so the studio isn't
    // left with a dangling WS session.
    if (this.subscriptions.has(uri)) {
      debug("subscribe.race.discarded", { uri });
      await stomp.close().catch((err) => {
        console.error(
          `[ResourceSub] close failed for discarded race-loser ${uri}: ${sanitizeError(err)}`,
        );
      });
      return;
    }

    this.subscriptions.set(uri, { uri, stomp });
    debug("subscribe.opened", { uri, totalSubscriptions: this.subscriptions.size });
  }

  /**
   * Handle `resources/unsubscribe { uri }`. Idempotent — unsubscribing an
   * unknown URI succeeds silently per spec.
   */
  async unsubscribe(uri: string): Promise<void> {
    const entry = this.subscriptions.get(uri);
    if (!entry) {
      debug("unsubscribe.unknown (idempotent no-op)", { uri });
      return;
    }
    debug("unsubscribe.start", { uri });
    this.subscriptions.delete(uri);
    await entry.stomp.close().catch((err) => {
      console.error(`[ResourceSub] close failed for ${uri}: ${sanitizeError(err)}`);
    });
    debug("unsubscribe.done", { uri, remaining: this.subscriptions.size });
  }

  /**
   * Tear down every subscription this manager owns. Called from the session
   * close path on both HTTP transports (SSE `res.close`, StreamableHTTP
   * `transport.onclose`) and from stdio shutdown signals.
   */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.subscriptions.values());
    if (entries.length === 0) {
      debug("closeAll.empty");
      return;
    }
    debug("closeAll.start", { count: entries.length, uris: entries.map((e) => e.uri) });
    this.subscriptions.clear();
    await Promise.all(
      entries.map((e) =>
        e.stomp.close().catch((err) => {
          console.error(
            `[ResourceSub] close failed for ${e.uri} during shutdown: ${sanitizeError(err)}`,
          );
        }),
      ),
    );
    debug("closeAll.done", { count: entries.length });
  }

  /** Read-only view, useful for tests and diagnostics. */
  get size(): number {
    return this.subscriptions.size;
  }
}
