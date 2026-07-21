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

/**
 * Inbound JSON body cap for the HTTP / Streamable HTTP transport. Express's
 * default is 100 KB, which a large tool-call argument — a trace `inputJson`
 * (a rating census / policy object) or a table payload — can exceed, and the
 * request is then rejected with HTTP 413 before it ever reaches the MCP handler.
 * Raised to 5 MB; override with MCP_MAX_BODY_SIZE (e.g. "10mb"). This does not
 * affect the stdio transport, which is unbounded. It also cannot lift a client's
 * own output-size limit (an agent's max tool-call size lives on the client side).
 */
const DEFAULT_MAX_BODY_SIZE = "5mb";

/**
 * Validate MCP_MAX_BODY_SIZE before it reaches express.json(). A raw value is
 * dangerous: body-parser's bytes() reads an unknown-unit string ("unlimited") as
 * null → NO limit (a memory-exhaustion DoS the 100 KB default prevented), and a
 * spelled-out or space-separated unit ("5 megabytes") as a handful of BYTES → every
 * real request 413s. So trim, accept only a plain byte count or a number + size
 * unit (matching what bytes() understands), and otherwise warn and fall back.
 */
function resolveMaxBodySize(): string {
  const raw = process.env.MCP_MAX_BODY_SIZE?.trim();
  if (!raw) return DEFAULT_MAX_BODY_SIZE;
  if (/^\d+$/.test(raw) || /^\d+(\.\d+)?\s*(b|kb|mb|gb|tb|pb)$/i.test(raw)) return raw;
  console.warn(
    `⚠️  Ignoring invalid MCP_MAX_BODY_SIZE "${raw}" — falling back to ${DEFAULT_MAX_BODY_SIZE}. ` +
      `Use a byte count (e.g. 5242880) or a number with a unit (e.g. "5mb").`,
  );
  return DEFAULT_MAX_BODY_SIZE;
}

const MAX_BODY_SIZE = resolveMaxBodySize();

// Middleware
app.use(cors());
app.use(express.json({ limit: MAX_BODY_SIZE }));

// Initialize OpenL client (default from environment)
let defaultClient: OpenLClient | null = null;

// Store clients by session ID (for per-session configuration)
const clientsBySession: Record<string, OpenLClient> = {};
const NO_DEFAULT_CLIENT_ERROR =
  "No OpenL client available. Provide the OpenL Studio base URL as a positional " +
  "argument (openl-mcp <url> --http) or via the OPENL_BASE_URL environment variable.";

function getDefaultClientOrThrow(): OpenLClient {
  if (!defaultClient) {
    throw new Error(NO_DEFAULT_CLIENT_ERROR);
  }
  return defaultClient;
}

/**
 * Resolve the OpenL base URL for the HTTP transport.
 *
 * An explicit `override` — the positional `<url>` / `--base-url` forwarded by
 * the binary's dispatcher (`index.ts`) — wins over the `OPENL_BASE_URL`
 * environment variable, matching the stdio transport and the documented
 * precedence (positional `<url>` > `--base-url` > `OPENL_BASE_URL`).
 *
 * Returns `undefined` when no base URL is configured, or when the configured
 * value is not a valid absolute URL (logging a warning in that case). The
 * server still starts; tool calls then report {@link NO_DEFAULT_CLIENT_ERROR}
 * until a base URL is supplied.
 */
export function resolveHttpBaseUrl(override?: string): string | undefined {
  const baseUrl = override ?? process.env.OPENL_BASE_URL;
  if (!baseUrl) {
    return undefined;
  }
  try {
    new URL(baseUrl);
  } catch {
    console.error(`⚠️  Invalid OpenL base URL: ${baseUrl}`);
    return undefined;
  }
  return baseUrl;
}

// Initialize default OpenL client (async - will be awaited before server starts)
// NOTE: Authentication credentials should NOT be set in Docker/environment variables.
// They must be provided per session via the MCP client's Authorization header.
async function initializeDefaultClient(baseUrlOverride?: string): Promise<void> {
  try {
    // Resolve the base URL (override wins over OPENL_BASE_URL) but don't require
    // authentication: the server starts without auth, which is provided per
    // session via the Authorization header.
    const baseUrl = resolveHttpBaseUrl(baseUrlOverride);
    if (!baseUrl) {
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
      const sessionServer = createConfiguredServer(client);

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

/** Configuration overrides forwarded to the HTTP transport by the dispatcher. */
export interface HttpServerOverrides {
  /** Base URL from the positional `<url>` / `--base-url`; wins over the env var. */
  baseUrl?: string;
}

/**
 * Start the Express HTTP transport. Called by the binary entry point
 * (`index.ts`) when launched with `--http`. The base URL is resolved from
 * `overrides.baseUrl` (the positional `<url>` / `--base-url`) first, then the
 * `OPENL_BASE_URL` environment variable. Startup errors propagate to the
 * caller, which logs them and exits non-zero.
 */
export async function startHttpServer(overrides: HttpServerOverrides = {}): Promise<void> {
  // Initialize default client before starting server (optional - auth is per-session)
  await initializeDefaultClient(overrides.baseUrl);

  app.listen(PORT, () => {
    console.log(`OpenL MCP Server listening on port ${PORT}`);
  });
}
