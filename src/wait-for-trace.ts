/**
 * Run a trace read, waiting for the trace to complete over the studio
 * websocket instead of surfacing 409 Conflict to the caller (EPBDS-16089).
 *
 * While a trace is running, every trace read (`GET /projects/{id}/trace/nodes`,
 * `/trace/export`, …) returns 409 Conflict. An LLM agent cannot sleep between
 * calls, so each immediate client-side retry burns one of its limited
 * reasoning steps — a cold project compile takes tens of seconds, enough to
 * exhaust an agent's whole budget. The studio publishes the trace lifecycle on
 * a per-user STOMP topic (`ProjectSocketNotificationService`):
 *
 *   /user/topic/projects/{id}/tables/{tableId}/trace/status
 *
 * with frames `PENDING` → `STARTED` → `COMPLETED` | `INTERRUPTED` (plain
 * `ExecutionStatus` names) or `{"status":"ERROR","message":...}` on failure.
 * This module does the waiting INSIDE the tool call, the same way
 * `wait-for-compilation.ts` waits on the project-status topic:
 *
 *   1. Try the read. Success → done; non-409 error → rethrow.
 *   2. 409 → subscribe to the trace-status topic (requires the studio session
 *      cookie — the trace result registry is session-scoped — plus the
 *      Authorization header for the user-routed destination).
 *   3. Re-try the read once — closes the race where the trace completed
 *      between steps 1 and 2 (STOMP delivers transitions only, no replay).
 *   4. Wait for a terminal frame (or timeout / abort), then read again.
 *   5. Always unsubscribe in `finally`.
 */

import { subscribeTopic, buildTraceStatusDestination, Subscription } from "./stomp-client.js";
import { OpenLClient } from "./client.js";
import { isAxiosError } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 120_000;
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

function abortError(): Error {
  const err = new Error("waitForTrace aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Execute `read`, waiting out the trace's 409 window via the studio websocket.
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
  subscribeImpl: SubscribeTopicFn = subscribeTopic
): Promise<T> {
  if (options.signal?.aborted) {
    throw abortError();
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

  // Same caveat as wait-for-compilation: user-routed `/user/topic/...`
  // destinations reject anonymous subscriptions, so warn when the upgrade
  // request will carry no credentials.
  const authorizationHeader = client.getAuthorizationHeader();
  if (!authorizationHeader) {
    console.error(
      "[wait] ⚠️  Subscribing to the trace-status WebSocket without credentials; " +
        "the studio rejects anonymous subscriptions to user-routed topics, so the " +
        "completion event may never arrive. Provide authentication to enable wait mode.",
    );
  }

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
      authorizationHeader,
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
    const terminal = await new Promise<TraceStatusFrame>((resolve, reject) => {
      let abortHandler: (() => void) | null = null;

      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        terminalResolve = null;
        if (abortHandler) {
          options.signal?.removeEventListener("abort", abortHandler);
        }
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new TraceWaitTimeoutError(Date.now() - startedAt)));
      }, timeoutMs);
      // Don't keep the Node event loop alive just because of this timer.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }

      abortHandler = (): void => {
        settle(() => reject(abortError()));
      };
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      terminalResolve = (frame) => {
        settle(() => resolve(frame));
      };
    });

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
