#!/usr/bin/env node

/**
 * Express HTTP Server for OpenL MCP Server
 * 
 * Provides HTTP REST API for accessing MCP tools as a standalone service.
 * This allows the MCP server to be used as a microservice in Docker Compose.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { OpenLClient } from './client.js';
import { getAllTools, executeTool, registerAllTools } from './tool-handlers.js';
import { sanitizeError, safeStringify } from './utils.js';
import type * as Types from './types.js';
import { SERVER_INFO } from './constants.js';
import { PROMPTS, loadPromptContent, getPromptDefinition } from './prompts-registry.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware (disabled to reduce noise)
app.use((req: Request, res: Response, next: NextFunction) => {
  next();
});

// Initialize OpenL client (default from environment)
let defaultClient: OpenLClient | null = null;

// Store clients by session ID (for per-session configuration)
const clientsBySession: Record<string, OpenLClient> = {};
const NO_DEFAULT_CLIENT_ERROR =
  "No OpenL client available. Configure OPENL_BASE_URL in server environment variables or Docker configuration.";

function getDefaultClientOrThrow(): OpenLClient {
  if (!defaultClient) {
    throw new Error(NO_DEFAULT_CLIENT_ERROR);
  }
  return defaultClient;
}

// Initialize default OpenL client (async - will be awaited before server starts)
// NOTE: Authentication credentials should NOT be set in Docker/environment variables.
// They must be provided via MCP client configuration (query params or headers for HTTP transport).
async function initializeDefaultClient(): Promise<void> {
  try {
    // Try to get base URL from env, but don't require authentication
    // This allows the server to start without auth, and auth will be provided per-session
    const baseUrl = process.env.OPENL_BASE_URL;
    if (!baseUrl) {
      return;
    }

    // Validate base URL format
    try {
      new URL(baseUrl);
    } catch {
      console.error(`⚠️  Invalid OPENL_BASE_URL format: ${baseUrl}`);
      return;
    }

    // Create a minimal config with just base URL (no auth)
    // Auth will come from query params or headers per session
    const config: Types.OpenLConfig = {
      baseUrl,
    };

    // Only create client if we have at least base URL
    // Auth will be provided per-session via query params or headers
    defaultClient = new OpenLClient(config);
  } catch (error) {
    console.error('❌ Failed to initialize default OpenL client:', sanitizeError(error));
    // Don't exit - allow per-session clients
  }
}

/**
 * Get client for a session, creating one with authentication from client if provided
 * Base URL always comes from server configuration (OPENL_BASE_URL env var or Docker config)
 */
function getClientForSession(sessionId: string, query?: Record<string, string | undefined>): OpenLClient {
  // If client already exists for this session, return it
  if (clientsBySession[sessionId]) {
    return clientsBySession[sessionId];
  }

  // Base URL must come from server configuration
  const baseClient = getDefaultClientOrThrow();

  // If authentication is provided via query params/headers, create a new client with same base URL but different auth
  if (query && (query.OPENL_PERSONAL_ACCESS_TOKEN || query.OPENL_USERNAME)) {
    try {
      // Get base URL from default client (server configuration)
      const baseUrl = baseClient.getBaseUrl();
      
      // Build config with server's base URL and client's authentication
      const config: Types.OpenLConfig = {
        baseUrl,
        username: query.OPENL_USERNAME,
        password: query.OPENL_PASSWORD,
        personalAccessToken: query.OPENL_PERSONAL_ACCESS_TOKEN,
        timeout: query.OPENL_TIMEOUT ? parseInt(query.OPENL_TIMEOUT, 10) : undefined,
      };

      const client = new OpenLClient(config);
      clientsBySession[sessionId] = client;
      // Only log on first client creation for this session (not on every request)
      return client;
    } catch (error) {
      console.error(`⚠️  Failed to create client for session ${sessionId}:`, sanitizeError(error));
      // Fall back to default client
    }
  }

  // Use default client (with server-configured base URL and auth)
  return baseClient;
}

// Initialize MCP Server for SSE transport
let mcpServer: Server;

async function initializeMCPServer(): Promise<void> {
  try {
    mcpServer = new Server(
      {
        name: SERVER_INFO.NAME,
        version: SERVER_INFO.VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    // Register all tools with a function that gets the client dynamically
    // We'll use a wrapper that gets the client from the session
    registerAllTools(mcpServer, getDefaultClientOrThrow());

  // Setup MCP handlers (similar to index.ts)
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools().map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      ...(annotations && { annotations }),
    })),
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Get client from request context (session ID stored in transport)
    // For now, use default client - we'll update this to use session-specific clients
    const client = getDefaultClientOrThrow();
    const result = await executeTool(request.params.name, request.params.arguments, client);
    return result as any;
  });

  mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "openl://repositories",
        name: "OpenL Repositories",
        description: "All design repositories in OpenL Studio",
        mimeType: "application/json",
      },
      {
        uri: "openl://projects",
        name: "OpenL Projects",
        description: "All projects across all repositories",
        mimeType: "application/json",
      },
      {
        uri: "openl://projects/{projectId}",
        name: "OpenL Project Details",
        description: "Get details for a specific project",
        mimeType: "application/json",
      },
      {
        uri: "openl://deployments",
        name: "OpenL Deployments",
        description: "All deployment repositories and deployed projects",
        mimeType: "application/json",
      },
    ],
  }));

  // Handle resource reads
  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const client = getDefaultClientOrThrow();
    return handleResourceRead(request.params.uri, client);
  });

  mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const prompt = getPromptDefinition(name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }
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
  });

  } catch (error) {
    console.error('❌ Failed to initialize MCP Server:', sanitizeError(error));
    process.exit(1);
  }
}

// Store SSE transports by session ID
const sseTransports: Record<string, SSEServerTransport> = {};
// Store streamableHttp transports by session ID
const streamableHttpTransports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Setup MCP server handlers for a session
 * 
 * @param server - MCP server instance
 * @param client - OpenL client for this session
 */
function setupSessionHandlers(server: Server, client: OpenLClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools().map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      ...(annotations && { annotations }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await executeTool(request.params.name, request.params.arguments, client);
    return result as any;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "openl://repositories",
        name: "OpenL Repositories",
        description: "All design repositories in OpenL Studio",
        mimeType: "application/json",
      },
      {
        uri: "openl://projects",
        name: "OpenL Projects",
        description: "All projects across all repositories",
        mimeType: "application/json",
      },
      {
        uri: "openl://projects/{projectId}",
        name: "OpenL Project Details",
        description: "Get details for a specific project",
        mimeType: "application/json",
      },
      {
        uri: "openl://deployments",
        name: "OpenL Deployments",
        description: "All deployment repositories and deployed projects",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return handleResourceRead(request.params.uri, client);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const prompt = getPromptDefinition(name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }
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
  });
}

/**
 * Create a new MCP server instance for a session
 * 
 * @param client - OpenL client for this session
 * @returns Configured MCP server instance
 */
function createSessionServer(client: OpenLClient): Server {
  const sessionServer = new Server(
    {
      name: SERVER_INFO.NAME,
      version: SERVER_INFO.VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // Register tools and setup handlers
  registerAllTools(sessionServer, client);
  setupSessionHandlers(sessionServer, client);

  return sessionServer;
}

/**
 * Handle resource read requests (shared between SSE and REST API)
 */
async function handleResourceRead(
  uri: string,
  client: OpenLClient
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
        data = await client.listRepositories();
        break;
      }

      case "projects": {
        if (!path) {
          // openl://projects - List all projects
          data = await client.listProjects();
        } else {
          // Parse projects/{projectId} or projects/{projectId}/...
          const projectMatch = path.match(/^([^\/]+)(?:\/(.+))?$/);
          if (!projectMatch) {
            throw new McpError(ErrorCode.InvalidRequest, `Invalid project URI: ${uri}`);
          }

          const [, projectId, subPath] = projectMatch;

          if (!subPath) {
            // openl://projects/{projectId} - Get project details
            data = await client.getProject(projectId);
          } else if (subPath === "history") {
            // openl://projects/{projectId}/history - Get project history
            data = await client.getProjectHistory({ projectId });
          } else if (subPath.startsWith("tables")) {
            // Parse tables or tables/{tableId}
            const tableMatch = subPath.match(/^tables(?:\/(.+))?$/);
            if (!tableMatch) {
              throw new McpError(ErrorCode.InvalidRequest, `Invalid tables URI: ${uri}`);
            }

            const [, tableId] = tableMatch;

            if (!tableId) {
              // openl://projects/{projectId}/tables - List tables
              data = await client.listTables(projectId);
            } else {
              // openl://projects/{projectId}/tables/{tableId} - Get table
              data = await client.getTable(projectId, tableId);
            }
          } else if (subPath.startsWith("files/")) {
            // openl://projects/{projectId}/files/{filePath} - Download file
            const filePath = subPath.substring(6); // Remove "files/" prefix
            if (!filePath) {
              throw new McpError(ErrorCode.InvalidRequest, `File path is required: ${uri}`);
            }

            const fileBuffer = await client.downloadFile(projectId, filePath);
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
        data = await client.listDeployments();
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
 * SSE endpoint handler (shared for /mcp/sse and /sse)
 */
const handleSSE = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    // Extract configuration from headers and query params (only authentication, not base URL)
    const configFromHeaders: Record<string, string | undefined> = {};
    
    // Extract token from standard Authorization header: "Authorization: Token <PAT>" or "Authorization: Bearer <PAT>"
    // Supports both formats: Bearer (from MCP config) and Token (direct format)
    // Bearer will be converted to Token format for OpenL API requests
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      if (authHeader.startsWith('Token ')) {
        const token = authHeader.substring(6); // Remove "Token " prefix
        if (token) {
          configFromHeaders.OPENL_PERSONAL_ACCESS_TOKEN = token;
        }
      } else if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7); // Remove "Bearer " prefix
        if (token) {
          configFromHeaders.OPENL_PERSONAL_ACCESS_TOKEN = token;
        }
      }
    }

    // Merge headers and query params (only for authentication, base URL comes from server config)
    const configParams = { ...req.query, ...configFromHeaders } as Record<string, string | undefined>;
    
    // Try to create client from configuration (base URL from server, auth from client)
    const sessionId = randomUUID();
    const client = getClientForSession(sessionId, configParams);
    
    // Create a new MCP server instance for this session with the specific client
    const sessionServer = createSessionServer(client);

    // Determine messages endpoint path based on request path
    // If request came via /sse (nginx proxy), use /messages, otherwise use /mcp/messages
    const messagesPath = req.path === '/sse' ? '/messages' : '/mcp/messages';
    const transport = new SSEServerTransport(messagesPath, res);
    const transportSessionId = transport.sessionId;
    sseTransports[transportSessionId] = transport;

    res.on('close', () => {
      delete sseTransports[transportSessionId];
      delete clientsBySession[sessionId];
    });

    await sessionServer.connect(transport);
  } catch (error) {
    console.error('❌ Failed to establish SSE connection:', sanitizeError(error));
    res.status(500).json({ error: 'Failed to establish SSE connection', message: sanitizeError(error) });
  }
};

/**
 * SSE endpoint for MCP protocol (for Cursor direct connection)
 * GET /mcp/sse - Establishes SSE connection
 * GET /sse - Alias for nginx proxy compatibility (when /mcp prefix is stripped)
 * 
 * Base URL is configured on the server side (environment variable OPENL_BASE_URL or Docker config).
 * Only authentication token can be passed via Authorization header or query parameter.
 * 
 * Supports configuration via:
 *   1. HTTP Authorization header: "Authorization: Token <PAT>" or "Authorization: Bearer <PAT>"
 *      (Bearer format will be automatically converted to Token format for OpenL API)
 *   2. Query parameter: ?OPENL_PERSONAL_ACCESS_TOKEN=<PAT>
 */
app.get('/mcp/sse', handleSSE);
app.get('/sse', handleSSE); // Alias for nginx proxy compatibility

/**
 * StreamableHttp endpoint handler (shared for /mcp/sse and /sse)
 */
const handleStreamableHttp = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    // Extract configuration from headers and query params (only authentication, not base URL)
    const configFromHeaders: Record<string, string | undefined> = {};
    
    // Extract token from standard Authorization header: "Authorization: Token <PAT>" or "Authorization: Bearer <PAT>"
    // Supports both formats: Bearer (from MCP config) and Token (direct format)
    // Bearer will be converted to Token format for OpenL API requests
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      if (authHeader.startsWith('Token ')) {
        const token = authHeader.substring(6); // Remove "Token " prefix
        if (token) {
          configFromHeaders.OPENL_PERSONAL_ACCESS_TOKEN = token;
        }
      } else if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7); // Remove "Bearer " prefix
        if (token) {
          configFromHeaders.OPENL_PERSONAL_ACCESS_TOKEN = token;
        }
      }
    }

    // Merge headers and query params (only for authentication, base URL comes from server config)
    const configParams = { ...req.query, ...configFromHeaders } as Record<string, string | undefined>;

    // Check for existing session ID in headers
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    
    // Get or create client for this session
    const sessionClientId = sessionId || randomUUID();
    const client = getClientForSession(sessionClientId, configParams);

    if (sessionId && streamableHttpTransports[sessionId]) {
      // Reuse existing transport
      transport = streamableHttpTransports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request - create session-specific MCP server with the client
      const sessionServer = createSessionServer(client);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionClientId,
        onsessioninitialized: (id) => {
          streamableHttpTransports[id] = transport;
          clientsBySession[id] = client;
        }
      });

      // Clean up transport when closed
      transport.onclose = () => {
        if (transport.sessionId) {
          delete streamableHttpTransports[transport.sessionId];
          delete clientsBySession[transport.sessionId];
        }
      };

      // Connect session server to transport
      await sessionServer.connect(transport);
    } else {
      // Invalid request
      return res.status(400).json({ error: 'Invalid request' });
    }

    // Handle the request - StreamableHTTPServerTransport handles req/res internally
    // The transport will process the request and send the response
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('❌ Failed to handle StreamableHttp request:', sanitizeError(error));
    res.status(500).json({ error: 'Failed to handle StreamableHttp request' });
  }
};

/**
 * StreamableHttp endpoint for MCP protocol (for Cursor direct connection)
 * POST /mcp/sse - Establishes streamableHttp connection
 * POST /sse - Alias for nginx proxy compatibility (when /mcp prefix is stripped)
 * This allows Cursor to connect immediately without fallback to SSE
 * 
 * Base URL is configured on the server side (environment variable OPENL_BASE_URL or Docker config).
 * Only authentication token can be passed via Authorization header.
 * 
 * Supports configuration via:
 *   1. HTTP Authorization header: "Authorization: Token <PAT>" or "Authorization: Bearer <PAT>"
 *      (Bearer format will be automatically converted to Token format for OpenL API)
 */
app.post('/mcp/sse', handleStreamableHttp);
app.post('/sse', handleStreamableHttp); // Alias for nginx proxy compatibility

/**
 * Message endpoint handler for SSE transport (shared for /mcp/messages and /messages)
 */
const handleSSEMessages = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports[sessionId];
    
    if (!transport) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('❌ Failed to handle message:', sanitizeError(error));
    res.status(500).json({ error: 'Failed to handle message' });
  }
};

/**
 * Message endpoint for SSE transport
 * POST /mcp/messages?sessionId=xxx - Sends messages to MCP server
 * POST /messages?sessionId=xxx - Alias for nginx proxy compatibility
 */
app.post('/mcp/messages', handleSSEMessages);
app.post('/messages', handleSSEMessages); // Alias for nginx proxy compatibility

/**
 * Health check endpoint
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'openl-mcp-server',
    version: '1.0.0'
  });
});

/**
 * List all available tools
 */
app.get('/tools', (req: Request, res: Response) => {
  try {
    const tools = getAllTools();
    res.json({
      tools,
      count: tools.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list tools',
      message: sanitizeError(error)
    });
  }
});

/**
 * Get tool information by name
 */
app.get('/tools/:toolName', (req: Request, res: Response) => {
  try {
    const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
    const tools = getAllTools();
    const tool = tools.find(t => t.name === toolName);
    
    if (!tool) {
      return res.status(404).json({
        error: 'Tool not found',
        toolName
      });
    }
    
    res.json(tool);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get tool information',
      message: sanitizeError(error)
    });
  }
});

/**
 * Execute a tool
 */
app.post('/tools/:toolName/execute', async (req: Request, res: Response) => {
  try {
    const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
    const args = req.body;
    
    // Never log actual arguments - they may contain sensitive data
    
    if (!defaultClient) {
      return res.status(500).json({
        error: 'OpenL client not initialized',
        tool: toolName
      });
    }
    
    const result = await executeTool(toolName, args, defaultClient);
    
    res.json({
      tool: toolName,
      result
    });
  } catch (error: unknown) {
    const errorMessage = sanitizeError(error);
    console.error(`Error executing tool ${req.params.toolName}:`, errorMessage);
    
    res.status(500).json({
      error: 'Tool execution failed',
      tool: req.params.toolName,
      message: errorMessage
    });
  }
});

/**
 * Convenience endpoint: execute tool via POST body
 */
app.post('/execute', async (req: Request, res: Response) => {
  try {
    const { tool, arguments: args } = req.body;
    
    if (!tool) {
      return res.status(400).json({
        error: 'Missing required field: tool'
      });
    }
    
    // Never log actual arguments - they may contain sensitive data
    
    if (!defaultClient) {
      return res.status(500).json({
        error: 'OpenL client not initialized',
        tool
      });
    }
    
    const result = await executeTool(tool, args || {}, defaultClient);
    
    res.json({
      tool,
      result
    });
  } catch (error: unknown) {
    const errorMessage = sanitizeError(error);
    console.error(`Error executing tool:`, errorMessage);
    
    res.status(500).json({
      error: 'Tool execution failed',
      message: errorMessage
    });
  }
});

/**
 * Error handling middleware
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: sanitizeError(err)
  });
});

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

/**
 * Start the server
 */
async function startServer(): Promise<void> {
  // Initialize default client before starting server (optional - can use query params)
  await initializeDefaultClient();
  
  // Initialize MCP server (uses default client as fallback)
  await initializeMCPServer();
  
  app.listen(PORT, () => {
  console.log(`OpenL MCP Server listening on port ${PORT}`);
  });
}

// Start the server
startServer().catch((error) => {
  console.error('❌ Failed to start server:', sanitizeError(error));
  process.exit(1);
});

