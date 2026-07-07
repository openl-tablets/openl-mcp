/**
 * Trace tool handlers (BETA — interactive Trace Debug API) — drive a real
 * suspended execution: start a session, step into/over/out, run to a
 * breakpoint, inspect a frame's variables, manage breakpoints, expand lazy
 * values, and terminate.
 *
 * The debug session is server-side and bound to the HTTP session — the shared
 * OpenLClient carries the JSESSIONID cookie across calls, so the whole flow
 * must go through one server/CLI process (or a CLI --cookie-jar). Only
 * `/resume` is asynchronous (202): openl_resume_trace polls the status
 * endpoint inside the tool call and returns the stack of the next stop, so
 * the agent never has to poll.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import { formatResponse } from "../formatters.js";
import { validateResponseFormat } from "../validators.js";
import { isAxiosError } from "../utils.js";
import { registerTool, type ToolResponse, type ToolHandlerExtra } from "./common.js";
import type { OpenLClient } from "../client.js";
import type * as Types from "../types.js";

/** How often openl_resume_trace polls GET /status while the worker runs. */
const RESUME_POLL_INTERVAL_MS = 250;
/** Default bound on the openl_resume_trace wait (the backend's own step wait is ~30s). */
const DEFAULT_RESUME_TIMEOUT_MS = 30_000;

/**
 * Default `?fields=` projection for openl_inspect_trace_frame: everything the agent
 * needs to reason (decision outcome, rule names, parameter/step/result values,
 * errors, grid axis names) minus the bulk — value JSON schemas and profiling
 * sub-trees. `full: true` lifts the trim.
 */
const INSPECT_FIELDS =
  "decision,ruleNames,errors,gridColumns,gridRows," +
  "result(name,description,value)," +
  "steps(ref,label,status,value(name,value))," +
  "parameters(name,description,lazy,parameterId,value)," +
  "context(name,description,lazy,parameterId,value)";

function is404(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}

function is409(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 409;
}

/** Abortable sleep for the resume poll loop. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  const err = new Error("resume_trace aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Rethrow the trace API's two signature failures as actionable McpErrors:
 * 404 = no active debug session (or it was reaped / lives in another HTTP
 * session), or the referenced frame/parameter does not exist in it;
 * 409 = the session is not suspended. Anything else passes through to the
 * shared error handler.
 */
function rethrowTraceStateError(error: unknown, action: string): never {
  if (is404(error)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `The ${action} found no target: either there is no active debug session (sessions are per HTTP session, reaped after ~10 minutes idle, ` +
        `and one started by another process is not visible here — start one with openl_start_trace), or the referenced frame index / parameter id ` +
        `does not exist in the current session (lazy parameter ids are registered when openl_inspect_trace_frame freezes a frame, and cleared on restart).`,
    );
  }
  if (is409(error)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `The debug session is not suspended, so ${action} is not possible right now. ` +
        `While running, wait for the stop with openl_resume_trace; on a terminal status (completed/error/terminated) ` +
        `the final state is in the last returned stack — restart with openl_start_trace or finish with openl_stop_trace.`,
    );
  }
  throw error;
}

/**
 * Poll the session status until it leaves running/pending, then read and
 * return the stack. Bounded by `timeoutMs`; on expiry returns null so the
 * caller reports the still-running status instead of failing.
 */
async function waitForStop(
  client: OpenLClient,
  projectId: string,
  timeoutMs: number,
  extra?: ToolHandlerExtra,
): Promise<Types.DebugStackView | null> {
  const startedAt = Date.now();
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;

  for (;;) {
    const { status } = await client.getTraceStatus(projectId);
    if (status !== "running" && status !== "pending") {
      return client.getTraceStack(projectId);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return null;
    }
    if (progressToken !== undefined && sendNotification) {
      // Notification failures are non-fatal — the wait resolves on the status flip.
      void sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: Math.round((Date.now() - startedAt) / 1000),
          message: `Trace ${status} — waiting for the next stop…`,
        },
      }).catch(() => { /* ignore */ });
    }
    await delay(RESUME_POLL_INTERVAL_MS, extra?.signal);
  }
}

export function registerTraceHandlers(): void {
  registerTool({
    name: "start_trace",
    category: "Trace",
    title: "Start Debug Session",
    description:
      "Start an interactive debug session for a table and run to the first stop. Returns the execution stack (status + frames root→current). " +
      "Default stopAtEntry: true suspends at the entry of the first frame; from there use openl_step_trace / openl_resume_trace and openl_inspect_trace_frame. " +
      "For test tables pass testRanges (e.g. '2'); for regular rules pass inputJson { params, runtimeContext? }; omitting both replays the previous run's remembered input. " +
      "Cheapest way to understand a whole run: profiling: true with stopAtEntry: false and no breakpoints — completes in this one call and returns 'tree', the executed call tree with per-step timings (structure only, no values; to see values, restart with a breakpoint on the suspicious table). " +
      "One active session per user — starting a new one terminates the previous. Idle sessions are reaped after ~10 minutes.",
    inputSchema: schemas.z.toJSONSchema(schemas.startTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        testRanges?: string;
        inputJson?: string | Record<string, unknown>;
        fromModule?: string;
        stopAtEntry?: boolean;
        profiling?: boolean;
        breakpoints?: string[];
        response_format?: string;
      };

      if (!typedArgs?.projectId || !typedArgs?.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      if (typedArgs.breakpoints) {
        await client.setTraceBreakpoints(typedArgs.projectId, typedArgs.breakpoints);
      }

      const stack = await client.startTrace({
        projectId: typedArgs.projectId,
        tableId: typedArgs.tableId,
        testRanges: typedArgs.testRanges,
        fromModule: typedArgs.fromModule,
        inputJson: typedArgs.inputJson,
        stopAtEntry: typedArgs.stopAtEntry,
        profiling: typedArgs.profiling,
      });

      return {
        content: [{ type: "text", text: formatResponse(stack, format) }],
      };
    },
  });

  registerTool({
    name: "step_trace",
    category: "Trace",
    title: "Step (Into / Over / Out)",
    description:
      "Step the suspended debug session once and return the new stack. type: 'into' enters the next call or sub-step; 'over' advances to the next sub-step of the current frame; " +
      "'out' runs the current frame to its own exit. A step that finishes a frame first suspends at that frame's exit — the frame is still on the stack with completed: true and its " +
      "result readable via openl_inspect_trace_frame; the next step continues in the caller. An exception suspends at the throwing frame before it propagates. Valid only while suspended.",
    inputSchema: schemas.z.toJSONSchema(schemas.stepTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        type: "into" | "over" | "out";
        response_format?: string;
      };

      if (!typedArgs?.projectId || !typedArgs?.type) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, type");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      let stack: Types.DebugStackView;
      try {
        stack = await client.traceStep(typedArgs.projectId, typedArgs.type);
      } catch (error) {
        rethrowTraceStateError(error, "step");
      }

      return {
        content: [{ type: "text", text: formatResponse(stack, format) }],
      };
    },
  });

  registerTool({
    name: "resume_trace",
    category: "Trace",
    title: "Resume to Next Stop",
    description:
      "Resume the suspended debug session and wait (inside this call — no agent-side polling) until it stops again: at the next breakpoint, at an exception, or at completion. " +
      "Returns the stack at the stop; on a terminal 'error' status it carries the structured 'error', and on 'completed' of a profiling run the executed 'tree'. " +
      "On timeout (default 30s) the still-running status is returned — call openl_resume_trace again to keep waiting (it re-attaches without re-resuming), or openl_stop_trace to give up.",
    inputSchema: schemas.z.toJSONSchema(schemas.resumeTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        timeoutMs?: number;
        response_format?: string;
      };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const timeoutMs = typedArgs.timeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;

      try {
        await client.traceResume(typedArgs.projectId);
      } catch (error) {
        // Re-attach path: a previous resume timed out and the worker is still
        // running — the 409 then only means "not suspended", so fall through
        // to the wait instead of failing.
        if (is409(error)) {
          const { status } = await client.getTraceStatus(typedArgs.projectId);
          if (status !== "running" && status !== "pending") {
            rethrowTraceStateError(error, "resume");
          }
        } else {
          rethrowTraceStateError(error, "resume");
        }
      }

      const stack = await waitForStop(client, typedArgs.projectId, timeoutMs, extra);
      if (stack === null) {
        return {
          content: [{
            type: "text",
            text:
              `Trace is still running after waiting ${Math.round(timeoutMs / 1000)}s — the rule may be computing or looping. ` +
              `Call openl_resume_trace again to keep waiting (optionally with a larger timeoutMs), or openl_stop_trace to terminate.`,
          }],
        };
      }

      return {
        content: [{ type: "text", text: formatResponse(stack, format) }],
      };
    },
  });

  registerTool({
    name: "inspect_trace_frame",
    category: "Trace",
    title: "Inspect Stack Frame",
    description:
      "Freeze and read the full state of one suspended stack frame: input parameters, runtime context, result (for a completed frame), sub-steps with computed values, and for a " +
      "decision table the killer feature — 'decision' (which rule fired and how each condition evaluated per rule) plus 'ruleNames' (all rules, for per-rule breakpoints). " +
      "Values may come lazy (lazy: true + parameterId) — expand with openl_get_trace_value. By default the response is trimmed (no value JSON schemas); full: true lifts the trim. " +
      "withHighlights: true additionally returns the A1-keyed cell highlight overlay and the raw table grid to merge it with. Valid only while suspended (a terminal session answers 409 — read its final state from the last returned stack).",
    inputSchema: schemas.z.toJSONSchema(schemas.inspectTraceFrameSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        frameIndex: number;
        withHighlights?: boolean;
        full?: boolean;
        response_format?: string;
      };

      if (!typedArgs?.projectId || typedArgs?.frameIndex == null) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, frameIndex");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      let variables: Types.DebugFrameVariables;
      try {
        variables = await client.getTraceFrameVariables(
          typedArgs.projectId,
          typedArgs.frameIndex,
          typedArgs.full ? undefined : INSPECT_FIELDS,
        );
      } catch (error) {
        rethrowTraceStateError(error, "frame inspection");
      }

      let result: unknown = variables;
      if (typedArgs.withHighlights) {
        const [highlights, stack] = await Promise.all([
          client.getTraceFrameHighlights(typedArgs.projectId, typedArgs.frameIndex),
          client.getTraceStack(typedArgs.projectId),
        ]);
        // The overlay is keyed by A1 cell address; the grid to paint it on comes
        // from the shared Tables API raw view, resolved via the frame's tableId.
        const frame = stack.frames.find((f) => f.index === typedArgs.frameIndex);
        const grid = frame
          ? await client.getTable(typedArgs.projectId, frame.tableId, true)
          : undefined;
        result = { ...variables, highlights, grid };
      }

      return {
        content: [{ type: "text", text: formatResponse(result, format) }],
      };
    },
  });

  registerTool({
    name: "set_trace_breakpoints",
    category: "Trace",
    title: "Read / Replace Breakpoints",
    description:
      "Read the active breakpoint keys and the available targets (rule tables, deduplicated by name; with an active session only tables reachable from the traced one). " +
      "When 'set' is provided it REPLACES the whole set first (empty array clears all). Key forms: '<name>' stops at entry of every same-named table version; '<uri>' at that exact table " +
      "(uri from frames[].uri); '<uri>#R{r}C{c}' at a spreadsheet cell; '<uri>#rule' when ANY rule of that decision table fires; '<uri>#<ruleName>' when a specific rule fires " +
      "(rule names from openl_inspect_trace_frame ruleNames/decision). Works without a session — set breakpoints before openl_start_trace; changes during a session apply at the next frame enter or line change.",
    inputSchema: schemas.z.toJSONSchema(schemas.setTraceBreakpointsSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        set?: string[];
        response_format?: string;
      };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      if (typedArgs.set) {
        await client.setTraceBreakpoints(typedArgs.projectId, typedArgs.set);
      }

      const [breakpoints, targets] = await Promise.all([
        client.getTraceBreakpoints(typedArgs.projectId),
        client.getTraceBreakpointTables(typedArgs.projectId),
      ]);

      return {
        content: [{ type: "text", text: formatResponse({ breakpoints, targets }, format) }],
      };
    },
  });

  registerTool({
    name: "get_trace_value",
    category: "Trace",
    title: "Expand Lazy Value",
    description:
      "Fetch the full value of a parameter that openl_inspect_trace_frame returned lazily (lazy: true with a parameterId). Valid while the debug session is alive. " +
      "By default only name, description, and value are returned; withSchema: true adds the value's JSON Schema (large — request it only when the type structure itself matters).",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceValueSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        parameterId: number;
        withSchema?: boolean;
        response_format?: string;
      };

      if (!typedArgs?.projectId || typedArgs?.parameterId == null) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, parameterId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      let param: Types.TraceParameterValue;
      try {
        param = await client.getTraceParameter(
          typedArgs.projectId,
          typedArgs.parameterId,
          typedArgs.withSchema ? undefined : "name,description,value",
        );
      } catch (error) {
        rethrowTraceStateError(error, "lazy value fetch");
      }

      return {
        content: [{ type: "text", text: formatResponse(param, format) }],
      };
    },
  });

  registerTool({
    name: "stop_trace",
    category: "Trace",
    title: "Terminate Debug Session",
    description:
      "Terminate the debug session and free its worker and lazy-value registry. Idempotent — succeeds even when no session is active. Breakpoints survive (they are session-scoped, not run-scoped).",
    inputSchema: schemas.z.toJSONSchema(schemas.stopTraceSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as { projectId: string; response_format?: string };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      await client.stopTrace(typedArgs.projectId);

      return {
        content: [{ type: "text", text: "Debug session terminated." }],
      };
    },
  });
}
