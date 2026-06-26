/**
 * Constants and configuration defaults for the OpenL MCP Server
 */

import { createRequire } from "node:module";

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
  /** Authorization header */
  AUTHORIZATION: "Authorization",
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
 * Server identity — name, version, and description — sourced from the package's
 * own package.json so there is a single source of truth. `npm view`, the
 * published tarball, the MCP `initialize` handshake, the HTTP `/health` probe,
 * and the CLI banner/`--version` then all report identical values.
 *
 * Read once at load via `createRequire`, not a static `import ... from
 * "../package.json"`: `rootDir` is `src/`, so a static import would pull a file
 * outside the root and scramble the emitted `dist/` layout. The relative path
 * resolves to the package root from both `dist/constants.js` (production) and
 * `src/constants.ts` (ts-jest), since each sits one level below the root.
 *
 * The fallbacks apply only when package.json can't be resolved (unusual install
 * layouts); MCP requires a non-empty `version`, so it is never left undefined.
 */
const pkg: { name?: string; version?: string; description?: string } = (() => {
  try {
    return createRequire(import.meta.url)("../package.json");
  } catch {
    return {};
  }
})();

export const SERVER_INFO = {
  NAME: pkg.name ?? "openl-mcp",
  VERSION: pkg.version ?? "0.0.0",
  DESCRIPTION: pkg.description ?? "MCP Server for OpenL Studio Rules Management System",
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

