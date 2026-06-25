/**
 * Shared MCP server core
 *
 * Both transports — stdio ({@link file://./stdio-server.ts}) and Streamable HTTP
 * ({@link file://./http-server.ts}) — expose the identical MCP surface (tools
 * and prompts). This module builds a fully-configured `Server` (capabilities
 * declared, tools registered, every request handler wired), so each entry point
 * only has to attach a transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { SERVER_INFO, mcpToolName, stripToolPrefix } from "./constants.js";
import { PROMPTS, loadPromptContent, getPromptDefinition } from "./prompts-registry.js";
import { registerAllTools, getAllTools, executeTool, hasTool } from "./handlers/index.js";
import { sanitizeError } from "./utils.js";
import type { OpenLClient } from "./client.js";

/**
 * Register every MCP request handler on `server`, dispatching to `client`.
 */
export function registerMcpHandlers(server: Server, client: OpenLClient): void {
  // List available tools. The registry holds bare names; the `openl_`
  // namespace prefix is a protocol concern applied only here, on the wire.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools().map(({ name, title, description, inputSchema, annotations }) => ({
      name: mcpToolName(name),
      title,
      description,
      inputSchema,
      ...(annotations && { annotations }),
    })),
  }));

  // Handle tool execution. `extra` carries the SDK request context (progressToken,
  // per-session sendNotification, AbortSignal) that long-running tools need.
  // Strip the wire prefix back to the bare registry name before dispatching.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = stripToolPrefix(request.params.name);
    try {
      const result = await executeTool(toolName, request.params.arguments, client, extra);
      return result as any; // Type cast needed due to MCP SDK generic return type
    } catch (error) {
      // A tool's own failure (backend 4xx/5xx, argument validation) must reach the
      // calling agent as an `isError` RESULT, not a thrown JSON-RPC protocol error.
      // A throw is surfaced by clients as a generic "tool execution failed" with the
      // detail dropped; an isError result carries the message into the model's
      // context so it can self-correct (e.g. "column height 6 exceeds table height
      // 5"). executeTool already wrapped the cause into an McpError with a detailed,
      // sanitized message. Only a genuinely unknown tool stays a protocol error —
      // distinguished by the registry, NOT by the error code: a backend HTTP 405
      // also maps to ErrorCode.MethodNotFound, so a code check would wrongly re-throw
      // a real tool failure as a protocol error.
      if (!hasTool(toolName)) {
        throw error;
      }
      const message = error instanceof McpError ? error.message : sanitizeError(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  });

  // List available prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  // Get specific prompt with optional arguments
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const prompt = getPromptDefinition(name);
    if (!prompt) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Prompt not found: ${name}`
      );
    }

    try {
      const content = loadPromptContent(name, args);

      return {
        description: prompt.description,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: content,
            },
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to load prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

/**
 * Build a fully-configured MCP `Server` for one OpenL client: capabilities
 * declared, tools registered, every request handler wired. The caller attaches
 * a transport.
 */
export function createConfiguredServer(client: OpenLClient): Server {
  const server = new Server(
    {
      name: SERVER_INFO.NAME,
      version: SERVER_INFO.VERSION,
      description: SERVER_INFO.DESCRIPTION,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  registerAllTools();
  registerMcpHandlers(server, client);

  return server;
}
