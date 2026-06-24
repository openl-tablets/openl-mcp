/**
 * Express HTTP transport for OpenL MCP Server
 *
 * Exposes the MCP protocol over the Streamable HTTP transport (MCP spec
 * 2025-11-25) at a single endpoint, `/mcp`, so the server can run as a
 * standalone microservice in Docker Compose. The legacy HTTP+SSE transport
 * and the REST helper endpoints are intentionally not provided.
 *
 * This module is not an entry point: the single binary entry, `index.ts`,
 * lazy-imports it and calls {@link startHttpServer} when launched with
 * `--http`, so a stdio launch never loads Express.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { OpenLClient } from './client.js';
import { createConfiguredServer } from './mcp-core.js';
import { sanitizeError } from './utils.js';
import { SERVER_INFO } from './constants.js';
import type * as Types from './types.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
// They must be provided per session via the MCP client's Authorization header.
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
    // Auth comes from the Authorization header per session
    const config: Types.OpenLConfig = {
      baseUrl,
    };

    // Only create client if we have at least base URL
    // Auth will be provided per-session via the Authorization header
    defaultClient = new OpenLClient(config);
  } catch (error) {
    console.error('❌ Failed to initialize default OpenL client:', sanitizeError(error));
    // Don't exit - allow per-session clients
  }
}

/**
 * Get the OpenL client for a session. When the client supplied credentials via
 * the `Authorization` header, build a session client pairing the
 * server-configured base URL with those credentials; otherwise reuse the
 * credential-less default client. Base URL always comes from server
 * configuration (OPENL_BASE_URL env var or Docker config) — never the client.
 */
function getClientForSession(sessionId: string, auth?: Record<string, string | undefined>): OpenLClient {
  // If client already exists for this session, return it
  if (clientsBySession[sessionId]) {
    return clientsBySession[sessionId];
  }

  // Base URL must come from server configuration
  const baseClient = getDefaultClientOrThrow();

  // If the Authorization header carried a token, create a session client
  // with the server's base URL and that token.
  if (auth && auth.OPENL_PERSONAL_ACCESS_TOKEN) {
    try {
      // Get base URL from default client (server configuration)
      const baseUrl = baseClient.getBaseUrl();

      // Build config with server's base URL and the client's authentication
      const config: Types.OpenLConfig = {
        baseUrl,
        personalAccessToken: auth.OPENL_PERSONAL_ACCESS_TOKEN,
      };

      const client = new OpenLClient(config);
      clientsBySession[sessionId] = client;
      return client;
    } catch (error) {
      // Auth was explicitly supplied for this session; do NOT silently fall back
      // to the credential-less default client — that would surface later as a
      // confusing upstream 401. Surface the construction failure instead.
      console.error(`⚠️  Failed to create client for session ${sessionId}:`, sanitizeError(error));
      throw error;
    }
  }

  // No auth supplied: use the default client (server-configured base URL, no creds).
  return baseClient;
}

// Store streamableHttp transports by session ID
const streamableHttpTransports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Parse an HTTP `Authorization` header into OpenL client config fields.
 *
 * Supports the token schemes the OpenL REST API accepts:
 * - `Token <PAT>`  → personal access token
 * - `Bearer <PAT>` → personal access token (MCP clients commonly send Bearer)
 *
 * Returns an empty object when no usable credential is present. Mirrors the
 * scheme priority of {@link AuthenticationManager.addAuthHeaders}.
 */
function authConfigFromHeader(
  authHeader: string | string[] | undefined,
): Record<string, string | undefined> {
  const config: Record<string, string | undefined> = {};
  if (typeof authHeader !== "string") {
    return config;
  }
  if (authHeader.startsWith("Token ")) {
    const token = authHeader.substring(6);
    if (token) config.OPENL_PERSONAL_ACCESS_TOKEN = token;
  } else if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token) config.OPENL_PERSONAL_ACCESS_TOKEN = token;
  }
  return config;
}

/**
 * JSON-RPC error payload for malformed Streamable HTTP requests (no valid
 * session). Mirrors the shape the MCP SDK uses for transport-level errors.
 */
function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * POST /mcp — Streamable HTTP transport (MCP spec 2025-11-25).
 *
 * An `initialize` request (no session id) creates a session-scoped MCP server
 * bound to an auth-scoped OpenL client; subsequent requests carry the
 * `mcp-session-id` header and are routed to that session's transport.
 *
 * Base URL is always configured on the server (OPENL_BASE_URL). Only the
 * authentication token is supplied per request, via the HTTP Authorization
 * header: "Authorization: Token <PAT>" or "Authorization: Bearer <PAT>".
 */
const handleMcpPost = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && streamableHttpTransports[sessionId]) {
      // Existing session — route to its transport.
      transport = streamableHttpTransports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session. Extract auth from the Authorization header (Token/Bearer);
      // the base URL always comes from server config.
      const auth = authConfigFromHeader(req.headers.authorization);

      const newSessionId = randomUUID();
      const client = getClientForSession(newSessionId, auth);
      const { server: sessionServer, subscriptions } = createConfiguredServer(client);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          streamableHttpTransports[id] = transport;
          clientsBySession[id] = client;
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete streamableHttpTransports[transport.sessionId];
          delete clientsBySession[transport.sessionId];
        }
        // Tear down STOMP subscriptions owned by this session.
        void subscriptions.closeAll();
      };

      await sessionServer.connect(transport);
    } else {
      return res
        .status(400)
        .json(jsonRpcError(-32000, 'Bad Request: no valid session ID provided'));
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('❌ Failed to handle MCP request:', sanitizeError(error));
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  }
};

/**
 * GET /mcp — opens the server→client SSE stream for an established session.
 * DELETE /mcp — terminates an established session.
 *
 * Both require an existing `mcp-session-id` header; the StreamableHTTP
 * transport handles the method semantics internally.
 */
const handleMcpSessionRequest = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !streamableHttpTransports[sessionId]) {
      return res
        .status(400)
        .json(jsonRpcError(-32000, 'Bad Request: invalid or missing session ID'));
    }
    await streamableHttpTransports[sessionId].handleRequest(req, res);
  } catch (error) {
    console.error('❌ Failed to handle MCP session request:', sanitizeError(error));
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  }
};

app.post('/mcp', handleMcpPost);
app.get('/mcp', handleMcpSessionRequest);
app.delete('/mcp', handleMcpSessionRequest);

/**
 * Health check endpoint — liveness probe for Docker and load balancers.
 * Unauthenticated and dependency-free: it reports only that the HTTP process
 * is up, not that OpenL Studio is reachable.
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: SERVER_INFO.NAME,
    version: SERVER_INFO.VERSION,
  });
});

/**
 * Error handling middleware
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  // Sanitize before logging too — the raw error/stack may carry credentials
  // (e.g. an Authorization header echoed in an axios error config).
  console.error('Unhandled error:', sanitizeError(err));
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
 * Start the Express HTTP transport. Called by the binary entry point
 * (`index.ts`) when launched with `--http`. Startup errors propagate to the
 * caller, which logs them and exits non-zero.
 */
export async function startHttpServer(): Promise<void> {
  // Initialize default client before starting server (optional - auth is per-session)
  await initializeDefaultClient();

  app.listen(PORT, () => {
    console.log(`OpenL MCP Server listening on port ${PORT}`);
  });
}
