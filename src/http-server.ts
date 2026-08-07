/**
 * Express HTTP transport for OpenL MCP Server.
 *
 * The `/mcp` endpoint serves both protocol eras: modern MCP 2026-07-28 via
 * `createMcpHandler`, and sessionful 2025-era clients through the legacy
 * Streamable HTTP transport. Browser origins are denied unless explicitly
 * allowlisted.
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import { OpenLClient } from "./client.js";
import { createConfiguredServer } from "./mcp-core.js";
import { sanitizeError } from "./utils.js";
import { SERVER_INFO } from "./constants.js";

const DEFAULT_PORT = "3000";
const DEFAULT_MAX_BODY_SIZE = "5mb";
const MCP_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const MCP_ALLOWED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Last-Event-ID",
  "MCP-Protocol-Version",
  "Mcp-Method",
  "Mcp-Name",
  "Mcp-Session-Id",
].join(", ");

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

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

/** Resolve and validate the OpenL base URL used by HTTP request clients. */
export function resolveHttpBaseUrl(override?: string): string | undefined {
  const baseUrl = override ?? process.env.OPENL_BASE_URL;
  if (!baseUrl) return undefined;
  try {
    new URL(baseUrl);
  } catch {
    console.error(`⚠️  Invalid OpenL base URL: ${baseUrl}`);
    return undefined;
  }
  return baseUrl;
}

function normalizeConfiguredOrigin(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid MCP_ALLOWED_ORIGINS entry: ${trimmed}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
  ) {
    throw new Error(
      `Invalid MCP_ALLOWED_ORIGINS entry: ${trimmed}. Use an exact http(s) origin without a path.`,
    );
  }
  return parsed.origin;
}

/**
 * Browser origins allowed to call `/mcp`.
 *
 * Non-browser clients normally omit `Origin` and are unaffected. The default
 * admits only a browser page served from the MCP server's own loopback port;
 * deployments with a separate web client must enumerate its exact origins in
 * `MCP_ALLOWED_ORIGINS` (comma-separated).
 */
export function resolveAllowedOrigins(
  raw = process.env.MCP_ALLOWED_ORIGINS,
  port = process.env.PORT ?? DEFAULT_PORT,
): ReadonlySet<string> {
  const configured = raw?.trim()
    ? raw.split(",")
    : [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  return new Set(configured.map(normalizeConfiguredOrigin));
}

/** Exact-origin check used by the HTTP middleware and unit tests. */
export function isAllowedHttpOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).origin === origin && allowed.has(origin);
  } catch {
    return false;
  }
}

function mcpCorsMiddleware(allowedOrigins: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    const origin = req.headers.origin;
    if (!isAllowedHttpOrigin(origin, allowedOrigins)) {
      return res.status(403).json(jsonRpcError(-32000, "Forbidden: Origin is not allowed"));
    }

    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", MCP_ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", MCP_ALLOWED_HEADERS);
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

function tokenFromAuthorizationHeader(authHeader: string | string[] | undefined): string | undefined {
  if (typeof authHeader !== "string") return undefined;
  const match = /^(?:Token|Bearer)\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1] || undefined;
}

/** Construct a new Studio HTTP session; never share anonymous mutable state. */
export function createHttpSessionClient(baseUrl: string, authHeader?: string | string[]): OpenLClient {
  return new OpenLClient({
    baseUrl,
    personalAccessToken: tokenFromAuthorizationHeader(authHeader),
  });
}

export interface HttpServerOverrides {
  /** Base URL from the positional `<url>` / `--base-url`; wins over the env var. */
  baseUrl?: string;
  /** Test/deployment override; otherwise `MCP_ALLOWED_ORIGINS` is used. */
  allowedOrigins?: ReadonlySet<string>;
  /** Test seam for verifying request/session isolation. */
  clientFactory?: typeof createHttpSessionClient;
}

/** Build the Express app without binding a port, enabling in-process tests. */
export function createHttpApp(overrides: HttpServerOverrides = {}): Express {
  const app = express();
  const baseUrl = resolveHttpBaseUrl(overrides.baseUrl);
  const allowedOrigins = overrides.allowedOrigins ?? resolveAllowedOrigins();
  const clientFactory = overrides.clientFactory ?? createHttpSessionClient;
  const requireBaseUrl = (): string => {
    if (!baseUrl) {
      throw new Error(
        "No OpenL client available. Provide the OpenL Studio base URL as a positional " +
          "argument (openl-mcp <url> --http) or via OPENL_BASE_URL.",
      );
    }
    return baseUrl;
  };

  app.use("/mcp", mcpCorsMiddleware(allowedOrigins));
  app.use(express.json({ limit: resolveMaxBodySize() }));

  // Modern 2026-07-28 is stateless at the protocol layer. A fresh OpenLClient
  // per request prevents cookies, test headers, trace state and caches from
  // leaking between anonymous callers.
  const modernHandler = createMcpHandler(
    (ctx) => createConfiguredServer(
      clientFactory(requireBaseUrl(), ctx.requestInfo?.headers.get("authorization") ?? undefined),
    ),
    {
      legacy: "reject",
      onerror: (error) => console.error("MCP modern transport error:", sanitizeError(error)),
    },
  );
  const modernNodeHandler = toNodeHandler(modernHandler, {
    onerror: (error) => console.error("MCP Node adapter error:", sanitizeError(error)),
  });

  // Legacy 2025 clients retain their sessionful transport because several
  // Studio workflows are session-bound. Each MCP session owns a distinct
  // OpenLClient — including anonymous sessions.
  const legacyTransports = new Map<string, NodeStreamableHTTPServerTransport>();

  const handleLegacyPost = async (req: Request, res: Response): Promise<Response | void> => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? legacyTransports.get(sessionId) : undefined;

      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        const newSessionId = randomUUID();
        const client = clientFactory(requireBaseUrl(), req.headers.authorization);
        const sessionServer = createConfiguredServer(client);
        const createdTransport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (id) => {
            legacyTransports.set(id, createdTransport);
          },
        });
        transport = createdTransport;
        createdTransport.onclose = () => {
          if (createdTransport.sessionId) legacyTransports.delete(createdTransport.sessionId);
        };
        await sessionServer.connect(transport);
      } else if (!transport) {
        const status = sessionId ? 404 : 400;
        return res.status(status).json(jsonRpcError(-32000, "Invalid or missing MCP session ID"));
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Failed to handle legacy MCP request:", sanitizeError(error));
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
    }
  };

  const handleLegacySession = async (req: Request, res: Response): Promise<Response | void> => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const transport = sessionId ? legacyTransports.get(sessionId) : undefined;
      if (!transport) {
        return res.status(404).json(jsonRpcError(-32000, "Invalid or missing MCP session ID"));
      }
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Failed to handle legacy MCP session request:", sanitizeError(error));
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
    }
  };

  app.all("/mcp", async (req: Request, res: Response): Promise<Response | void> => {
    const webRequest = await toWebRequest(req, req.body);
    if (await isLegacyRequest(webRequest)) {
      return req.method === "POST" ? handleLegacyPost(req, res) : handleLegacySession(req, res);
    }
    await modernNodeHandler(req, res, req.body);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: SERVER_INFO.NAME,
      version: SERVER_INFO.VERSION,
    });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", sanitizeError(err));
    res.status(500).json({ error: "Internal server error", message: sanitizeError(err) });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Not found", path: req.path, method: req.method });
  });

  return app;
}

/** Start the Express HTTP transport. */
export async function startHttpServer(overrides: HttpServerOverrides = {}): Promise<void> {
  const port = process.env.PORT || DEFAULT_PORT;
  const app = createHttpApp(overrides);
  app.listen(port, () => {
    console.log(`OpenL MCP Server listening on port ${port}`);
  });
}
