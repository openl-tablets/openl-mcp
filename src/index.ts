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

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// Import our modular components
import { OpenLClient } from "./client.js";
import { SERVER_INFO } from "./constants.js";
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

    // Handle resource reads (shared routing lives in resources-catalog.ts)
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      handleResourceRead(request.params.uri, this.client)
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

  // Authentication is optional: OpenL Studio in single-user mode accepts
  // unauthenticated requests. Warn when partial Basic Auth is given (username
  // without password, or vice versa) — that is almost certainly a misconfig.
  const hasPat = !!config.personalAccessToken;
  const hasBasic = !!(config.username && config.password);
  if (!hasPat && !hasBasic && (config.username || config.password)) {
    console.error(
      "[Config] ⚠️  Incomplete Basic Auth (only one of OPENL_USERNAME/OPENL_PASSWORD set) — sending no Authorization header"
    );
  }

  return config;
}

/**
 * Explicit configuration overrides for the stdio server launch. Each field,
 * when defined, takes precedence over the matching `OPENL_*` environment
 * variable. Populated from the binary's command-line arguments (a positional
 * `<url>` and optional auth/timeout flags) in `main()`.
 */
interface ServerConfigOverrides {
  baseUrl?: string;
  username?: string;
  password?: string;
  personalAccessToken?: string;
  timeout?: number;
}

/**
 * Load configuration for the stdio transport (when an MCP client — or a direct
 * `openl-mcp <url>` invocation — launches the server).
 *
 * The base URL resolves from `overrides.baseUrl` (the positional `<url>` /
 * `--base-url`) first, then the `OPENL_BASE_URL` environment variable.
 * Authentication is OPTIONAL (OpenL Studio single-user mode accepts
 * unauthenticated requests); credentials, when present, come from overrides or
 * the environment.
 *
 * @param overrides - Command-line overrides; each falls back to its env var.
 * @returns OpenL Studio configuration
 * @throws Error if the base URL is missing or malformed, or timeout is invalid
 */
export async function loadConfigFromEnv(
  overrides: ServerConfigOverrides = {},
): Promise<Types.OpenLConfig> {
  console.error(`[Config] Resolving configuration (positional <url> / flags / environment)...`);
  console.error(`[Config] NOTE: This is for stdio transport. Auth credentials may come from MCP client config or CLI flags.`);
  const baseUrl = overrides.baseUrl ?? process.env.OPENL_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "OpenL base URL is required: pass it as a positional argument " +
        "(openl-mcp <url>) or set the OPENL_BASE_URL environment variable",
    );
  }

  // Validate base URL format
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid OpenL base URL: ${baseUrl}`);
  }

  // Parse and validate timeout — flag override first, then env.
  let timeout: number | undefined = overrides.timeout;
  if (timeout === undefined && process.env.OPENL_TIMEOUT) {
    const parsedTimeout = parseInt(process.env.OPENL_TIMEOUT, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`Invalid OPENL_TIMEOUT value: ${process.env.OPENL_TIMEOUT}`);
    }
    timeout = parsedTimeout;
  }

  const config: Types.OpenLConfig = {
    baseUrl,
    username: overrides.username ?? process.env.OPENL_USERNAME,
    password: overrides.password ?? process.env.OPENL_PASSWORD,
    personalAccessToken: overrides.personalAccessToken ?? process.env.OPENL_PERSONAL_ACCESS_TOKEN,
    timeout,
  };

  // Authentication is optional: OpenL Studio in single-user mode accepts
  // unauthenticated requests. Report what was found; warn (don't fail) on
  // partial Basic Auth so a typo in OPENL_USERNAME/OPENL_PASSWORD is visible.
  const hasPat = !!config.personalAccessToken;
  const hasBasic = !!(config.username && config.password);
  console.error(`[Config] Authentication methods:`);
  console.error(`[Config]   - Personal Access Token: ${hasPat ? 'configured (hidden)' : 'not configured'}`);
  console.error(`[Config]   - Basic Auth: ${hasBasic ? `configured (username: ${config.username}, password: hidden)` : 'not configured'}`);
  if (!hasPat && !hasBasic) {
    if (config.username || config.password) {
      console.error(`[Config]   ⚠️  Incomplete Basic Auth — sending no Authorization header (set both OPENL_USERNAME and OPENL_PASSWORD, or use OPENL_PERSONAL_ACCESS_TOKEN)`);
    } else {
      console.error(`[Config]   ℹ️  No authentication configured — requests will be sent without an Authorization header (OpenL Studio single-user mode)`);
    }
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
    const { parseArgs, isCliInvocation, runCli } = await import("./cli.js");
    const parsed = parseArgs(cliArgs);

    if (isCliInvocation(parsed)) {
      // CLI/tool mode: a tool name, a discovery flag (--help/--list-tools/
      // --version), a tool-argument source, or a parse error.
      //
      // EPIPE handling: when our stdout is piped into something that exits
      // early (`npx … | head -1`), the next write would throw EPIPE and crash
      // the process. Treat it as a successful early termination — exit 0.
      // See https://github.com/nodejs/node-v0.x-archive/issues/3211
      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE") process.exit(0);
        throw err;
      });

      const code = await runCli({ argv: cliArgs });
      process.exit(code);
    }

    // Otherwise: launch the MCP server on stdio. The base URL comes from the
    // positional `<url>` argument first, then `--base-url`, then OPENL_BASE_URL
    // (Claude Desktop / Cursor / other MCP clients). Auth/timeout may also be
    // supplied as flags, each falling back to its env var.

    // Honor --client-document-id here too: the client reads it from
    // OPENL_CLIENT_DOCUMENT_ID per request, so set it for the process lifetime.
    if (parsed.overrides.clientDocumentId !== undefined) {
      process.env.OPENL_CLIENT_DOCUMENT_ID = parsed.overrides.clientDocumentId;
    }
    // --cookie-jar and --anonymous only apply to single CLI tool invocations;
    // they have no effect on the long-lived server. Warn rather than ignore
    // silently, so a misplaced flag doesn't look like it took effect.
    if (parsed.cookieJarPath !== undefined) {
      console.error("Warning: --cookie-jar is ignored when launching the MCP server (it applies only to single tool invocations).");
    }
    if (parsed.anonymous) {
      console.error("Warning: --anonymous is ignored when launching the MCP server (authentication is already optional).");
    }

    let config: Types.OpenLConfig;
    try {
      config = await loadConfigFromEnv({
        baseUrl: parsed.baseUrlPositional ?? parsed.overrides.baseUrl,
        username: parsed.overrides.username,
        password: parsed.overrides.password,
        personalAccessToken: parsed.overrides.token,
        timeout: parsed.overrides.timeout,
      });
    } catch (error: unknown) {
      // Missing/invalid base URL is a usage problem, not a crash — print a
      // clear, stack-trace-free message naming both ways to supply the URL,
      // then exit 1.
      console.error(`Error: ${sanitizeError(error)}`);
      console.error("");
      console.error("Usage:");
      console.error("  openl-mcp <url>                 start the MCP server for <url>");
      console.error("  OPENL_BASE_URL=<url> openl-mcp  start the MCP server using the env var");
      console.error("");
      console.error("Provide the OpenL Studio base URL as a positional argument, or via the");
      console.error("OPENL_BASE_URL environment variable. Run `openl-mcp --help` for full usage.");
      process.exit(1);
    }

    const server = new OpenLMCPServer(config);
    await server.start();
  } catch (error: unknown) {
    const sanitizedMessage = sanitizeError(error);
    console.error("Failed to start OpenL MCP server:", sanitizedMessage);
    process.exit(1);
  }
}

/**
 * True when this module is the process entry point (run directly), false when
 * it's merely imported (e.g. by the test suite, which must not start a server).
 *
 * Compares the realpath of `process.argv[1]` to this module's own path. Using
 * realpaths is essential: when the binary is launched through a `bin` symlink
 * — which is how a global install (`npm i -g`) and npm's `.bin/` shims invoke
 * it — `process.argv[1]` is the UNRESOLVED symlink path (e.g. `.../bin/openl-
 * mcp-server`), so the previous `=== file://argv[1]` / `endsWith('index.js')`
 * check missed it and `main()` never ran. realpath resolves the symlink to the
 * real `dist/index.js`, and also smooths over platform path quirks (e.g. macOS
 * `/tmp` → `/private/tmp`). Falls back to `false` if the path can't be resolved.
 */
function isMainEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainEntryPoint()) {
  main();
}
