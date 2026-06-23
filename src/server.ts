#!/usr/bin/env node

/**
 * Express HTTP Server for OpenL MCP Server
 *
 * Exposes the MCP protocol over the Streamable HTTP transport (MCP spec
 * 2025-11-25) at a single endpoint, `/mcp`, so the server can run as a
 * standalone microservice in Docker Compose. The legacy HTTP+SSE transport
 * and the REST helper endpoints are intentionally not provided.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { OpenLClient } from './client.js';
import { createConfiguredServer } from './mcp-core.js';
import { sanitizeError } from './utils.js';
import { logger } from './logger.js';
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
// They must be provided via MCP client configuration (Authorization header or query params).
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
 * Supports the three schemes the OpenL REST API accepts:
 * - `Token <PAT>`  → personal access token
 * - `Bearer <PAT>` → personal access token (MCP clients commonly send Bearer)
 * - `Basic <base64(user:pass)>` → username/password
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
  } else if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.substring(6), "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    if (sep > 0) {
      config.OPENL_USERNAME = decoded.substring(0, sep);
      config.OPENL_PASSWORD = decoded.substring(sep + 1);
    }
  }
  return config;
}

/**
 * Sensitive config keys that should never travel in a URL query string.
 * Query parameters routinely end up in proxy/access logs, browser history,
 * and Referer headers — see docs/guides/authentication.md.
 */
const SENSITIVE_QUERY_KEYS = ["OPENL_PERSONAL_ACCESS_TOKEN", "OPENL_PASSWORD"] as const;

/**
 * Emit a deprecation/security warning when credentials arrive via URL query
 * parameters. Passing secrets in the query string is still honored for
 * backward compatibility and local development, but the `Authorization` header
 * is the secure path. Never logs the secret value itself — only which keys
 * were present, so the warning is safe to keep in production logs.
 */
function warnIfSecretsInQuery(query: Record<string, unknown>): void {
  const leaked = SENSITIVE_QUERY_KEYS.filter((key) => query[key] !== undefined);
  if (leaked.length === 0) {
    return;
  }
  logger.warn(
    `Received credential(s) via URL query parameter (${leaked.join(", ")}). ` +
      "This is deprecated and insecure: query strings are commonly captured in " +
      "proxy/access logs, browser history, and Referer headers. Pass the token " +
      'via the "Authorization: Token <PAT>" header instead. ' +
      "See docs/guides/authentication.md.",
  );
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
 * authentication token is supplied per request, via:
 *   1. HTTP Authorization header (recommended): "Authorization: Token <PAT>",
 *      "Authorization: Bearer <PAT>", or "Authorization: Basic <base64 user:pass>".
 *   2. Query parameter: ?OPENL_PERSONAL_ACCESS_TOKEN=<PAT> — DEPRECATED and
 *      insecure (query strings leak into proxy/access logs, browser history,
 *      and Referer headers). Honored for backward compatibility / local
 *      development only; emits a warning.
 */
const handleMcpPost = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && streamableHttpTransports[sessionId]) {
      // Existing session — route to its transport.
      transport = streamableHttpTransports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session. Extract auth from the Authorization header (Token/Bearer/Basic),
      // then merge query params (base URL always comes from server config).
      warnIfSecretsInQuery(req.query as Record<string, unknown>);
      const configFromHeaders = authConfigFromHeader(req.headers.authorization);
      const configParams = { ...req.query, ...configFromHeaders } as Record<string, string | undefined>;

      const newSessionId = randomUUID();
      const client = getClientForSession(newSessionId, configParams);
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
 * Start the server
 */
async function startServer(): Promise<void> {
  // Initialize default client before starting server (optional - can use query params)
  await initializeDefaultClient();

  app.listen(PORT, () => {
    console.log(`OpenL MCP Server listening on port ${PORT}`);
  });
}

// Start the server
startServer().catch((error) => {
  console.error('❌ Failed to start server:', sanitizeError(error));
  process.exit(1);
});
