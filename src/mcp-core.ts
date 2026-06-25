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
import { registerAllTools, getAllTools, executeTool } from "./handlers/index.js";
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
    const result = await executeTool(stripToolPrefix(request.params.name), request.params.arguments, client, extra);
    return result as any; // Type cast needed due to MCP SDK generic return type
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
