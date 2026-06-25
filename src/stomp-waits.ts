/**
 * Wait for the studio's asynchronous work to finish — over the STOMP WebSocket,
 * inside a single tool call, instead of polling.
 *
 * Two flavours share one shape (subscribe → close the no-replay race over HTTP →
 * await a terminal frame, bounded by timeout + abort, always unsubscribe):
 *
 *  - {@link waitForCompilation} — blocks on the project-status topic until the
 *    compile state is terminal. The STOMP frames ARE the value; on timeout it
 *    returns the last-seen snapshot.
 *  - {@link executeTraceReadWithWait} — runs a trace read that 409s while the
 *    trace runs, then blocks on the trace-status topic for the completion event
 *    and re-reads. The STOMP frame only signals "done"; on timeout it throws.
 *
 * The fiddly part both flows duplicated — a bounded, abortable, self-cleaning
 * wait for a single out-of-band value — lives in {@link awaitTerminal}. The
 * domain-specific orchestration (HTTP seed + branch switch for compile; optimistic
 * read + 409 detection + re-read for trace) stays in each function.
 *
 * See docs/development/websockets.md for why WebSockets are used at all.
 */

import {
  subscribeProjectStatus,
  subscribeTopic,
  buildTraceStatusDestination,
  Subscription,
} from "./stomp-client.js";
import { OpenLClient } from "./client.js";
import { isAxiosError } from "./utils.js";
import type * as Types from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

// =============================================================================
// Shared wait primitive
// =============================================================================

/**
 * Internal sentinel: the bounded terminal wait elapsed. Callers map it to a
 * domain outcome (compile → return the last snapshot; trace → throw a
 * {@link TraceWaitTimeoutError}). Never escapes this module.
 */
class TerminalWaitTimeout extends Error {
  constructor() {
    super("terminal wait timed out");
    this.name = "TerminalWaitTimeout";
  }
}

/** Conventional AbortError shape so callers can `if (err.name === 'AbortError')`. */
function makeAbortError(operation: string): Error {
  const err = new Error(`${operation} aborted`);
  err.name = "AbortError";
  return err;
}

/**
 * Warn when a wait subscribes without credentials. The WS upgrade is
 * authenticated by the Authorization header (the session cookie alone is
 * rejected for user-routed `/user/topic/...` destinations), so an anonymous
 * subscription connects but never receives frames — surface that rather than
 * silently hang until the timeout.
 */
function warnIfUnauthenticated(
  authorizationHeader: string | undefined,
  topicName: string,
  missedThing: string,
): void {
  if (authorizationHeader) {
    return;
  }
  console.error(
    `[wait] ⚠️  Subscribing to the ${topicName} WebSocket without credentials; ` +
      `the studio rejects anonymous subscriptions to user-routed topics, so ${missedThing} ` +
      `may never arrive. Provide authentication to enable wait mode.`,
  );
}

/**
 * Await a single terminal value delivered out-of-band by a STOMP frame handler,
 * with a bounded timeout and abort support. Centralises the timer (unref'd so it
 * never keeps the event loop alive), abort wiring, and listener/timer cleanup on
 * every exit path — the error-prone bit both waits previously duplicated.
 *
 * `register` is invoked synchronously with the resolver the frame handler should
 * call once a terminal value arrives (typically stored in a `let` the handler
 * closes over). Create this only when you actually need to block: callers do the
 * HTTP race-close check first and skip the wait — and its timer — when already
 * resolved.
 *
 * Rejects with {@link TerminalWaitTimeout} on timeout and an AbortError on abort.
 */
function awaitTerminal<T>(opts: {
  timeoutMs: number;
  signal?: AbortSignal;
  abortOperation: string;
  register: (resolve: (value: T) => void) => void;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abortHandler: (() => void) | null = null;

    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      if (abortHandler) {
        opts.signal?.removeEventListener("abort", abortHandler);
      }
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new TerminalWaitTimeout()));
    }, opts.timeoutMs);
    // Don't keep the Node event loop alive just because of this timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }

    abortHandler = (): void => {
      settle(() => reject(makeAbortError(opts.abortOperation)));
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    opts.register((value) => settle(() => resolve(value)));
  });
}

// =============================================================================
// Compilation wait (openl_project_status wait:true)
// =============================================================================

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
export async function waitForCompilation(
  client: OpenLClient,
  projectId: string,
  requestedBranch: string | undefined,
  options: WaitForCompilationOptions = {},
  // Allow tests to inject a fake STOMP implementation.
  subscribeImpl: SubscribeFn = subscribeProjectStatus,
): Promise<Types.ProjectStatusView> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.signal?.aborted) {
    throw makeAbortError("waitForCompilation");
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

  warnIfUnauthenticated(client.getAuthorizationHeader(), "project-status", "live status updates");

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

    // Step 6: wait for terminal via STOMP, with timeout + abort. On timeout
    // return the last-seen snapshot rather than erroring.
    try {
      return await awaitTerminal<Types.ProjectStatusView>({
        timeoutMs,
        signal: options.signal,
        abortOperation: "waitForCompilation",
        register: (resolve) => { resolveTerminal = resolve; },
      });
    } catch (err) {
      if (err instanceof TerminalWaitTimeout) {
        return lastSeen;
      }
      throw err;
    }
  } finally {
    if (subscription) {
      await subscription.close().catch(() => { /* best-effort teardown */ });
    }
  }
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
  targetBranch: string,
): Promise<void> {
  const project = await client.getProject(projectId);
  if (project.status === "OPENED" || project.status === "EDITING") {
    await client.switchBranch(projectId, targetBranch);
  } else {
    await client.openProject(projectId, { branch: targetBranch });
  }
}

// =============================================================================
// Trace wait (openl_get_trace_nodes / openl_export_trace, EPBDS-16089)
// =============================================================================

export const MAX_TRACE_WAIT_TIMEOUT_MS = 600_000;

/** Trace lifecycle states published by the studio (`ExecutionStatus`). */
const TERMINAL_TRACE_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "INTERRUPTED",
]);

/** A parsed frame from the trace-status topic. */
export interface TraceStatusFrame {
  status: string;
  message?: string;
}

/**
 * The trace is still running and the websocket wait could not be performed.
 * `reason` is human-readable; the original 409 stays available via `cause`.
 */
export class TraceWaitUnavailableError extends Error {
  constructor(reason: string, public readonly cause?: unknown) {
    super(reason);
    this.name = "TraceWaitUnavailableError";
  }
}

/** The bounded wait elapsed while the trace was still running server-side. */
export class TraceWaitTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`Trace is still running after waiting ${Math.round(waitedMs / 1000)}s.`);
    this.name = "TraceWaitTimeoutError";
  }
}

/** The studio reported the trace execution itself failed (ERROR frame). */
export class TraceExecutionFailedError extends Error {
  constructor(message: string | undefined) {
    super(message || "Trace execution failed.");
    this.name = "TraceExecutionFailedError";
  }
}

export interface WaitForTraceOptions {
  /** Called for every non-terminal lifecycle frame (`PENDING`, `STARTED`). Use it to emit MCP progress notifications. */
  onProgress?: (status: string) => void;
  /** When aborted, the call rejects with `AbortError` and the STOMP subscription is torn down. */
  signal?: AbortSignal;
  /** Hard cap on wait time. Default 120000 ms, capped at {@link MAX_TRACE_WAIT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Test seam: lets unit tests inject a fake STOMP subscriber without touching the network. */
export type SubscribeTopicFn = typeof subscribeTopic;

/**
 * Parse a trace-status frame body. Terminal/progress states arrive as a plain
 * string (`COMPLETED`); errors arrive as JSON (`{"status":"ERROR","message":…}`).
 * Mirrors the studio UI's `useTraceProgress` hook: try JSON first, fall back
 * to the raw string.
 */
export function parseTraceStatusFrame(body: string): TraceStatusFrame {
  const trimmed = body.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return { status: parsed };
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as { status?: unknown }).status === "string") {
      const message = (parsed as { message?: unknown }).message;
      return {
        status: (parsed as { status: string }).status,
        message: typeof message === "string" ? message : undefined,
      };
    }
  } catch {
    // Not JSON — plain ExecutionStatus name.
  }
  return { status: trimmed };
}

function is409(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 409;
}

/**
 * Execute `read`, waiting out the trace's 409 window via the studio websocket
 * instead of surfacing 409 Conflict to the caller (EPBDS-16089).
 *
 * While a trace is running, every trace read (`GET /projects/{id}/trace/nodes`,
 * `/trace/export`, …) returns 409 Conflict. An LLM agent cannot sleep between
 * calls, so each immediate client-side retry burns one of its limited reasoning
 * steps — a cold project compile takes tens of seconds, enough to exhaust an
 * agent's whole budget. The studio publishes the trace lifecycle on a per-user
 * STOMP topic (`ProjectSocketNotificationService`):
 *
 *   /user/topic/projects/{id}/tables/{tableId}/trace/status
 *
 * with frames `PENDING` → `STARTED` → `COMPLETED` | `INTERRUPTED` (plain
 * `ExecutionStatus` names) or `{"status":"ERROR","message":...}` on failure.
 * The wait happens INSIDE the tool call, the same way {@link waitForCompilation}
 * waits on the project-status topic:
 *
 *   1. Try the read. Success → done; non-409 error → rethrow.
 *   2. 409 → subscribe to the trace-status topic (requires the studio session
 *      cookie — the trace result registry is session-scoped — plus the
 *      Authorization header for the user-routed destination).
 *   3. Re-try the read once — closes the race where the trace completed
 *      between steps 1 and 2 (STOMP delivers transitions only, no replay).
 *   4. Wait for a terminal frame (or timeout / abort), then read again.
 *   5. Always unsubscribe in `finally`.
 *
 * Returns the read's result. Throws:
 *  - whatever `read` throws for non-409 failures,
 *  - {@link TraceWaitUnavailableError} when a 409 was hit but the websocket
 *    wait cannot be established (no session cookie),
 *  - {@link TraceExecutionFailedError} when the studio publishes an ERROR frame,
 *  - {@link TraceWaitTimeoutError} when the bounded wait elapses,
 *  - `AbortError` when `options.signal` aborts.
 */
export async function executeTraceReadWithWait<T>(
  client: OpenLClient,
  projectId: string,
  tableId: string,
  read: () => Promise<T>,
  options: WaitForTraceOptions = {},
  // Allow tests to inject a fake STOMP implementation.
  subscribeImpl: SubscribeTopicFn = subscribeTopic,
): Promise<T> {
  if (options.signal?.aborted) {
    throw makeAbortError("waitForTrace");
  }

  // Step 1: optimistic read — the trace may already be done.
  let initial409: unknown;
  try {
    return await read();
  } catch (error) {
    if (!is409(error)) {
      throw error;
    }
    initial409 = error;
  }

  const timeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TRACE_WAIT_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  // The trace result registry is session-scoped server-side, so the 409 we just
  // received proves the session exists; without its cookie the WS handshake
  // would land in a DIFFERENT session and the wait could never succeed.
  const cookie = client.getSessionCookie();
  if (!cookie) {
    throw new TraceWaitUnavailableError(
      "the studio did not issue a session cookie, so the trace-status websocket cannot be joined",
      initial409,
    );
  }

  warnIfUnauthenticated(client.getAuthorizationHeader(), "trace-status", "the completion event");

  let terminalResolve: ((frame: TraceStatusFrame) => void) | null = null;
  const handleFrame = (body: string): void => {
    const frame = parseTraceStatusFrame(body);
    if (frame.status === "ERROR" || TERMINAL_TRACE_STATUSES.has(frame.status)) {
      terminalResolve?.(frame);
      terminalResolve = null;
    } else {
      options.onProgress?.(frame.status);
    }
  };

  let subscription: Subscription | null = null;
  try {
    subscription = await subscribeImpl({
      studioBaseUrl: client.getBaseUrl(),
      cookieHeader: `JSESSIONID=${cookie}`,
      authorizationHeader: client.getAuthorizationHeader(),
      destination: buildTraceStatusDestination(projectId, tableId),
      onFrame: handleFrame,
      signal: options.signal,
    });

    // Step 3: race-close. The trace may have completed between the 409 and the
    // SUBSCRIBE — the topic has no replay, so re-check over HTTP once.
    try {
      return await read();
    } catch (error) {
      if (!is409(error)) {
        throw error;
      }
    }

    // Step 4: wait for a terminal frame, bounded by timeout and abort.
    let terminal: TraceStatusFrame;
    try {
      terminal = await awaitTerminal<TraceStatusFrame>({
        timeoutMs,
        signal: options.signal,
        abortOperation: "waitForTrace",
        register: (resolve) => { terminalResolve = resolve; },
      });
    } catch (err) {
      if (err instanceof TerminalWaitTimeout) {
        throw new TraceWaitTimeoutError(Date.now() - startedAt);
      }
      throw err;
    }

    if (terminal.status === "ERROR") {
      throw new TraceExecutionFailedError(terminal.message);
    }

    // Step 5: terminal frame seen (COMPLETED / INTERRUPTED) — the registry's
    // future is done, so the read no longer 409s.
    return await read();
  } finally {
    if (subscription) {
      await subscription.close().catch(() => { /* best-effort teardown */ });
    }
  }
}
