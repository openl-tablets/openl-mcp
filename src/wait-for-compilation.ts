/**
 * Block until an OpenL project's compilation reaches a terminal state.
 *
 * Combines an HTTP snapshot from `OpenLClient.getProjectStatus` with a per-call
 * STOMP subscription on the studio's status topic. The flow:
 *
 *   1. HTTP fetch (no `branch` query — backend returns the project's actual
 *      branch, also seeds the JSESSIONID cookie needed for the WS handshake).
 *   2. Terminal? return immediately.
 *   3. If the caller requested a branch that differs from the project's actual
 *      branch, silently switch (re-using {@link OpenLClient.switchBranch} when
 *      the project is already opened, falling back to
 *      {@link OpenLClient.openProject} otherwise — same pattern as the existing
 *      `openl_open_project` handler). Re-fetch status after the switch.
 *   4. STOMP subscribe using the project's *actual* branch (so the destination
 *      matches the topic the studio publishes to — branch-supporting projects
 *      get `/user/topic/projects/<id>/branches/<branch>/status`; others get
 *      the no-branch variant).
 *   5. HTTP fetch again — closes the race where the terminal status arrived
 *      between steps 1 and 4.
 *   6. Terminal? unsubscribe + return.
 *   7. Wait for a terminal STOMP message (or timeout / abort).
 *   8. Always unsubscribe in `finally`.
 *
 * The race in step 5 is unavoidable without subscribing before triggering the
 * compile — and the compile was triggered by the LLM before this call, so we
 * have to assume the terminal might already be in flight.
 */

import { subscribeProjectStatus, Subscription } from "./stomp-client.js";
import { OpenLClient } from "./client.js";
import type * as Types from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * States the wait flow treats as "no need to wait" — everything except
 * `compiling`. `idle` is included because it means the studio has no compile
 * job registered for the session and nothing will fire a STOMP event;
 * subscribing in that state would hang until the timeout.
 */
const RESOLVED_STATES: ReadonlySet<Types.CompileState> = new Set([
  "idle",
  "ok",
  "warnings",
  "errors",
]);

export interface WaitForCompilationOptions {
  /** Called for every non-terminal status snapshot received over STOMP. Use it to emit MCP progress notifications. */
  onProgress?: (status: Types.ProjectStatusView) => void;
  /** When aborted, the call rejects with `AbortError` and the STOMP subscription is torn down. */
  signal?: AbortSignal;
  /** Hard cap on wait time. On expiry, the last-seen status is returned (no error). Default 120000 ms. */
  timeoutMs?: number;
}

/** Test seam: lets unit tests inject a fake STOMP subscriber without touching the network. */
export type SubscribeFn = typeof subscribeProjectStatus;

/**
 * True for any state that doesn't warrant waiting — terminal outcomes
 * (`ok`/`warnings`/`errors`) and `idle` (no compile registered, nothing to
 * wait for). The wait flow only blocks when `compileState === "compiling"`.
 */
export function isResolvedCompileState(state: Types.CompileState): boolean {
  return RESOLVED_STATES.has(state);
}

export async function waitForCompilation(
  client: OpenLClient,
  projectId: string,
  requestedBranch: string | undefined,
  options: WaitForCompilationOptions = {},
  // Allow tests to inject a fake STOMP implementation.
  subscribeImpl: SubscribeFn = subscribeProjectStatus
): Promise<Types.ProjectStatusView> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.signal?.aborted) {
    throw abortError();
  }

  // Step 1: initial fetch WITHOUT the branch query — the backend would otherwise
  // 409 on mismatch, but we want to detect the mismatch and switch instead.
  // The response also seeds the JSESSIONID cookie needed for the WS handshake.
  let initial = await client.getProjectStatus(projectId);
  if (isResolvedCompileState(initial.compileState)) {
    return initial;
  }

  // Step 3: silent branch switch if the caller asked for a branch that differs
  // from the project's actual branch. `initial.branch` is populated only for
  // projects that support branches (see `ProjectStatusMapperImpl.map`), so a
  // missing `initial.branch` means there's nothing to switch.
  if (
    requestedBranch &&
    initial.branch &&
    requestedBranch !== initial.branch
  ) {
    await switchToBranch(client, projectId, requestedBranch);
    initial = await client.getProjectStatus(projectId);
    if (isResolvedCompileState(initial.compileState)) {
      return initial;
    }
  }

  const cookie = client.getSessionCookie();
  if (!cookie) {
    // The HTTP fetch above should have set the cookie; if it didn't, the studio
    // isn't issuing a session and we can't open the WS. Fall back to the latest
    // snapshot so the caller at least gets the current state.
    return initial;
  }

  // Subscribe with the project's ACTUAL branch (after any switch above). The
  // studio publishes to either `/topic/projects/<id>/branches/<branch>/status`
  // or `/topic/projects/<id>/status` depending on `project.isSupportsBranches`
  // — mirror that exactly here.
  const actualBranch = initial.branch;

  let lastSeen: Types.ProjectStatusView = initial;
  let resolveTerminal: ((status: Types.ProjectStatusView) => void) | null = null;

  const handleMessage = (status: Types.ProjectStatusView): void => {
    lastSeen = status;
    if (isResolvedCompileState(status.compileState)) {
      resolveTerminal?.(status);
      resolveTerminal = null;
    } else {
      options.onProgress?.(status);
    }
  };

  let subscription: Subscription | null = null;
  try {
    subscription = await subscribeImpl({
      studioBaseUrl: client.getBaseUrl(),
      cookieHeader: `JSESSIONID=${cookie}`,
      authorizationHeader: client.getAuthorizationHeader(),
      projectId,
      branch: actualBranch,
      onMessage: handleMessage,
      signal: options.signal,
    });

    // Step 5: race-close. Status may have flipped to terminal between step 1 and the subscribe.
    const afterSubscribe = await client.getProjectStatus(projectId);
    lastSeen = afterSubscribe;
    if (isResolvedCompileState(afterSubscribe.compileState)) {
      return afterSubscribe;
    }

    // Step 6: wait for terminal via STOMP, with timeout + abort.
    return await new Promise<Types.ProjectStatusView>((resolve, reject) => {
      resolveTerminal = resolve;

      // Forward-declared so the timeout callback (which runs after the
      // synchronous setup completes) can reference it for symmetric cleanup
      // with the wrapper / terminal-frame paths.
      let abortHandler: (() => void) | null = null;

      const timer = setTimeout(() => {
        resolveTerminal = null;
        // Mirror the wrapper's cleanup: detach our listener from the caller's
        // AbortSignal so it isn't kept alive for the lifetime of the caller's
        // controller. (`once: true` would self-remove on fire, but the signal
        // never aborts in the happy-timeout path.)
        if (abortHandler) {
          options.signal?.removeEventListener("abort", abortHandler);
        }
        resolve(lastSeen);
      }, timeoutMs);
      // Don't keep the Node event loop alive just because of this timer.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }

      abortHandler = (): void => {
        clearTimeout(timer);
        resolveTerminal = null;
        reject(abortError());
      };
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      // When the inner resolve fires (terminal), clear the timer and abort listener.
      const originalResolve = resolveTerminal;
      resolveTerminal = (status) => {
        clearTimeout(timer);
        if (abortHandler) {
          options.signal?.removeEventListener("abort", abortHandler);
        }
        originalResolve?.(status);
      };
    });
  } finally {
    if (subscription) {
      await subscription.close().catch(() => { /* best-effort teardown */ });
    }
  }
}

function abortError(): Error {
  // Match the conventional AbortError shape so callers can `if (err.name === 'AbortError')`.
  const err = new Error("waitForCompilation aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Silently switch the project to `targetBranch`. Mirrors the dispatch logic in
 * the `openl_open_project` handler — uses `switchBranch` (PATCH without status)
 * when the project is already opened, and falls back to `openProject` (PATCH
 * with status: OPENED) when it is closed. A single extra `getProject` call is
 * the cost of avoiding 409 Conflicts.
 */
async function switchToBranch(
  client: OpenLClient,
  projectId: string,
  targetBranch: string
): Promise<void> {
  const project = await client.getProject(projectId);
  if (project.status === "OPENED" || project.status === "EDITING") {
    await client.switchBranch(projectId, targetBranch);
  } else {
    await client.openProject(projectId, { branch: targetBranch });
  }
}
