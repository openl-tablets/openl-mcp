/**
 * Constants and configuration defaults for the OpenL MCP Server
 */

/**
 * Default configuration values
 */
export const DEFAULTS = {
  /** Default timeout for HTTP requests (30 seconds) */
  TIMEOUT: 30000,
} as const;

/**
 * Repository identifier for local (non-remote) repositories.
 * Projects in repository "local" are stored only on the server; status change (open/save/close) is not supported by the API.
 */
export const REPOSITORY_LOCAL = "local";

/** Error message when an operation is attempted on a project in a local repository */
export const ERROR_LOCAL_REPOSITORY =
  "Project is in a local repository (repository: 'local'). " +
  "Local repositories are not connected to a remote Git; changing project status (open, save, close) is not supported. " +
  "Use projects from a design repository connected to a remote Git.";

/**
 * HTTP headers
 */
export const HEADERS = {
  /** Content type for JSON requests */
  CONTENT_TYPE_JSON: "application/json",

  /** Authorization header */
  AUTHORIZATION: "Authorization",

  /** Client Document ID for request tracking (audit/debug). Set via OPENL_CLIENT_DOCUMENT_ID env. */
  CLIENT_DOCUMENT_ID: "Client-Document-Id",
} as const;

/**
 * The MCP namespace prefix exposed to clients (e.g. `openl_list_repositories`).
 * It exists only to keep this server's tools distinct from other MCP servers'
 * tools in a client connected to several at once.
 *
 * It is purely a PROTOCOL-BOUNDARY concern. The internal tool registry, the CLI,
 * and the REST API all use bare names (`list_repositories`); only the MCP
 * `tools/list` and `tools/call` handlers add and strip the prefix — via
 * {@link mcpToolName} and {@link stripToolPrefix} — so the namespace lives in
 * exactly one place and never leaks into the registry.
 */
export const TOOL_PREFIX = "openl_";

/** Add the namespace prefix to a bare registry name for the MCP wire (`list_repositories` → `openl_list_repositories`). */
export function mcpToolName(base: string): string {
  return `${TOOL_PREFIX}${base}`;
}

/** Strip the namespace prefix off an MCP wire name back to the bare registry name; returns the input unchanged when it carries no prefix. Inverse of {@link mcpToolName}. */
export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

/**
 * Display categories for grouping tools in the CLI `--help` catalog, in the
 * order they should appear. Each tool declares its category directly on its
 * ToolDefinition, so the CLI groups by that field rather than guessing from
 * the tool name.
 */
export const TOOL_CATEGORIES = [
  "Repository",
  "Project",
  "Rules & Tables",
  "Project Files",
  "Trace",
  "Deployment",
] as const;

/** A tool's display category — one of {@link TOOL_CATEGORIES}. */
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/**
 * Server information
 */
export const SERVER_INFO = {
  NAME: "openl-mcp",
  VERSION: "1.0.0",
  DESCRIPTION: "Model Context Protocol server for OpenL Studio",
} as const;

/**
 * Response formatting limits
 */
export const RESPONSE_LIMITS = {
  /** Maximum response character count (~25,000) */
  MAX_CHARACTERS: 25000,

  /** Truncation warning message */
  TRUNCATION_MESSAGE: "Response truncated due to size. Use limit/offset parameters or narrower filters to retrieve full data.",
} as const;

