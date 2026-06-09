/**
 * OpenL MCP Server — CLI mode
 *
 * Lets users invoke any registered `openl_*` tool directly from the shell
 * without an MCP client. Reuses the existing `executeTool` registry from
 * `tool-handlers.ts`, so every tool the MCP server exposes is available here
 * with the same input schemas, validation, and response formatting.
 *
 * Usage:
 *   npx -y openl-mcp-server <tool-name> [<json-args> | @file.json | --stdin] [flags]
 *   npx -y openl-mcp-server --help
 *   npx -y openl-mcp-server --list-tools
 *
 * Config (env vars, can be overridden by CLI flags):
 *   OPENL_BASE_URL                (required)  → --base-url <url>
 *   OPENL_PERSONAL_ACCESS_TOKEN   (auth)      → --token <pat>
 *   OPENL_USERNAME / OPENL_PASSWORD (auth)    → --user <u> / --password <p>
 *   OPENL_TIMEOUT                 (optional)  → --timeout <ms>
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { OpenLClient } from "./client.js";
import { SERVER_INFO } from "./constants.js";
import { executeTool, getAllTools, registerAllTools } from "./tool-handlers.js";
import { hashFingerprint, sanitizeError } from "./utils.js";
import type * as Types from "./types.js";

/**
 * Package version read from the npm package's `package.json` at module load.
 * `SERVER_INFO.VERSION` advertises the MCP protocol/server capability version
 * (semantically distinct from the npm release number), so `--version` reads
 * the package.json value to match what `npm view openl-mcp-server version`
 * and the installed tarball will report.
 *
 * Falls back to `SERVER_INFO.VERSION` if package.json can't be resolved
 * (e.g. during certain test runs or unusual install layouts).
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    return pkg.version ?? SERVER_INFO.VERSION;
  } catch {
    return SERVER_INFO.VERSION;
  }
})();

/**
 * Exit codes following BSD `sysexits.h` conventions. Lets CI/CD pipelines
 * distinguish "bad args, don't retry" from "API down, retry might work".
 *
 * Reference: https://man7.org/linux/man-pages/man3/sysexits.h.3head.html
 */
export const EXIT_CODES = {
  /** Successful execution. */
  OK: 0,
  /** Unclassified failure. */
  GENERIC: 1,
  /** Bad CLI arguments / flag usage. */
  USAGE: 64,
  /** Bad input data (e.g. malformed JSON in args). */
  DATAERR: 65,
  /** Service unavailable (ECONNREFUSED, ETIMEDOUT, DNS failure). */
  UNAVAILABLE: 69,
  /** Authentication / authorization failure (401, 403). */
  NOPERM: 77,
  /** Missing or invalid configuration. */
  CONFIG: 78,
} as const;

/**
 * Custom error carrying an explicit exit code. Thrown from CLI-level code
 * (config building, argument resolution) to surface a precise classification
 * up to the top-level catch in `runCli`.
 */
export class CliError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Classify an error from `executeTool` (or any unknown source) into a
 * `sysexits.h` exit code, by inspecting message patterns / error codes.
 *
 * The OpenL client wraps API errors as `MCP error -326xx: ... (HTTP STATUS)
 * [METHOD /path]` — we extract status via regex. Network failures (axios
 * `error.code`) bubble up as `ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND` in the
 * message. Anything we can't classify falls back to GENERIC.
 */
export function classifyError(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  const msg = error instanceof Error ? error.message : String(error);

  // Network / connectivity → UNAVAILABLE
  if (/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b/.test(msg)) {
    return EXIT_CODES.UNAVAILABLE;
  }

  // Extract the HTTP status code and classify by it. The OpenL client wraps
  // API errors as "OpenL Studio API error (NNN): ..."; axios also emits
  // "Request failed with status code NNN". Match whichever form is present.
  const statusMatch = msg.match(/\((\d{3})\)/) ?? msg.match(/status code (\d{3})/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401 || status === 403) return EXIT_CODES.NOPERM; // auth/permission
    if (status >= 500 && status <= 599) return EXIT_CODES.UNAVAILABLE; // server down/unhealthy
  }
  return EXIT_CODES.GENERIC;
}

/**
 * Options for `runCli`. Stdio and env are injectable for testability.
 */
export interface RunCliOptions {
  /** Args after `node script.js` (i.e. `process.argv.slice(2)`). */
  argv: string[];
  /** Environment variables. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Readable stream for `--stdin`. Defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
  /** Where to write tool output. Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Where to write diagnostics and errors. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /** Inject a custom client (for tests). */
  clientFactory?: (config: Types.OpenLConfig) => OpenLClient;
}

/** Parsed shape of CLI arguments. */
interface ParsedArgs {
  toolName?: string;
  inlineJson?: string;
  fileArg?: string;
  useStdin: boolean;
  showHelp: boolean;
  showVersion: boolean;
  listTools: boolean;
  anonymous: boolean;
  cookieJarPath?: string;
  overrides: {
    baseUrl?: string;
    token?: string;
    username?: string;
    password?: string;
    timeout?: number;
    clientDocumentId?: string;
  };
  errors: string[];
}

/**
 * Parse argv into a `ParsedArgs` record. No I/O. No throwing — errors are
 * collected and returned for the caller to render.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    useStdin: false,
    showHelp: false,
    showVersion: false,
    listTools: false,
    anonymous: false,
    overrides: {},
    errors: [],
  };

  const takeValue = (i: number, flag: string): string | undefined => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      result.errors.push(`Flag ${flag} requires a value`);
      return undefined;
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "-h":
      case "--help":
        result.showHelp = true;
        break;
      case "-V":
      case "--version":
        result.showVersion = true;
        break;
      case "--list-tools":
        result.listTools = true;
        break;
      case "--stdin":
        result.useStdin = true;
        break;
      case "--anonymous":
        result.anonymous = true;
        break;
      case "--base-url":
        result.overrides.baseUrl = takeValue(i, arg);
        i++;
        break;
      case "--token":
        result.overrides.token = takeValue(i, arg);
        i++;
        break;
      case "--user":
      case "--username":
        result.overrides.username = takeValue(i, arg);
        i++;
        break;
      case "--password":
        result.overrides.password = takeValue(i, arg);
        i++;
        break;
      case "--timeout": {
        const raw = takeValue(i, arg);
        i++;
        if (raw !== undefined) {
          const parsed = Number.parseInt(raw, 10);
          if (Number.isNaN(parsed) || parsed <= 0) {
            result.errors.push(`Invalid --timeout value: ${raw}`);
          } else {
            result.overrides.timeout = parsed;
          }
        }
        break;
      }
      case "--client-document-id":
        result.overrides.clientDocumentId = takeValue(i, arg);
        i++;
        break;
      case "--cookie-jar":
        result.cookieJarPath = takeValue(i, arg);
        i++;
        break;
      default:
        if (arg.startsWith("@")) {
          if (result.fileArg) {
            result.errors.push(`Multiple @file arguments are not allowed`);
          } else {
            result.fileArg = arg.slice(1);
          }
        } else if (arg.startsWith("{") || arg.startsWith("[")) {
          if (result.inlineJson) {
            result.errors.push(`Multiple inline JSON arguments are not allowed`);
          } else {
            result.inlineJson = arg;
          }
        } else if (arg.startsWith("--")) {
          result.errors.push(`Unknown flag: ${arg}`);
        } else if (!result.toolName) {
          result.toolName = arg;
        } else {
          result.errors.push(`Unexpected positional argument: ${arg}`);
        }
        break;
    }
  }

  // Source of args is mutually exclusive
  const sources = [result.inlineJson, result.fileArg, result.useStdin ? "stdin" : undefined].filter(Boolean);
  if (sources.length > 1) {
    result.errors.push(`Provide tool arguments via only one of: inline JSON, @file, or --stdin`);
  }

  return result;
}

/**
 * Read raw text from a stream until EOF. Used for `--stdin` JSON input.
 */
async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Resolve tool arguments from inline JSON / @file / --stdin / nothing.
 * Returns the parsed value or `undefined` if no args were provided.
 */
async function resolveToolArgs(
  parsed: ParsedArgs,
  stdin: NodeJS.ReadableStream,
): Promise<unknown> {
  let raw: string | undefined;

  if (parsed.inlineJson) {
    raw = parsed.inlineJson;
  } else if (parsed.fileArg) {
    raw = await readFile(parsed.fileArg, "utf-8");
  } else if (parsed.useStdin) {
    raw = await readStream(stdin);
  }

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse tool arguments as JSON: ${(error as Error).message}`);
  }
}

/**
 * Build an `OpenLConfig` from env + CLI overrides. Validates that base URL
 * and at least one auth method are present.
 */
function buildConfig(
  env: NodeJS.ProcessEnv,
  overrides: ParsedArgs["overrides"],
  allowAnonymous = false,
): Types.OpenLConfig {
  const baseUrl = overrides.baseUrl ?? env.OPENL_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "OPENL_BASE_URL is required (set the env var or pass --base-url <url>)",
    );
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }

  const username = overrides.username ?? env.OPENL_USERNAME;
  const password = overrides.password ?? env.OPENL_PASSWORD;
  const personalAccessToken = overrides.token ?? env.OPENL_PERSONAL_ACCESS_TOKEN;

  // By default a CLI invocation represents one principal who must authenticate,
  // so we fail fast on missing credentials (this catches the common "forgot to
  // set creds" mistake with a clear message instead of a later 401). The
  // `--anonymous` flag opts out for servers that permit unauthenticated access:
  // the gate is skipped and, if no creds are supplied, the client sends no
  // Authorization header. Any creds that *are* present are still used.
  if (!allowAnonymous && !personalAccessToken && !(username && password)) {
    throw new Error(
      "Authentication required: set OPENL_PERSONAL_ACCESS_TOKEN (or --token), " +
        "or both OPENL_USERNAME/OPENL_PASSWORD (or --user/--password). " +
        "Pass --anonymous if the server allows unauthenticated access.",
    );
  }

  let timeout = overrides.timeout;
  if (timeout === undefined && env.OPENL_TIMEOUT) {
    const parsed = Number.parseInt(env.OPENL_TIMEOUT, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid OPENL_TIMEOUT value: ${env.OPENL_TIMEOUT}`);
    }
    timeout = parsed;
  }

  return { baseUrl, username, password, personalAccessToken, timeout };
}

/**
 * A cookie-jar entry binds a persisted JSESSIONID to the server and principal
 * it was issued for, so it is never replayed across a different host or user.
 */
interface CookieJarData {
  /** Normalized studio base URL the session belongs to (client.getBaseUrl()). */
  baseUrl: string;
  /** sha256 fingerprint of the Authorization header (the principal). */
  authFingerprint: string;
  /** The JSESSIONID value. */
  jsessionId: string;
}

/**
 * Studio session ids are opaque alphanumerics; reject anything else so a
 * tampered jar can't inject extra Cookie-header directives when replayed.
 */
function isValidJSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Compute the binding (server + principal) for the current invocation. A
 * persisted JSESSIONID is only restored when its stored binding matches this.
 */
function computeCookieBinding(client: OpenLClient): { baseUrl: string; authFingerprint: string } {
  return {
    baseUrl: client.getBaseUrl(),
    authFingerprint: hashFingerprint(client.getAuthorizationHeader() ?? "anonymous"),
  };
}

/**
 * Load a previously persisted JSESSIONID from a cookie-jar file — but only when
 * it was saved for the SAME base URL and principal as the current invocation,
 * so a session never leaks across hosts or users.
 *
 * Returns `null` (fresh session) for a missing/unreadable file, the legacy
 * bare-cookie format (no binding to verify), a binding mismatch, or an invalid
 * session id. Non-fatal cases emit a stderr warning so the user notices.
 */
async function loadCookieJar(
  path: string,
  binding: { baseUrl: string; authFingerprint: string },
  stderr: NodeJS.WritableStream,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // first run — no jar yet
    stderr.write(
      `Warning: could not read cookie jar at ${path}: ${(error as Error).message}\n`,
    );
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let data: Partial<CookieJarData> | null = null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      data = parsed as Partial<CookieJarData>;
    }
  } catch {
    // Legacy format (a bare JSESSIONID line) carried no server/principal
    // binding, so we cannot verify it belongs here — discard rather than replay.
    stderr.write(
      `Warning: ignoring legacy cookie jar at ${path} (no server/user binding); starting a fresh session.\n`,
    );
    return null;
  }

  if (!data || typeof data.jsessionId !== "string" || !isValidJSessionId(data.jsessionId)) {
    stderr.write(
      `Warning: ignoring malformed cookie jar at ${path}; starting a fresh session.\n`,
    );
    return null;
  }
  if (data.baseUrl !== binding.baseUrl || data.authFingerprint !== binding.authFingerprint) {
    stderr.write(
      `Warning: ignoring cookie jar at ${path}: it was saved for a different server or user; starting a fresh session.\n`,
    );
    return null;
  }
  return data.jsessionId;
}

/**
 * Persist the client's current JSESSIONID to the cookie-jar file with 0600
 * permissions, bound to the current base URL and principal so a later run only
 * replays it for the same server+user. Best-effort: write failures emit a
 * warning but do not fail the tool invocation.
 *
 * When the client has no session cookie (e.g. the tool hit only stateless
 * endpoints), no file is written.
 */
async function saveCookieJar(
  path: string,
  cookie: string | null,
  binding: { baseUrl: string; authFingerprint: string },
  stderr: NodeJS.WritableStream,
): Promise<void> {
  if (cookie === null) return;
  if (!isValidJSessionId(cookie)) {
    stderr.write(
      `Warning: not persisting cookie jar at ${path}: unexpected session id format.\n`,
    );
    return;
  }
  const data: CookieJarData = {
    baseUrl: binding.baseUrl,
    authFingerprint: binding.authFingerprint,
    jsessionId: cookie,
  };
  try {
    await writeFile(path, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  } catch (error) {
    stderr.write(
      `Warning: could not write cookie jar at ${path}: ${(error as Error).message}\n`,
    );
  }
}

/**
 * CLI mode is **agent-first**: the primary consumer is an LLM agent that
 * shells out to this binary, and LLMs read markdown more naturally (and more
 * token-efficiently) than escaped JSON. So the CLI inherits the same default
 * `response_format` as the MCP server — markdown — by NOT overriding it here.
 *
 * Callers (human or agent) who want machine-parseable output pass
 * `response_format: "json"` explicitly, e.g. for piping into `jq`.
 *
 * Kept as a single documented seam: if the CLI's format policy ever needs to
 * diverge from the handler default again, change it here only.
 */
function applyDefaultResponseFormat(args: unknown): unknown {
  return args;
}

/**
 * Suppress informational stderr logs from the OpenL client / auth manager
 * (e.g. `[Auth] 🔐 Basic Auth: username=...`) while the CLI is running.
 *
 * These are useful in MCP-stdio mode but pollute shell pipelines — and
 * leak the username when it was passed via `--user`. We flip
 * `OPENL_CLI_QUIET=1` on `process.env` (which the auth manager reads
 * directly via `parseBoolEnv`); the returned closure restores the prior
 * value so callers can clean up after themselves. Genuine error logs are
 * never gated by this flag.
 *
 * Note: only `process.env` matters here — the injected `env` in
 * `RunCliOptions` is for our own config reads (base URL, credentials),
 * but `auth.ts` looks at the real `process.env` because it can't see
 * our `RunCliOptions`. So we mutate the real env, not the injected one.
 */
function setQuietMode(): () => void {
  const prev = process.env.OPENL_CLI_QUIET;
  process.env.OPENL_CLI_QUIET = "1";
  return () => {
    if (prev === undefined) delete process.env.OPENL_CLI_QUIET;
    else process.env.OPENL_CLI_QUIET = prev;
  };
}

/**
 * Apply CLI-flag overrides for env-driven config (`--client-document-id`).
 * Mutates `process.env` because downstream interceptors read it directly;
 * returns a restore function so callers can clean up after themselves.
 */
function applyEnvOverrides(overrides: ParsedArgs["overrides"]): () => void {
  if (overrides.clientDocumentId === undefined) return () => {};
  const prev = process.env.OPENL_CLIENT_DOCUMENT_ID;
  process.env.OPENL_CLIENT_DOCUMENT_ID = overrides.clientDocumentId;
  return () => {
    if (prev === undefined) delete process.env.OPENL_CLIENT_DOCUMENT_ID;
    else process.env.OPENL_CLIENT_DOCUMENT_ID = prev;
  };
}

/**
 * Map a tool name to a human-readable category for `--help` grouping.
 *
 * `tool-handlers.ts` doesn't carry a category field on its ToolDefinition
 * (the parallel `tools.ts` has `_meta.category` but isn't the runtime source
 * of truth), so we derive the category from the tool name. Patterns mirror
 * the section comments in `tool-handlers.ts` (`Repository Tools`,
 * `Project Tools`, …).
 */
function categoryOf(toolName: string): string {
  if (/^openl_(list_repositories|list_branches|list_repository_features|repository_project_revisions|list_deploy_repositories)$/.test(toolName)) {
    return "Repository";
  }
  if (/^openl_(start_trace|cancel_trace|export_trace|get_trace_)/.test(toolName)) {
    return "Trace";
  }
  if (/^openl_(list_tables|get_table|update_table|append_table|create_project_table|execute_rule)$/.test(toolName)) {
    return "Rules & Tables";
  }
  if (/^openl_(read|write|delete|search|copy|move)_project_file(s)?$/.test(toolName)) {
    return "Project Files";
  }
  if (/^openl_(get_project_history|get_file_history|revert_version)$/.test(toolName)) {
    return "Version Control";
  }
  if (/^openl_(list_deployments|deploy_project|redeploy_project)$/.test(toolName)) {
    return "Deployment";
  }
  if (/^openl_(list_projects|get_project|project_status|open_project|save_project|close_project|create_project|create_project_branch|list_project_local_changes|restore_project_local_change|upload_file|download_file|start_project_tests|get_test_results)/.test(toolName)) {
    return "Project";
  }
  return "Other";
}

/** Stable order in which category sections appear in `--help`. */
const CATEGORY_ORDER = [
  "Repository",
  "Project",
  "Rules & Tables",
  "Project Files",
  "Trace",
  "Version Control",
  "Deployment",
  "Other",
];

/**
 * Render help for a specific tool: title, description, and a human-readable
 * summary of its JSON Schema (properties, required, types, descriptions).
 * Returns `null` if the tool isn't registered.
 */
function renderToolHelp(toolName: string): string | null {
  const tool = getAllTools().find((t) => t.name === toolName);
  if (!tool) return null;

  const schema = tool.inputSchema as {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: unknown[]; default?: unknown }>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};

  const propLines = Object.entries(props).map(([name, def]) => {
    const flag = required.has(name) ? "required" : "optional";
    const type = def.type ?? "any";
    const enumPart = def.enum ? ` (one of: ${def.enum.join(", ")})` : "";
    const desc = def.description ? `\n      ${def.description}` : "";
    return `  ${name.padEnd(24)} ${type.padEnd(8)} [${flag}]${enumPart}${desc}`;
  });

  return [
    `${tool.name}  v${tool.version}`,
    tool.title ? `  ${tool.title}` : "",
    "",
    "Description:",
    `  ${tool.description}`,
    "",
    "Arguments:",
    propLines.length > 0 ? propLines.join("\n") : "  (none)",
    "",
    "Example:",
    `  npx -y openl-mcp-server ${tool.name} '{}'`,
    `  npx -y openl-mcp-server ${tool.name} @args.json`,
    `  echo '{...}' | npx -y openl-mcp-server ${tool.name} --stdin`,
    "",
    `Full JSON Schema: npx -y openl-mcp-server --list-tools | jq '.[] | select(.name=="${tool.name}")'`,
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

/**
 * Render help text listing usage and every registered tool, grouped by
 * category for readability (Repository / Project / Rules / Trace / ...).
 */
function renderHelp(): string {
  // Group tools by category, then render each section. The listing shows the
  // human-readable title (not the description) so the catalog stays scannable;
  // `<tool> --help` gives the full description + schema, and `--list-tools`
  // gives the machine-readable JSON.
  const byCategory = new Map<string, Array<{ name: string; title: string }>>();
  for (const t of getAllTools()) {
    const cat = categoryOf(t.name);
    let bucket = byCategory.get(cat);
    if (!bucket) {
      bucket = [];
      byCategory.set(cat, bucket);
    }
    bucket.push({ name: t.name, title: t.title ?? "" });
  }
  const sections: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    sections.push(`${cat}:`);
    for (const t of items) {
      sections.push(`  ${t.name.padEnd(42)} ${t.title}`);
    }
    sections.push("");
  }
  const tools = sections.join("\n").trimEnd();

  return [
    `${SERVER_INFO.NAME} v${SERVER_INFO.VERSION} — CLI mode`,
    ``,
    `Usage:`,
    `  openl-mcp <tool-name> [<json-args> | @file.json | --stdin] [flags]`,
    `  openl-mcp <tool-name> --help            # detailed help for a tool`,
    `  openl-mcp --list-tools                  # JSON schemas of all tools`,
    `  openl-mcp --help                        # this message`,
    `  openl-mcp --version                     # print version (-V)`,
    ``,
    `When no arguments are passed, the binary starts the MCP server on stdio`,
    `(legacy behavior for Claude Desktop / Cursor / other MCP clients).`,
    ``,
    `Argument sources (mutually exclusive):`,
    `  '{"foo":"bar"}'    inline JSON literal`,
    `  @path/args.json    load JSON from file`,
    `  --stdin            read JSON from stdin`,
    ``,
    `Config flags (override the matching env vars):`,
    `  --base-url <url>            OPENL_BASE_URL`,
    `  --token <pat>               OPENL_PERSONAL_ACCESS_TOKEN`,
    `  --user <name>               OPENL_USERNAME`,
    `  --password <pwd>            OPENL_PASSWORD`,
    `  --timeout <ms>              OPENL_TIMEOUT (default 30000)`,
    `  --client-document-id <id>   OPENL_CLIENT_DOCUMENT_ID (audit/tracking)`,
    `  --cookie-jar <path>         persist JSESSIONID between calls (needed`,
    `                              for trace flow across separate npx runs)`,
    `  --anonymous                 allow running without credentials (for`,
    `                              servers that permit unauthenticated access)`,
    ``,
    `Tip: complex tools (openl_update_table, openl_append_table, …) take`,
    `large structured JSON — pass it via @file.json or --stdin rather than`,
    `inline. On Windows cmd, prefer @file.json (single quotes won't work).`,
    ``,
    `Output: defaults to markdown (agent-friendly, same as the MCP server).`,
    `For machine-parseable output, pass "response_format":"json" in args:`,
    `  npx -y openl-mcp-server openl_list_repositories '{"response_format":"json"}' | jq`,
    ``,
    `Discovery:`,
    `  --help                      human-readable: this catalog of tool titles`,
    `  <tool> --help               human-readable: full description + arg schema`,
    `  --list-tools                machine-readable: JSON (name/title/description/schema)`,
    ``,
    `Examples:`,
    `  npx -y openl-mcp-server openl_list_repositories`,
    `  echo '{"projectId":"p","comment":"fix CA rates"}' | \\`,
    `    npx -y openl-mcp-server openl_save_project --stdin`,
    ``,
    `Available tools (${getAllTools().length}, grouped by category):`,
    tools,
    ``,
  ].join("\n");
}

/**
 * Lazily ensure the tool registry is populated. Safe to call repeatedly:
 * `registerAllTools` overwrites entries in its module-level map.
 */
let registered = false;
function ensureToolsRegistered(client: OpenLClient): void {
  if (registered) return;
  // Server arg is unused by registerAllTools (see tool-handlers.ts), but the
  // signature still requires a Server instance — pass a throwaway one.
  const server = new Server(
    { name: SERVER_INFO.NAME, version: SERVER_INFO.VERSION },
    { capabilities: {} },
  );
  registerAllTools(server, client);
  registered = true;
}

/**
 * Entry point for CLI mode. Returns the process exit code.
 *
 * Pure with respect to its `options` (no direct `process.*` reads) so tests
 * can drive it with injected env/stdin/stdout/stderr.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const env = options.env ?? process.env;

  const parsed = parseArgs(options.argv);

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`Error: ${err}\n`);
    stderr.write(`\nRun with --help for usage.\n`);
    return EXIT_CODES.USAGE;
  }

  // --version — single line, parseable, no config needed.
  // Uses the npm package.json version (not SERVER_INFO.VERSION which is the
  // MCP protocol version) so users see the actual installed release.
  if (parsed.showVersion) {
    stdout.write(`${SERVER_INFO.NAME} ${PACKAGE_VERSION}\n`);
    return EXIT_CODES.OK;
  }

  // Pure discovery commands — no config, no network, no tool registration
  // is needed beyond a stub client to satisfy the registry signature.
  if (parsed.showHelp || parsed.listTools) {
    ensureToolsRegistered(
      new OpenLClient({ baseUrl: "http://localhost", username: "_", password: "_" }),
    );
    if (parsed.showHelp) {
      // Tool-specific help: `<tool> --help` renders schema for that tool
      // instead of the global help. If the tool name is unknown, fall
      // through to a USAGE error.
      if (parsed.toolName) {
        const help = renderToolHelp(parsed.toolName);
        if (help === null) {
          stderr.write(`Error: Unknown tool: ${parsed.toolName}\n\nRun --list-tools to see available tools.\n`);
          return EXIT_CODES.USAGE;
        }
        stdout.write(help);
        return EXIT_CODES.OK;
      }
      stdout.write(renderHelp());
    } else {
      const summary = getAllTools().map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        version: t.version,
        inputSchema: t.inputSchema,
      }));
      stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
    return EXIT_CODES.OK;
  }

  // Tool-name validation is a USAGE concern and needs neither config nor the
  // network — run it *before* buildConfig so a typo'd tool returns EX_USAGE
  // even when OPENL_BASE_URL/auth are also missing (otherwise the config
  // error would mask the typo). A stub client satisfies the registry
  // signature; the real client is wired in below for execution.
  ensureToolsRegistered(
    new OpenLClient({ baseUrl: "http://localhost", username: "_", password: "_" }),
  );

  if (!parsed.toolName) {
    stderr.write(`Error: tool name is required\n\nRun with --help for usage.\n`);
    return EXIT_CODES.USAGE;
  }

  // Unknown tool is a user-typed-wrong-name case → EX_USAGE (consistent with
  // the `<tool> --help` path). Without this pre-check, the error would surface
  // from executeTool as an MCP error and misclassify as GENERIC (1).
  if (!getAllTools().some((t) => t.name === parsed.toolName)) {
    stderr.write(
      `Error: Unknown tool: ${parsed.toolName}\n\nRun --list-tools to see available tools.\n`,
    );
    return EXIT_CODES.USAGE;
  }

  const restoreQuiet = setQuietMode();
  const restoreEnv = applyEnvOverrides(parsed.overrides);

  try {
    let config: Types.OpenLConfig;
    try {
      config = buildConfig(env, parsed.overrides, parsed.anonymous);
    } catch (error) {
      // Config errors (missing OPENL_BASE_URL, no auth, bad URL) → EX_CONFIG
      throw new CliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODES.CONFIG,
      );
    }
    const client = (options.clientFactory ?? ((c) => new OpenLClient(c)))(config);

    // Cookie-jar: restore JSESSIONID from previous invocation so
    // session-coupled flows (trace) work across separate `npx` calls. The jar
    // is bound to (base URL, principal) so a session never leaks across
    // hosts/users.
    const cookieBinding = parsed.cookieJarPath ? computeCookieBinding(client) : null;
    if (parsed.cookieJarPath && cookieBinding) {
      const cookie = await loadCookieJar(parsed.cookieJarPath, cookieBinding, stderr);
      if (cookie !== null) client.setSessionCookie(cookie);
    }

    let toolArgs: unknown;
    try {
      toolArgs = applyDefaultResponseFormat(await resolveToolArgs(parsed, stdin));
    } catch (error) {
      // Malformed JSON from inline / @file / --stdin → EX_DATAERR
      throw new CliError(
        error instanceof Error ? error.message : String(error),
        EXIT_CODES.DATAERR,
      );
    }

    const result = await executeTool(parsed.toolName, toolArgs, client);

    // Persist any session cookie established by this call for the next one.
    if (parsed.cookieJarPath && cookieBinding) {
      await saveCookieJar(parsed.cookieJarPath, client.getSessionCookie(), cookieBinding, stderr);
    }

    for (const part of result.content) {
      if (part.type === "text" && typeof part.text === "string") {
        stdout.write(part.text);
        if (!part.text.endsWith("\n")) stdout.write("\n");
      }
    }
    return EXIT_CODES.OK;
  } catch (error: unknown) {
    stderr.write(`Error: ${sanitizeError(error)}\n`);
    return classifyError(error);
  } finally {
    restoreEnv();
    restoreQuiet();
  }
}
