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
 * API endpoint paths relative to base URL
 */
export const API_ENDPOINTS = {
  /** List all design repositories */
  REPOSITORIES: "/repos",
} as const;

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
 * Tool categories for metadata organization
 */
export const TOOL_CATEGORIES = {
  SYSTEM: "system",
  REPOSITORY: "repository",
  PROJECT: "project",
  RULES: "rules",
  TRACE: "trace",
  VERSION_CONTROL: "version-control",
  DEPLOYMENT: "deployment",
} as const;

/**
 * Server information
 */
export const SERVER_INFO = {
  NAME: "openl-mcp-server",
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

