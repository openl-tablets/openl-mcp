#!/usr/bin/env node

/**
 * OpenL MCP Server
 *
 * Model Context Protocol server for OpenL Studio Rules Management System.
 * Provides tools and resources for managing rules projects, tables, and deployments.
 *
 * Features:
 * - Multiple authentication methods (Basic Auth, Personal Access Token)
 * - Type-safe input validation with Zod
 * - Request tracking with Client Document ID (OPENL_CLIENT_DOCUMENT_ID) for audit and debugging
 * - Comprehensive error handling
 *
 * @see https://github.com/openl-tablets/openl-mcp
 * @see https://modelcontextprotocol.io/
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import our modular components
import { OpenLClient } from "./client.js";
import { SERVER_INFO } from "./constants.js";
import { PROMPTS, loadPromptContent, getPromptDefinition } from "./prompts-registry.js";
import { registerAllTools, getAllTools, executeTool } from "./tool-handlers.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
  handleCompleteRequest,
} from "./resources-catalog.js";
import { ResourceSubscriptionManager } from "./resource-subscriptions.js";
import { safeStringify, sanitizeError } from "./utils.js";
import type * as Types from "./types.js";

/**
 * MCP Server for OpenL Studio
 *
 * Handles MCP protocol communication and routes requests to the OpenL client.
 */
class OpenLMCPServer {
  private server: Server;
  private client: OpenLClient;
  private subscriptions: ResourceSubscriptionManager;

  /**
   * Create a new MCP server instance
   *
   * @param config - OpenL Studio configuration
   */
  constructor(config: Types.OpenLConfig) {
    // Initialize OpenL API client
    this.client = new OpenLClient(config);

    // Initialize MCP server
    this.server = new Server(
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

    // Initialize all tool handlers
    registerAllTools(this.server, this.client);

    // Per-process subscription manager — stdio is single-session, so one
    // manager is enough. The Server's `sendResourceUpdated` is bound to the
    // single connected stdio transport.
    this.subscriptions = new ResourceSubscriptionManager(
      this.client,
      (uri) => this.server.sendResourceUpdated({ uri }),
    );

    this.setupHandlers();
    this.setupShutdownHooks();
  }

  /**
   * Tear down all STOMP subscriptions cleanly on process exit so the studio
   * isn't left with dangling WS sessions.
   */
  private setupShutdownHooks(): void {
    const shutdown = (signal: string): void => {
      console.error(`[OpenLMCP] received ${signal}, closing ${this.subscriptions.size} subscription(s)…`);
      void this.subscriptions.closeAll().finally(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getAllTools().map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        ...(annotations && { annotations }),
      })),
    }));

    // Handle tool execution. `extra` carries the SDK request context (progressToken,
    // per-session sendNotification, AbortSignal) that long-running tools need.
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const result = await executeTool(request.params.name, request.params.arguments, this.client, extra);
      return result as any; // Type cast needed due to MCP SDK generic return type
    });

    // List available resources — concrete (non-parameterized) URIs only.
    // Parameterized URIs live in `resources/templates/list` per the MCP spec
    // (see resources-catalog.ts).
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: STATIC_RESOURCES,
    }));

    // List available resource templates — URIs with `{var}` placeholders. The
    // client fills the variables (often with help from `completion/complete`)
    // before issuing the resulting concrete URI to read/subscribe.
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: RESOURCE_TEMPLATES,
    }));

    // Argument autocomplete for resource templates — answers "which projectIds
    // exist?" / "which branches does this project have?" by hitting the OpenL
    // backend. Backend errors are swallowed into the empty result so a slow
    // studio doesn't surface as a red error in the picker.
    this.server.setRequestHandler(CompleteRequestSchema, async (request) =>
      handleCompleteRequest(this.client, request.params)
    );

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      this.handleResourceRead(request.params.uri)
    );

    // resources/subscribe — wire status URIs to STOMP-backed notifications.
    // Other URIs are rejected by `ResourceSubscriptionManager.subscribe`.
    this.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      try {
        await this.subscriptions.subscribe(request.params.uri);
      } catch (err) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Failed to subscribe to ${request.params.uri}: ${sanitizeError(err)}`,
        );
      }
      return {};
    });

    // resources/unsubscribe — idempotent per spec; missing URIs succeed silently.
    this.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      await this.subscriptions.unsubscribe(request.params.uri);
      return {};
    });

    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: PROMPTS,
    }));

    // Get specific prompt with optional arguments
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
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
   * Note: Tool execution is now handled by the tool-handlers module.
   * The handleToolCall method has been removed and replaced with the
   * registerAllTools/executeTool pattern for better modularity.
   */

  /**
   * REMOVED: The entire handleToolCall method with switch statement
   * has been replaced by the tool-handlers.ts module.
   * See registerAllTools() and executeTool() functions.
   */

  /*
  REMOVED METHOD - The switch statement handleToolCall has been completely removed.
  All tool handling is now done through tool-handlers.ts
  */

  /**
   * Handle resource read requests
   *
   * @param uri - Resource URI
   * @returns Resource content
   */
  private async handleResourceRead(
    uri: string
  ): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
    try {
      let data: unknown;
      let mimeType = "application/json";

      // Parse URI and extract parameters
      const uriMatch = uri.match(/^openl:\/\/([^\/]+)(?:\/(.+))?$/);
      if (!uriMatch) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI: ${uri}`);
      }

      const [, resourceType, path] = uriMatch;

      switch (resourceType) {
        case "repositories": {
          data = await this.client.listRepositories();
          break;
        }

        case "projects": {
          if (!path) {
            // openl://projects - List all projects
            data = await this.client.listProjects();
          } else {
            // Parse projects/{projectId} or projects/{projectId}/...
            const projectMatch = path.match(/^([^\/]+)(?:\/(.+))?$/);
            if (!projectMatch) {
              throw new McpError(ErrorCode.InvalidRequest, `Invalid project URI: ${uri}`);
            }

            const [, projectId, subPath] = projectMatch;

            if (!subPath) {
              // openl://projects/{projectId} - Get project details
              data = await this.client.getProject(projectId);
            } else if (subPath === "history") {
              // openl://projects/{projectId}/history - Get project history
              data = await this.client.getProjectHistory({ projectId });
            } else if (subPath.startsWith("tables")) {
              // Parse tables or tables/{tableId}
              const tableMatch = subPath.match(/^tables(?:\/(.+))?$/);
              if (!tableMatch) {
                throw new McpError(ErrorCode.InvalidRequest, `Invalid tables URI: ${uri}`);
              }

              const [, tableId] = tableMatch;

              if (!tableId) {
                // openl://projects/{projectId}/tables - List tables
                data = await this.client.listTables(projectId);
              } else {
                // openl://projects/{projectId}/tables/{tableId} - Get table
                data = await this.client.getTable(projectId, tableId);
              }
            } else if (subPath.startsWith("files/")) {
              // openl://projects/{projectId}/files/{filePath} - Download file
              const filePath = subPath.substring(6); // Remove "files/" prefix
              if (!filePath) {
                throw new McpError(ErrorCode.InvalidRequest, `File path is required: ${uri}`);
              }

              const fileBuffer = await this.client.downloadFile(projectId, filePath);
              mimeType = "application/octet-stream";

              const tempFileName = `openl-resource-${Date.now()}-${Math.random().toString(16).slice(2)}-${filePath.split("/").pop() || "file.bin"}`;
              const tempFilePath = join(tmpdir(), tempFileName);
              await writeFile(tempFilePath, fileBuffer);

              return {
                contents: [
                  {
                    uri,
                    mimeType: "application/json",
                    text: safeStringify({
                      filePath,
                      downloadedTo: tempFilePath,
                      size: fileBuffer.length,
                      mode: "binary-file-path",
                    }),
                  },
                ],
              };
            } else {
              throw new McpError(ErrorCode.InvalidRequest, `Unknown project subresource: ${subPath}`);
            }
          }
          break;
        }

        case "deployments": {
          data = await this.client.listDeployments();
          break;
        }

        case "status": {
          if (!path) {
            throw new McpError(ErrorCode.InvalidRequest, `Project ID is required: ${uri}`);
          }
          const statusMatch = path.match(/^([^\/]+)(?:\/(.+))?$/);
          if (!statusMatch) {
            throw new McpError(ErrorCode.InvalidRequest, `Invalid status URI: ${uri}`);
          }
          const [, statusProjectId, statusBranch] = statusMatch;
          data = await this.client.getProjectStatus(statusProjectId, statusBranch);
          break;
        }

        default:
          throw new McpError(ErrorCode.InvalidRequest, `Unknown resource type: ${resourceType}`);
      }

      return {
        contents: [
          {
            uri,
            mimeType,
            text: safeStringify(data, 2),
          },
        ],
      };
    } catch (error: unknown) {
      if (error instanceof McpError) {
        throw error;
      }

      const sanitizedMessage = sanitizeError(error);
      throw new McpError(
        ErrorCode.InternalError,
        `Error reading resource ${uri}: ${sanitizedMessage}`
      );
    }
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

/**
 * Load configuration from query parameters (for HTTP SSE transport)
 *
 * @param query - Query parameters from HTTP request
 * @returns OpenL Studio configuration or null if not enough parameters
 * @throws Error if configuration is invalid (invalid URL format, invalid timeout, missing authentication)
 */
export function loadConfigFromQuery(query: Record<string, string | undefined>): Types.OpenLConfig | null {
  const baseUrl = query.OPENL_BASE_URL;
  if (!baseUrl) {
    return null; // Not enough parameters
  }

  // Validate base URL format
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid OPENL_BASE_URL format: ${baseUrl}`);
  }

  // Parse and validate timeout if provided
  let timeout: number | undefined;
  if (query.OPENL_TIMEOUT) {
    const parsedTimeout = parseInt(query.OPENL_TIMEOUT, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`Invalid OPENL_TIMEOUT value: ${query.OPENL_TIMEOUT}`);
    }
    timeout = parsedTimeout;
  }

  const config: Types.OpenLConfig = {
    baseUrl,
    username: query.OPENL_USERNAME,
    password: query.OPENL_PASSWORD,
    personalAccessToken: query.OPENL_PERSONAL_ACCESS_TOKEN,
    timeout,
  };

  // Validate at least one authentication method is configured
  // Require either both username and password (Basic Auth) or Personal Access Token
  if (!((config.username && config.password) || config.personalAccessToken)) {
    throw new Error(
      "At least one authentication method must be configured " +
        "(both username and password for Basic Auth, or Personal Access Token)"
    );
  }

  return config;
}

/**
 * Load configuration from environment variables
 *
 * NOTE: This function is used for stdio transport (when MCP client launches the server directly).
 * Authentication credentials should be provided via environment variables set in the MCP client
 * configuration file (Cursor/Claude Desktop settings), NOT in Docker/environment variables.
 *
 * @returns OpenL Studio configuration
 * @throws Error if required configuration is missing or invalid
 */
export async function loadConfigFromEnv(): Promise<Types.OpenLConfig> {
  console.error(`[Config] Loading configuration from environment variables...`);
  console.error(`[Config] NOTE: This is for stdio transport. Auth credentials should come from MCP client config.`);
  const baseUrl = process.env.OPENL_BASE_URL;
  if (!baseUrl) {
    throw new Error("OPENL_BASE_URL environment variable is required");
  }

  // Validate base URL format
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid OPENL_BASE_URL format: ${baseUrl}`);
  }

  // Parse and validate timeout
  let timeout: number | undefined;
  if (process.env.OPENL_TIMEOUT) {
    const parsedTimeout = parseInt(process.env.OPENL_TIMEOUT, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`Invalid OPENL_TIMEOUT value: ${process.env.OPENL_TIMEOUT}`);
    }
    timeout = parsedTimeout;
  }

  const config: Types.OpenLConfig = {
    baseUrl,
    username: process.env.OPENL_USERNAME,
    password: process.env.OPENL_PASSWORD,
    personalAccessToken: process.env.OPENL_PERSONAL_ACCESS_TOKEN,
    timeout,
  };

  // Log authentication configuration (without sensitive data)
  console.error(`[Config] Authentication methods:`);
  console.error(`[Config]   - Personal Access Token: ${!!config.personalAccessToken ? 'configured (hidden)' : 'not configured'}`);
  console.error(`[Config]   - Basic Auth: ${!!config.username && !!config.password ? `configured (username: ${config.username}, password: hidden)` : 'not configured'}`);
  if (!config.username) {
    console.error(`[Config]   ⚠️  OPENL_USERNAME is not set`);
  }
  if (!config.password) {
    console.error(`[Config]   ⚠️  OPENL_PASSWORD is not set`);
  }

  // Validate at least one authentication method is configured
  // Require either both username and password (Basic Auth) or Personal Access Token
  if (!((config.username && config.password) || config.personalAccessToken)) {
    throw new Error(
      "At least one authentication method must be configured " +
        "(both username and password for Basic Auth, or Personal Access Token)"
    );
  }

  return config;
}

/**
 * Main entry point.
 *
 * Dispatches based on how the binary was invoked:
 * - No CLI arguments → start MCP server on stdio (legacy behavior for
 *   Claude Desktop / Cursor / other MCP clients).
 * - Any CLI arguments → CLI mode (direct API invocation via `executeTool`).
 *   See `src/cli.ts`.
 */
async function main(): Promise<void> {
  try {
    const cliArgs = process.argv.slice(2);
    if (cliArgs.length > 0) {
      // EPIPE handling: when our stdout is piped into something that exits
      // early (`npx … | head -1`), the next write would throw EPIPE and crash
      // the process. Treat it as a successful early termination — exit 0.
      // See https://github.com/nodejs/node-v0.x-archive/issues/3211
      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE") process.exit(0);
        throw err;
      });

      const { runCli } = await import("./cli.js");
      const code = await runCli({ argv: cliArgs });
      process.exit(code);
    }

    const config = await loadConfigFromEnv();
    const server = new OpenLMCPServer(config);
    await server.start();
  } catch (error: unknown) {
    const sanitizedMessage = sanitizeError(error);
    console.error("Failed to start OpenL MCP server:", sanitizedMessage);
    process.exit(1);
  }
}

// Start the server only if this file is run directly (not imported)
// Check if this is the main module using import.meta.url
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js')) {
  main();
}
