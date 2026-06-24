/**
 * Shared core for the OpenL tool handlers.
 *
 * Holds the tool registry (the `registerTool` / `getAllTools` / `executeTool`
 * trio and the `ToolDefinition` shape) plus the cross-cutting error handling
 * that every tool shares. The per-category handler modules in this directory
 * import from here and never the other way around, so this file has no
 * dependency on any handler module and the registry lives in exactly one place.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { OpenLClient } from "../client.js";
import type { ToolCategory } from "../constants.js";
import { logger } from "../logger.js";
import { isAxiosError, sanitizeError, extractApiErrorInfo, sanitizeJson } from "../utils.js";

/**
 * Tool response structure
 */
export interface ToolResponse {
  content: Array<{ type: string; text: string }>;
}

/**
 * Per-request context the MCP SDK passes to request handlers. Carries the optional
 * `progressToken` (under `_meta`), a `sendNotification` callback bound to the calling
 * session's transport, and an `AbortSignal` that fires when the client cancels.
 */
export type ToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Tool handler function type
 */
type ToolHandler = (
  args: unknown,
  client: OpenLClient,
  extra?: ToolHandlerExtra,
) => Promise<ToolResponse>;

/**
 * Tool definition with MCP metadata
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Display category for CLI `--help` grouping. */
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  version: string; // Semantic version (e.g., "2.0.0")
  annotations?: {
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
  };
  /**
   * Optional pre-handler validation/coercion of the raw arguments. Returns the
   * (possibly coerced) arguments to forward to the handler, or throws an
   * McpError(InvalidParams) on a schema violation. Tools without it receive
   * their arguments unchanged. Used by the structured-payload table tools.
   */
  validateArgs?: (args: unknown) => unknown;
  handler: ToolHandler;
}

/**
 * Registry of all tool handlers
 */
const toolHandlers = new Map<string, ToolDefinition>();

/**
 * Register a single tool with the registry
 *
 * @param tool - Tool definition with handler
 */
export function registerTool(tool: ToolDefinition): void {
  toolHandlers.set(tool.name, tool);
}

/**
 * Get all registered tools (for ListTools handler)
 *
 * @returns Array of tool definitions without the handler or validation callbacks
 */
export function getAllTools(): Array<Omit<ToolDefinition, "handler" | "validateArgs">> {
  return Array.from(toolHandlers.values()).map(
    ({ handler: _handler, validateArgs: _validateArgs, ...tool }) => tool,
  );
}

/**
 * Execute a tool by name
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @param client - OpenL client instance
 * @returns Tool execution result
 */
export async function executeTool(
  name: string,
  args: unknown,
  client: OpenLClient,
  extra?: ToolHandlerExtra,
): Promise<ToolResponse> {
  const tool = toolHandlers.get(name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  try {
    const callArgs = tool.validateArgs ? tool.validateArgs(args) : args;
    return await tool.handler(callArgs, client, extra);
  } catch (error: unknown) {
    throw handleToolError(error, name, args);
  }
}

/**
 * Guidance attached wherever a stale table id may be involved. Studio table ids
 * are derived from the table's content/position, so every successful edit gives
 * the edited table a NEW id and silently invalidates the old one. Without this
 * hint an agent reads the resulting 404 as "the edit was rolled back" and gives
 * up (EPBDS-16086) — the edit is in fact applied.
 */
export const STALE_TABLE_ID_HINT =
  "Table ids are derived from the table's location and change when an edit relocates the table " +
  "(it had no room to grow in place), so an id obtained before such an edit becomes stale while the " +
  "edit itself remains applied (a 404 here does NOT mean the edit was rolled back). Use the 'tableId' " +
  "returned by the last openl_update_table/openl_append_table response, or refresh ids with openl_list_tables().";

/**
 * Rethrow an HTTP 409 (conflict) from a mutating call as a clear, actionable
 * McpError; rethrow anything else unchanged so it reaches {@link handleToolError}.
 *
 * The default status→ErrorCode mapping turns 409 into InternalError, which reads
 * to the model as a server fault rather than a recoverable "name already taken".
 * Create/clone use this to tell the model exactly how to recover.
 *
 * @returns never — always throws.
 */
export function rethrowConflictAsActionable(error: unknown, conflictMessage: string): never {
  if (isAxiosError(error) && error.response?.status === 409) {
    throw new McpError(ErrorCode.InvalidRequest, conflictMessage);
  }
  throw error;
}

function handleToolError(error: unknown, toolName: string, toolArgs?: unknown): McpError {
  // Enhanced error handling with context
  if (isAxiosError(error)) {
    const status = error.response?.status;
    const responseData = error.response?.data;
    const endpoint = error.config?.url;
    const method = error.config?.method ? error.config.method.toUpperCase() : undefined;
    const requestParams = error.config?.params; // Query parameters for GET requests
    const requestData = error.config?.data; // Request body for POST/PUT requests
    const axiosCode = error.code; // e.g. ECONNREFUSED, ETIMEDOUT, ENOTFOUND (network errors when no response)

    // Extract structured error information from API response
    const apiErrorInfo = extractApiErrorInfo(responseData, status);

    // Build error message with priority:
    // 1. API error message (if available)
    // 2. Field errors (for 400)
    // 3. Generic errors array (for 400)
    // 4. For network errors (no response): use code + message so we don't get just "Error"
    // 5. Fallback to sanitized axios error message
    let errorMessage = "";
    const errorDetails: Record<string, unknown> = {
      status,
      endpoint,
      method,
      tool: toolName,
    };
    if (axiosCode) {
      errorDetails.code = axiosCode;
    }

    // Add tool arguments (sanitized to prevent sensitive data exposure)
    if (toolArgs !== undefined) {
      errorDetails.toolArgs = sanitizeJson(toolArgs);
    }

    // Add request parameters (query params for GET requests)
    if (requestParams !== undefined && Object.keys(requestParams).length > 0) {
      errorDetails.requestParams = sanitizeJson(requestParams);
    }

    // Add request data (body for POST/PUT requests, sanitized)
    if (requestData !== undefined) {
      // Try to parse JSON if it's a string
      let parsedData = requestData;
      if (typeof requestData === "string") {
        try {
          parsedData = JSON.parse(requestData);
        } catch {
          // If parsing fails, use original string (will be sanitized as string)
          parsedData = requestData;
        }
      }
      errorDetails.requestData = sanitizeJson(parsedData);
    }

    // Add structured error information to details
    if (apiErrorInfo.code) {
      errorDetails.apiErrorCode = apiErrorInfo.code;
    }
    if (apiErrorInfo.message) {
      errorMessage = apiErrorInfo.message;
    }
    if (apiErrorInfo.errors && apiErrorInfo.errors.length > 0) {
      errorDetails.errors = apiErrorInfo.errors;
      if (!errorMessage && apiErrorInfo.errors[0]?.message) {
        errorMessage = apiErrorInfo.errors[0].message;
      }
    }
    if (apiErrorInfo.fields && apiErrorInfo.fields.length > 0) {
      errorDetails.fields = apiErrorInfo.fields;
      // Build field error message if no main message
      if (!errorMessage && apiErrorInfo.fields.length > 0) {
        const fieldMessages = apiErrorInfo.fields
          .map((f) => f.field && f.message ? `${f.field}: ${f.message}` : f.message)
          .filter(Boolean);
        if (fieldMessages.length > 0) {
          errorMessage = fieldMessages.join("; ");
        }
      }
    }
    if (apiErrorInfo.rawResponse && !apiErrorInfo.code && !apiErrorInfo.message) {
      // Unknown format - include raw response in details
      errorDetails.rawResponse = apiErrorInfo.rawResponse;
    }

    // Fallback to sanitized axios error message if no API message
    if (!errorMessage) {
      const sanitized = sanitizeError(error);
      // For network errors (axiosCode set, no response), always include code so the cause is visible
      errorMessage = axiosCode ? `${axiosCode}: ${sanitized}` : sanitized;
    }

    // Build final error message
    let finalMessage = `OpenL Studio API error`;
    if (status) {
      finalMessage += ` (${status})`;
    }
    finalMessage += `: ${errorMessage}`;
    if (method && endpoint) {
      finalMessage += ` [${method} ${endpoint}]`;
    }

    // EPBDS-16086: a bare "The table is not found" after an edit reads as a
    // rollback. Explain that table ids go stale on every edit and how to recover.
    if (status === 404 && typeof endpoint === "string" && /\/tables\/[^/?]+/.test(endpoint)) {
      finalMessage += ` Hint: ${STALE_TABLE_ID_HINT}`;
    }

    // Log one-line summary first (status or network code + message) so it's visible at a glance in VS Code/Copilot output
    const summary =
      status != null
        ? `${toolName} (${status}) ${errorMessage}`
        : axiosCode
          ? `${toolName} [${axiosCode}] ${errorMessage}`
          : `${toolName} ${errorMessage}`;
    logger.error(`Tool error: ${summary}`, errorDetails);

    // Use appropriate error code based on status
    let errorCode = ErrorCode.InternalError;
    if (status === 400) {
      errorCode = ErrorCode.InvalidParams;
    } else if (status === 401 || status === 403) {
      errorCode = ErrorCode.InvalidRequest; // MCP doesn't have specific auth error code
    } else if (status === 404) {
      errorCode = ErrorCode.InvalidParams;
    } else if (status === 405) {
      errorCode = ErrorCode.MethodNotFound;
    }

    throw new McpError(
      errorCode,
      finalMessage,
      errorDetails
    );
  }

  // Re-throw McpErrors as-is
  if (error instanceof McpError) {
    throw error;
  }

  // Wrap other errors with sanitization
  const sanitizedMessage = sanitizeError(error);
  const errorDetails: Record<string, unknown> = {
    tool: toolName,
    error: sanitizedMessage,
  };

  // Add tool arguments (sanitized to prevent sensitive data exposure)
  if (toolArgs !== undefined) {
    errorDetails.toolArgs = sanitizeJson(toolArgs);
  }

  logger.error(`Tool error: ${toolName} ${sanitizedMessage}`, errorDetails);

  throw new McpError(
    ErrorCode.InternalError,
    `Error executing ${toolName}: ${sanitizedMessage}`,
    errorDetails
  );
}
