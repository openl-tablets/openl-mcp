/**
 * Minimal STOMP client for the OpenL Studio project-status topic.
 *
 * The studio publishes `ProjectStatusViewModel` JSON on
 * `/topic/projects/{encoded}/branches/{encoded}/status` (or the no-branch variant)
 * via Spring's `convertAndSendToUser`. The broker prefix is `/user`, the broker
 * resolves the principal from the WebSocket session, and STOMP CONNECT frames
 * carry no credentials — authentication piggybacks on the HTTP handshake's
 * JSESSIONID cookie.
 *
 * This module is intentionally narrow: one subscription per call, no pooling,
 * no reconnect, no global state. It's invoked from `wait-for-compilation.ts`
 * inside a single tool invocation and torn down when the call returns.
 */

import { Client, IFrame, IMessage } from "@stomp/stompjs";
import WebSocket from "ws";

import type * as Types from "./types.js";

export interface SubscribeProjectStatusOpts {
  /** Studio base URL (e.g. `http://host.docker.internal:8080/rest`). The `/rest` segment is stripped before appending `/ws`. */
  studioBaseUrl: string;
  /** Full `Cookie` header value, e.g. `JSESSIONID=abc123`. Required — the studio authenticates STOMP via the HTTP session cookie. */
  cookieHeader: string;
  /** Already-decoded project identifier. URL-encoded here for the destination path. */
  projectId: string;
  /** Already-decoded branch name. Optional — when omitted, subscribes to the no-branch destination. */
  branch?: string;
  /** Called once per STOMP message received on the topic. The payload is parsed as ProjectStatusView. */
  onMessage: (status: Types.ProjectStatusView) => void;
  /** Optional non-fatal error sink. STOMP/WS errors are reported here; the subscription stays open until `close()` or `signal`. */
  onError?: (error: Error) => void;
  /** Aborting deactivates the underlying STOMP client. */
  signal?: AbortSignal;
}

export interface Subscription {
  close(): Promise<void>;
}

/**
 * Open a STOMP subscription and call `onMessage` for each frame.
 *
 * Resolves once the underlying STOMP CONNECT has succeeded and the SUBSCRIBE
 * frame has been sent. Rejects if the WebSocket / STOMP handshake fails — the
 * caller should treat that as a hard error (typically: missing/expired cookie,
 * wrong URL, or studio not reachable).
 */
export async function subscribeProjectStatus(
  opts: SubscribeProjectStatusOpts
): Promise<Subscription> {
  const wsUrl = deriveWsUrl(opts.studioBaseUrl);
  const destination = buildDestination(opts.projectId, opts.branch);

  const client = new Client({
    webSocketFactory: () =>
      // Node's `ws` accepts a `headers` option on construction; the browser
      // WebSocket does not. The `IStompSocket` interface is structurally
      // compatible — cast through `unknown` to satisfy the SDK's type.
      new WebSocket(wsUrl, {
        headers: { Cookie: opts.cookieHeader },
      }) as unknown as WebSocket,
    reconnectDelay: 0,
    heartbeatIncoming: 10_000,
    heartbeatOutgoing: 10_000,
  });

  return new Promise<Subscription>((resolve, reject) => {
    let connected = false;

    const abortHandler = (): void => {
      void client.deactivate();
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    const cleanup = (): void => {
      opts.signal?.removeEventListener("abort", abortHandler);
    };

    client.onConnect = () => {
      try {
        client.subscribe(destination, (frame: IMessage) => {
          try {
            const parsed = JSON.parse(frame.body) as Types.ProjectStatusView;
            opts.onMessage(parsed);
          } catch (err) {
            opts.onError?.(
              err instanceof Error
                ? err
                : new Error(`Failed to parse STOMP frame: ${String(err)}`)
            );
          }
        });
        connected = true;
        resolve({
          close: async () => {
            cleanup();
            await client.deactivate();
          },
        });
      } catch (err) {
        cleanup();
        void client.deactivate();
        reject(
          err instanceof Error
            ? err
            : new Error(`Failed to subscribe: ${String(err)}`)
        );
      }
    };

    client.onStompError = (frame: IFrame) => {
      const message = frame.headers["message"] ?? "STOMP error";
      const err = new Error(`STOMP error: ${message}`);
      if (!connected) {
        cleanup();
        reject(err);
      } else {
        opts.onError?.(err);
      }
    };

    client.onWebSocketError = (event: Event) => {
      // `event` here is whatever the underlying socket emits; ws gives us an Error-like shape.
      const err =
        event instanceof Error
          ? event
          : new Error(`WebSocket error: ${String((event as { message?: string }).message ?? event)}`);
      if (!connected) {
        cleanup();
        reject(err);
      } else {
        opts.onError?.(err);
      }
    };

    client.activate();
  });
}

/**
 * Build the STOMP destination for a project's status topic.
 *
 * Mirrors `ProjectSocketNotificationService.notifyProjectStatus` in the studio
 * — the broker resolves the `/user` prefix from the session principal, so the
 * subscriber path includes only the `/user/topic/...` part without a username
 * segment.
 */
export function buildDestination(projectId: string, branch?: string): string {
  const encodedProject = encodeURIComponent(projectId);
  if (branch && branch.length > 0) {
    return `/user/topic/projects/${encodedProject}/branches/${encodeURIComponent(branch)}/status`;
  }
  return `/user/topic/projects/${encodedProject}/status`;
}

/**
 * Translate an HTTP studio base URL into the WebSocket URL for the STOMP endpoint.
 *
 * - Scheme: `http`→`ws`, `https`→`wss`.
 * - Path: append `/ws` to the existing `/rest` API root, yielding `/rest/ws`.
 *   Living under `/rest/**` puts the STOMP handshake inside the REST security
 *   filter chain (Basic auth, PAT auth, session creation) — the path under
 *   which the studio UI currently mounts the endpoint (`/web/ws`) is
 *   intentionally `permitAll` with no Basic/PAT filter, making it unusable
 *   for headless clients without a pre-existing session cookie.
 */
export function deriveWsUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Append `/ws` to the existing path. `OpenLClient.normalizeOpenLBaseUrl`
  // guarantees the base ends with `/rest`, so the result is `/rest/ws`.
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}
