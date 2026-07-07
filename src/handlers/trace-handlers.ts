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
/** Default cap on points returned per watch series (a deep combinatorial cell fires many thousands of times). */
const DEFAULT_WATCH_MAX_POINTS = 500;
/** Reject a watch response larger than this up front, before it can OOM the parse (defense in depth). */
const WATCH_MAX_CONTENT_BYTES = 64 * 1024 * 1024;

/**
 * Default `?fields=` projection for openl_inspect_trace_frame: everything the agent
 * needs to reason (decision outcome, rule names, parameter/step/result values,
 * errors, grid axis names) minus the bulk — value JSON schemas and profiling
 * sub-trees. `full: true` lifts the trim.
 */
const INSPECT_FIELDS =
  "decision,ruleNames,errors,gridColumns,gridRows," +
  "result(name,description,value)," +
  // Keep lazy/parameterId on step values so a large factor still carries its id
  // (for openl_get_trace_value, and for excludeStepValues to resolve it).
  "steps(ref,label,status,value(name,lazy,parameterId,value))," +
  "parameters(name,description,lazy,parameterId,value)," +
  "context(name,description,lazy,parameterId,value)";

/**
 * Default `?fields=` projection for openl_watch_trace_cells: the whole series
 * minus each point value's JSON Schema (large; a lazy value still keeps its
 * parameterId so openl_get_trace_value can expand it). `withSchema` lifts it.
 */
const WATCH_FIELDS =
  "truncated,series(name,table,tableUri," +
  "points(instance,label,ref,path,value(name,description,lazy,parameterId,value)))";

function isScalar(v: unknown): v is number | string | boolean {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

/**
 * Optionally thin out a frame's `steps` so an anomaly stands out among many
 * neutral factors: `onlyExecuted` keeps only steps that actually computed a
 * value, and `excludeValues` drops steps whose scalar value equals one of the
 * caller-supplied neutral constants (e.g. 1 in rating). Returns the variables
 * unchanged when neither filter is requested.
 *
 * A step's value often arrives lazy (`lazy: true` + `parameterId`, no inline
 * value) — the key multipliers (BaseRate, VehiclePriceFactor, Group*) usually
 * do. Those are resolved (in parallel, via the parameter endpoint) BEFORE the
 * `excludeValues` comparison, so a neutral factor that came lazy is dropped too
 * rather than surviving unmatched.
 */
async function filterSteps(
  variables: Types.DebugFrameVariables,
  opts: { onlyExecuted?: boolean; excludeValues?: Array<number | string | boolean> },
  client: OpenLClient,
  projectId: string,
): Promise<Types.DebugFrameVariables> {
  const exclude = opts.excludeValues ?? [];
  if (!opts.onlyExecuted && exclude.length === 0) {
    return variables;
  }

  let steps = variables.steps ?? [];
  if (opts.onlyExecuted) {
    steps = steps.filter((step) => step.status === "executed");
  }

  if (exclude.length === 0) {
    return { ...variables, steps };
  }

  // Resolve the scalar of each step (materializing lazy values) so the compare
  // sees the real number, not an absent lazy placeholder.
  const scalars = await Promise.all(
    steps.map(async (step): Promise<unknown> => {
      const value = step.value;
      if (!value) return undefined;
      if (value.value !== undefined) return value.value;
      if (value.lazy && value.parameterId != null) {
        try {
          const resolved = await client.getTraceParameter(projectId, value.parameterId, "value");
          return resolved.value;
        } catch {
          return undefined; // couldn't resolve → keep the step (don't drop blindly)
        }
      }
      return undefined;
    }),
  );

  const kept = steps.filter((_step, i) => {
    const scalar = scalars[i];
    return !(isScalar(scalar) && exclude.some((e) => e === scalar));
  });
  return { ...variables, steps: kept };
}

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
  stackOptions?: { view?: "full" | "compact"; includeTree?: boolean; profileTop?: number },
): Promise<Types.DebugStackView | null> {
  const startedAt = Date.now();
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;

  for (;;) {
    const { status } = await client.getTraceStatus(projectId);
    if (status !== "running" && status !== "pending") {
      return client.getTraceStack(projectId, stackOptions);
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
      "Cheapest way to understand a whole run: profiling: true with stopAtEntry: false and no breakpoints — completes in this one call and returns 'profile', a constant-size overview of the top-N slowest tables (selfMillis/totalMillis/count) plus nodeCount/distinctTables/totalMillis. " +
      "Find the hot or unexpected table in profile.hotspots, then replay into it with a breakpoint to inspect live values. The full executed 'tree' is omitted by default (it can exceed the 1 MB limit); set includeTree: true only to browse a specific branch's structure. " +
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
        includeTree?: boolean;
        profileTop?: number;
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
        // Never pull the >1 MB full tree unless explicitly asked; the bounded
        // `profile` overview covers the "understand the whole run" case.
        includeTree: typedArgs.profiling ? (typedArgs.includeTree ?? false) : undefined,
        profileTop: typedArgs.profileTop,
      });

      return { content: [{ type: "text", text: formatResponse(stack, format) }] };
    },
  });

  registerTool({
    name: "step_trace",
    category: "Trace",
    title: "Step (Into / Over / Out)",
    description:
      "Step the suspended debug session once and return the new stack. For declarative rules (decision tables, spreadsheets, rating) the main move is type: 'out' — run the current frame to its own exit " +
      "so its result is inspectable — combined with breakpoints; 'into'/'over' are advanced (imperative TBasic/loops). A step that finishes a frame first suspends at that frame's exit — the frame is still on the stack " +
      "with completed: true and its result readable via openl_inspect_trace_frame (or pass withValues: true to bundle those variables into this response); the next step continues in the caller. " +
      "An exception suspends at the throwing frame before it propagates. The stack is returned compact — steps only for the active frame; use openl_inspect_trace_frame for another frame's detail. Valid only while suspended. " +
      "(openl_resume_trace differs: it runs to the next breakpoint or completion, not just to this frame's exit.)",
    inputSchema: schemas.z.toJSONSchema(schemas.stepTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        type: "into" | "over" | "out";
        withValues?: boolean;
        response_format?: string;
      };

      if (!typedArgs?.projectId || !typedArgs?.type) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, type");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      let stack: Types.DebugStackView;
      try {
        stack = await client.traceStep(typedArgs.projectId, typedArgs.type, { view: "compact" });
      } catch (error) {
        rethrowTraceStateError(error, "step");
      }

      // Bundle the active frame's variables so a `step out → inspect` cycle is
      // one call. Only meaningful while suspended with a frame on the stack.
      if (typedArgs.withValues && stack.status === "suspended" && stack.frames.length > 0) {
        const active = stack.frames.find((f) => f.active) ?? stack.frames[stack.frames.length - 1];
        const variables = await client.getTraceFrameVariables(typedArgs.projectId, active.index, INSPECT_FIELDS);
        return { content: [{ type: "text", text: formatResponse({ ...stack, variables }, format) }] };
      }

      return { content: [{ type: "text", text: formatResponse(stack, format) }] };
    },
  });

  registerTool({
    name: "resume_trace",
    category: "Trace",
    title: "Resume to Next Stop",
    description:
      "Resume the suspended debug session and wait (inside this call — no agent-side polling) until it stops again: at the next breakpoint, at an exception, or at completion. Unlike openl_step_trace(out), which only runs the current frame to its exit, resume runs to the NEXT breakpoint or the end. " +
      "Returns the stack (compact — steps for the active frame only) at the stop; on a terminal 'error' status it carries the structured 'error', and on 'completed' of a profiling run the constant-size 'profile' overview (set includeTree: true for the full 'tree'). " +
      "On timeout (default 30s) the still-running status is returned — call openl_resume_trace again to keep waiting (it re-attaches without re-resuming), or openl_stop_trace to give up.",
    inputSchema: schemas.z.toJSONSchema(schemas.resumeTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        timeoutMs?: number;
        includeTree?: boolean;
        profileTop?: number;
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

      const stack = await waitForStop(client, typedArgs.projectId, timeoutMs, extra, {
        view: "compact",
        includeTree: typedArgs.includeTree ?? false,
        profileTop: typedArgs.profileTop,
      });
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

      return { content: [{ type: "text", text: formatResponse(stack, format) }] };
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
      "To surface an anomaly among many neutral factors, filter the steps: onlyExecutedSteps drops not-yet-computed ones, and excludeStepValues drops steps whose value is a neutral constant (e.g. [1] in rating) — lazy step values are resolved before the comparison, so a neutral factor that came lazy is dropped too. " +
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
        onlyExecutedSteps?: boolean;
        excludeStepValues?: Array<number | string | boolean>;
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

      variables = await filterSteps(
        variables,
        { onlyExecuted: typedArgs.onlyExecutedSteps, excludeValues: typedArgs.excludeStepValues },
        client,
        typedArgs.projectId,
      );

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
      "(rule names from openl_inspect_trace_frame ruleNames/decision). Append '@N' to any key to break only on the table's N-th execution (0-based) — e.g. '<uri>#R48C0@3'; without it a cell breakpoint hits every pass of a table that runs many times (one per coverage/iteration). N matches frames[].instance and the 'instance' of an openl_watch_trace_cells series, so a watch outlier at instance 3 is reached with '@3'. " +
      "Works without a session — set breakpoints before openl_start_trace; changes during a session apply at the next frame enter or line change.",
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

  registerTool({
    name: "watch_trace_cells",
    category: "Trace",
    title: "Watch Cells Across a Run",
    description:
      "Answer 'show me this factor across all coverages/iterations' in one call, without dumping frames. Watches the named cells (e.g. ['$VehiclePriceFactor']), runs the table to completion, and returns a WatchView: " +
      "one 'series' per cell with a 'points' array holding the cell's value at every execution of its table (each point carries instance/label/ref/path; value is serialized like any traced value and may come lazy — expand a large one with openl_get_trace_value using its parameterId). " +
      "Read the series, spot the outlier (e.g. 83.372 among 1.0s), then jump straight to that pass: set a breakpoint '<point.ref>@<point.instance>' (the '@N' suffix targets the N-th execution — same 0-based numbering as the series' 'instance') and replay + openl_inspect_trace_frame to see why. Value JSON Schemas are omitted by default (withSchema: true restores them). " +
      "Captures cells inside lazy result branches too (nested SpreadsheetResult[]) — the run materializes the whole result. A cell deep in a combinatorial branch (benefit × gender × age-band …) can fire thousands of times; each series is capped at maxPoints (default 500) points, and a truncated series reports its totalPoints. Pass testRanges for a test table or inputJson for a regular rule (omit both to replay the remembered input). This starts a fresh session (terminates any previous one).",
    inputSchema: schemas.z.toJSONSchema(schemas.watchTraceCellsSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        cells: string[];
        testRanges?: string;
        inputJson?: string | Record<string, unknown>;
        fromModule?: string;
        withSchema?: boolean;
        maxPoints?: number;
        response_format?: string;
      };

      if (!typedArgs?.projectId || !typedArgs?.tableId || !typedArgs?.cells?.length) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId, cells");
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const maxPoints = typedArgs.maxPoints ?? DEFAULT_WATCH_MAX_POINTS;

      // Set the watch cells, run the whole table to completion, then read the
      // collected series. The run fully materializes the traced method's result,
      // so cells inside lazy result branches (nested SpreadsheetResult[]) are
      // evaluated and captured — no profiling needed (profiling would only make
      // the studio build and retain a large call tree this tool discards).
      await client.setTraceWatches(typedArgs.projectId, typedArgs.cells);
      await client.startTrace({
        projectId: typedArgs.projectId,
        tableId: typedArgs.tableId,
        testRanges: typedArgs.testRanges,
        fromModule: typedArgs.fromModule,
        inputJson: typedArgs.inputJson,
        stopAtEntry: false,
      });

      let watch: Types.WatchView;
      try {
        watch = await client.getTraceWatch(
          typedArgs.projectId,
          typedArgs.withSchema ? undefined : WATCH_FIELDS,
          WATCH_MAX_CONTENT_BYTES,
        );
      } catch (error) {
        // axios flags an over-limit body as ERR_BAD_RESPONSE with a
        // "maxContentLength size of N exceeded" message.
        if (isAxiosError(error) && typeof error.message === "string" && error.message.includes("maxContentLength")) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `The watch collected more data than can be returned safely (a watched cell in a combinatorial branch can fire hundreds of thousands of times). ` +
              `Watch a higher-level cell, narrow the input, or target one pass with a '<ref>@N' breakpoint + openl_inspect_trace_frame.`,
          );
        }
        rethrowTraceStateError(error, "watch read");
      }

      // Cap points PER SERIES before serializing — a deep combinatorial cell can
      // produce tens of thousands of points, and stringifying all of them can
      // exceed V8's max string size and crash the process.
      let truncatedSeries = 0;
      const series = (watch.series ?? []).map((s) => {
        const points = s.points ?? [];
        if (points.length > maxPoints) {
          truncatedSeries += 1;
          return { ...s, totalPoints: points.length, pointsTruncated: true, points: points.slice(0, maxPoints) };
        }
        return s;
      });
      const payload: Record<string, unknown> = { ...watch, series };
      if (truncatedSeries > 0) {
        payload.note =
          `${truncatedSeries} series exceeded maxPoints=${maxPoints} and were cut to the first ${maxPoints} points ` +
          `(each such series reports its totalPoints). A cell deep in a combinatorial branch executes thousands of times — ` +
          `raise maxPoints, watch a higher-level cell, or target one pass with a '<ref>@N' breakpoint.`;
      }

      return {
        content: [{ type: "text", text: formatResponse(payload, format) }],
      };
    },
  });
}
