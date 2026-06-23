/**
 * Shared MCP server core
 *
 * Both transports — stdio ({@link file://./index.ts}) and Streamable HTTP
 * ({@link file://./server.ts}) — expose the identical MCP surface (tools,
 * resources, resource templates, completion, subscriptions, prompts). This
 * module builds a fully-configured `Server` (capabilities declared, tools
 * registered, every request handler wired) together with the
 * `ResourceSubscriptionManager` that owns its STOMP subscriptions, so each
 * entry point only has to attach a transport and tear the subscriptions down
 * on shutdown.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { SERVER_INFO, mcpToolName, stripToolPrefix } from "./constants.js";
import { PROMPTS, loadPromptContent, getPromptDefinition } from "./prompts-registry.js";
import { registerAllTools, getAllTools, executeTool } from "./tool-handlers.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
  handleCompleteRequest,
  handleResourceRead,
} from "./resources-catalog.js";
import { ResourceSubscriptionManager } from "./resource-subscriptions.js";
import { sanitizeError } from "./utils.js";
import type { OpenLClient } from "./client.js";

/**
 * Register every MCP request handler on `server`, dispatching to `client`.
 * Resource subscriptions are routed through `subscriptions`.
 */
export function registerMcpHandlers(
  server: Server,
  client: OpenLClient,
  subscriptions: ResourceSubscriptionManager,
): void {
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

  // List available resources — concrete (non-parameterized) URIs only.
  // Parameterized URIs live in `resources/templates/list` per the MCP spec
  // (see resources-catalog.ts).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }));

  // List available resource templates — URIs with `{var}` placeholders. The
  // client fills the variables (often with help from `completion/complete`)
  // before issuing the resulting concrete URI to read/subscribe.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  // Argument autocomplete for resource templates — answers "which projectIds
  // exist?" / "which branches does this project have?" by hitting the OpenL
  // backend. Backend errors are swallowed into the empty result so a slow
  // studio doesn't surface as a red error in the picker.
  server.setRequestHandler(CompleteRequestSchema, async (request) =>
    handleCompleteRequest(client, request.params)
  );

  // Handle resource reads (shared routing lives in resources-catalog.ts)
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    handleResourceRead(request.params.uri, client)
  );

  // resources/subscribe — wire status URIs to STOMP-backed notifications.
  // Other URIs are rejected by `ResourceSubscriptionManager.subscribe`.
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    try {
      await subscriptions.subscribe(request.params.uri);
    } catch (err) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Failed to subscribe to ${request.params.uri}: ${sanitizeError(err)}`,
      );
    }
    return {};
  });

  // resources/unsubscribe — idempotent per spec; missing URIs succeed silently.
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    await subscriptions.unsubscribe(request.params.uri);
    return {};
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
 * declared, tools registered, every request handler wired. Returns the server
 * together with the `ResourceSubscriptionManager` that owns its STOMP
 * subscriptions; the caller attaches a transport and, on shutdown, calls
 * `subscriptions.closeAll()`.
 */
export function createConfiguredServer(client: OpenLClient): {
  server: Server;
  subscriptions: ResourceSubscriptionManager;
} {
  const server = new Server(
    {
      name: SERVER_INFO.NAME,
      version: SERVER_INFO.VERSION,
    },
    {
      capabilities: {
        tools: {},
        // Declare `subscribe: true` so clients see the resource-subscription
        // capability and start sending resources/subscribe + receiving
        // notifications/resources/updated for `openl://status/...` URIs.
        resources: { subscribe: true },
        prompts: {},
        // Advertise `completion/complete` so clients offer inline
        // suggestions for {projectId}/{branch} in resource templates.
        completions: {},
      },
    }
  );

  // The subscription manager dispatches doorbell notifications through this
  // server instance, so they target only the transport it is connected to.
  const subscriptions = new ResourceSubscriptionManager(
    client,
    (uri) => server.sendResourceUpdated({ uri }),
  );

  registerAllTools(server, client);
  registerMcpHandlers(server, client, subscriptions);

  return { server, subscriptions };
}
