/**
 * Trace tool handlers (BETA — Execution Trace API) — start a trace and read its
 * nodes, node details, and parameters; cancel and export traces. Owns the
 * process-wide active-trace registry and the STOMP wait-for-trace helper.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import { formatResponse } from "../formatters.js";
import { validateResponseFormat } from "../validators.js";
import { isAxiosError } from "../utils.js";
import {
  executeTraceReadWithWait,
  TraceExecutionFailedError,
  TraceWaitTimeoutError,
  TraceWaitUnavailableError,
  MAX_TRACE_WAIT_TIMEOUT_MS,
} from "../stomp-waits.js";
import { registerTool, type ToolResponse, type ToolHandlerExtra } from "./common.js";
import type { OpenLClient } from "../client.js";

/**
 * Which table the most recent trace was started for, per project
 * (`projectId → tableId`). The studio publishes the trace lifecycle on a
 * PER-TABLE websocket topic (`/user/topic/projects/{id}/tables/{tableId}/trace/status`),
 * but the trace READ endpoints take only the projectId — so openl_start_trace
 * records the pair here and the read tools use it to subscribe while waiting
 * out the 409 window. Callers in a different process (e.g. separate CLI runs)
 * pass `tableId` explicitly instead. Bounded: oldest entries evicted first.
 * The studio itself keeps at most one trace per session, so one entry per
 * project is sufficient.
 */
const ACTIVE_TRACE_LIMIT = 500;

const activeTraceTables = new Map<string, string>();

function recordActiveTrace(projectId: string, tableId: string): void {
  activeTraceTables.delete(projectId); // re-insert to refresh eviction order
  activeTraceTables.set(projectId, tableId);
  while (activeTraceTables.size > ACTIVE_TRACE_LIMIT) {
    const oldest = activeTraceTables.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    activeTraceTables.delete(oldest);
  }
}

/**
 * Run a trace read, waiting out the "trace still running" 409 window by
 * subscribing to the studio's trace-status websocket topic (EPBDS-16089) —
 * see {@link executeTraceReadWithWait} in wait-for-trace.ts for the mechanism.
 * An LLM agent cannot sleep between calls, so the waiting happens INSIDE the
 * tool call. This wrapper supplies the tool-layer glue: resolving the tableId
 * (explicit arg, or the one recorded by openl_start_trace), MCP progress
 * notifications, and mapping the wait outcomes to actionable McpErrors.
 */
async function readTraceWithWait<T>(
  client: OpenLClient,
  read: () => Promise<T>,
  options: {
    projectId: string;
    tableId?: string;
    wait: boolean;
    timeoutMs?: number;
    toolName: string;
    extra?: ToolHandlerExtra;
  },
): Promise<T> {
  if (!options.wait) {
    return read();
  }

  const tableId = options.tableId ?? activeTraceTables.get(options.projectId);
  if (!tableId) {
    // Without the tableId there is no way to know the trace-status destination.
    // Do the plain read; if the trace is still running, say how to enable waiting.
    try {
      return await read();
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Trace is still running (409 Conflict), and the table it was started for is unknown to this server instance, ` +
            `so the studio's trace-status websocket cannot be joined to wait for completion. ` +
            `Pass 'tableId' (the same id given to openl_start_trace) to enable the server-side wait, or retry shortly.`,
        );
      }
      throw error;
    }
  }

  const progressToken = options.extra?._meta?.progressToken;
  const sendNotification = options.extra?.sendNotification;
  const startedAt = Date.now();
  const onProgress =
    progressToken !== undefined && sendNotification
      ? (status: string): void => {
          // Notification failures are non-fatal — the wait resolves on the terminal frame.
          void sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: Math.round((Date.now() - startedAt) / 1000),
              message: `Trace ${status.toLowerCase()} — waiting for completion…`,
            },
          }).catch(() => { /* ignore */ });
        }
      : undefined;

  try {
    return await executeTraceReadWithWait(client, options.projectId, tableId, read, {
      onProgress,
      signal: options.extra?.signal,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error instanceof TraceWaitTimeoutError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Trace is still running after waiting ${Math.round(error.waitedMs / 1000)}s (a cold project compile can take tens of seconds). ` +
          `The trace keeps running server-side — call ${options.toolName} again (optionally with a larger waitTimeoutMs, max ${MAX_TRACE_WAIT_TIMEOUT_MS} ms), ` +
          `or stop it with openl_cancel_trace.`,
      );
    }
    if (error instanceof TraceExecutionFailedError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Trace execution failed in the studio: ${error.message} Start a new trace with openl_start_trace.`,
      );
    }
    if (error instanceof TraceWaitUnavailableError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Trace is still running (409 Conflict), and waiting over the studio websocket is unavailable: ${error.message}. ` +
          `Retry shortly, or stop the trace with openl_cancel_trace.`,
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpError(ErrorCode.InvalidRequest, `${options.toolName}: request cancelled while waiting for the trace to complete.`);
    }
    throw error;
  }
}

export function registerTraceHandlers(): void {
  registerTool({
    name: "start_trace",
    category: "Trace",
    title: "Start Rule Trace",
    description:
      "Start trace execution for a table. Trace is asynchronous (returns 202 Accepted). For regular rules: provide inputJson with { params: {...}, runtimeContext?: {...} }. For test tables: use testRanges (e.g. '1-3,5'). After starting, call openl_get_trace_nodes once — while the trace is still running it subscribes to the studio's trace-status websocket and waits for completion server-side (no manual polling/retrying on 409 needed).",
    inputSchema: schemas.z.toJSONSchema(schemas.startTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        testRanges?: string;
        fromModule?: string;
        inputJson?: string | Record<string, unknown>;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId || !typedArgs?.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId");
      }

      await client.startTrace({
        projectId: typedArgs.projectId,
        tableId: typedArgs.tableId,
        testRanges: typedArgs.testRanges,
        fromModule: typedArgs.fromModule,
        inputJson: typedArgs.inputJson,
      });

      // The trace-status websocket topic is per-table; remember which table this
      // trace runs for so the read tools can subscribe while waiting (EPBDS-16089).
      recordActiveTrace(typedArgs.projectId, typedArgs.tableId);

      const msg =
        "Trace execution started (202 Accepted). Call openl_get_trace_nodes(projectId) once to retrieve results — " +
        "while the trace is still running it waits for completion via the studio's trace-status websocket " +
        "(default timeout 120s; tune with waitTimeoutMs). No manual polling or retrying on 409 is needed.";

      return {
        content: [{ type: "text", text: msg }],
      };
    },
  });

  registerTool({
    name: "get_trace_nodes",
    category: "Trace",
    title: "Get Trace Tree Nodes",
    description:
      "Get trace node children (or root nodes if nodeId omitted). Use openl_start_trace first. While the trace is still running the backend answers 409 Conflict; by DEFAULT this tool subscribes to the studio's trace-status websocket and waits (up to waitTimeoutMs, default 120s) until the trace completes — call it once after openl_start_trace, no manual polling needed. Pass 'tableId' (the id given to openl_start_trace) when the trace was started by a different server/CLI process; otherwise the table is remembered automatically. Set wait: false for the raw immediate-409 behavior.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceNodesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        nodeId?: number;
        showRealNumbers?: boolean;
        tableId?: string;
        wait?: boolean;
        waitTimeoutMs?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const nodes = await readTraceWithWait(
        client,
        () =>
          client.getTraceNodes(typedArgs.projectId, {
            nodeId: typedArgs.nodeId,
            showRealNumbers: typedArgs.showRealNumbers,
          }),
        {
          projectId: typedArgs.projectId,
          tableId: typedArgs.tableId,
          wait: typedArgs.wait !== false,
          timeoutMs: typedArgs.waitTimeoutMs,
          toolName: "get_trace_nodes",
          extra,
        },
      );

      const formattedResult = formatResponse(nodes, format);
      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "get_trace_node_details",
    category: "Trace",
    title: "Get Trace Node Details",
    description:
      "Get detailed trace node including parameters, context, result, and errors. Node IDs come from openl_get_trace_nodes.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceNodeDetailsSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        nodeId: number;
        showRealNumbers?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId || typedArgs?.nodeId == null) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, nodeId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const node = await client.getTraceNodeDetails(
        typedArgs.projectId,
        typedArgs.nodeId,
        typedArgs.showRealNumbers ?? false
      );

      const formattedResult = formatResponse(node, format);
      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "get_trace_parameter",
    category: "Trace",
    title: "Get Trace Parameter Value",
    description:
      "Get lazy-loaded parameter value. Use when a TraceParameterValue has lazy:true and parameterId set.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceParameterSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        parameterId: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId || typedArgs?.parameterId == null) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, parameterId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const param = await client.getTraceParameter(typedArgs.projectId, typedArgs.parameterId);

      const formattedResult = formatResponse(param, format);
      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "cancel_trace",
    category: "Trace",
    title: "Cancel Ongoing Trace",
    description: "Cancel ongoing trace execution for a project.",
    inputSchema: schemas.z.toJSONSchema(schemas.cancelTraceSchema) as Record<string, unknown>,
    annotations: { openWorldHint: true },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as { projectId: string; response_format?: "json" | "markdown" };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      await client.cancelTrace(typedArgs.projectId);

      return {
        content: [{ type: "text", text: "Trace cancelled." }],
      };
    },
  });

  registerTool({
    name: "export_trace",
    category: "Trace",
    title: "Export Trace as Text",
    description:
      "Export trace as plain text. Returns full trace content. Use release: true to clear trace from memory after export. While the trace is still running the backend answers 409 Conflict; by DEFAULT this tool subscribes to the studio's trace-status websocket and waits (up to waitTimeoutMs, default 120s) until the trace completes. Pass 'tableId' (the id given to openl_start_trace) when the trace was started by a different server/CLI process; otherwise the table is remembered automatically. Set wait: false for the raw immediate-409 behavior.",
    inputSchema: schemas.z.toJSONSchema(schemas.exportTraceSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        showRealNumbers?: boolean;
        release?: boolean;
        tableId?: string;
        wait?: boolean;
        waitTimeoutMs?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      const text = await readTraceWithWait(
        client,
        () =>
          client.exportTrace(typedArgs.projectId, {
            showRealNumbers: typedArgs.showRealNumbers,
            release: typedArgs.release,
          }),
        {
          projectId: typedArgs.projectId,
          tableId: typedArgs.tableId,
          wait: typedArgs.wait !== false,
          timeoutMs: typedArgs.waitTimeoutMs,
          toolName: "export_trace",
          extra,
        },
      );

      return {
        content: [{ type: "text", text }],
      };
    },
  });
}
