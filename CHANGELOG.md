# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 11 raw table-source action tools that apply a single in-place edit to a table (any type): `openl_append_table_row`/`_column`, `openl_insert_table_row`/`_column`, `openl_delete_table_row`/`_column`, `openl_update_table_row`/`_column`/`_cell`, and `openl_merge_table_cells`/`openl_unmerge_table_cells`. Each returns the table's current id (table ids change when an edit relocates the table) and triggers a recompile.
- `openl_delete_table` tool to delete an entire table from a project (`DELETE /projects/{projectId}/tables/{tableId}`).

### Changed

- Simplified how the server is delivered: run it with `npx -y openl-mcp <openl-url>` when Node.js is installed, or on the official `node:lts-alpine` image (`docker run --rm -i node:lts-alpine npx -y openl-mcp <openl-url>`) when it isn't — there is no longer a custom Docker image to pull. Setup docs now cover Claude Code, Claude Desktop, Cursor, and VS Code (GitHub Copilot) connecting over stdio.
- `compose.yaml` now starts OpenL Studio together with the MCP server, with the MCP service running the latest nightly build (the `x` prerelease tarball) via `npx` on `node:lts-alpine`; the separate `compose.studio.yaml` was folded into it.
- The prompt registry is now built by reading the `prompts/` directory and deriving each prompt's title, description, and arguments from its file's YAML frontmatter, instead of duplicating those definitions in a hardcoded array. A prompt's name comes from its filename, so the redundant `name` field was dropped from every prompt's frontmatter.
- Prompt files are now read and parsed once at startup, when the registry is built, and their content is cached in memory — instead of being re-read and re-parsed on every prompt request.
- Updated all runtime and development dependencies to their latest versions, including the major bump of `@types/node` to v26 and bumps of the MCP SDK (v1.29), `zod` (v4.4), `axios` (v1.18), `eslint`, `jest`, and `ts-jest`.
- The HTTP server now serves MCP over the Streamable HTTP transport (MCP spec 2025-11-25) at a single `/mcp` endpoint (`POST` to send messages, `GET` for the server stream, `DELETE` to end a session), replacing the previous `/mcp/sse` + `/mcp/messages` endpoints. Update client configs to `"url": ".../mcp"` with `"transport": "streamablehttp"`.
- The server now has a single entry point: `dist/index.js` runs the stdio transport by default, or the Streamable HTTP transport when launched with `--http`. The standalone `dist/server.js` is gone — `npm run start:http` now uses `dist/index.js --http`.

### Removed

- Removed the custom Docker image and its build pipeline — the `Dockerfile`, `.dockerignore`, the nightly GHCR image build, and Docker Hub / GHCR `openl-mcp` image distribution. Run the npm package via `npx` or the official `node:lts-alpine` image instead.
- Removed the `deploy.sh` helper script: its Docker commands are gone, and the rest duplicated existing `npm` scripts.
- Dropped the `mcp-remote` proxy from the Claude Desktop setup — clients now launch the server directly over stdio (`npx`, or Docker without Node.js).
- Removed the legacy HTTP+SSE transport (`GET /mcp/sse`, `POST /mcp/messages`) and the nginx-proxy path aliases (`/sse`, `/messages`). Only Streamable HTTP at `/mcp` is supported.
- Removed the standalone REST tool endpoints (`GET /tools`, `GET /tools/:name`, `POST /tools/:name/execute`, `POST /execute`); use the MCP protocol over `/mcp` instead. The unauthenticated `GET /health` liveness probe is retained.
- The HTTP transport no longer accepts credentials via URL query parameters (e.g. `?OPENL_PERSONAL_ACCESS_TOKEN=…`); pass them in the `Authorization` header (`Token`/`Bearer`). Query strings leak into proxy/access logs, browser history, and `Referer` headers.
- Removed HTTP Basic Authentication — the server now authenticates only with a Personal Access Token. The `OPENL_USERNAME`/`OPENL_PASSWORD` environment variables and the `--user`/`--password` CLI flags are gone, and the HTTP transport no longer accepts `Authorization: Basic`. Use `OPENL_PERSONAL_ACCESS_TOKEN` (or `--token`, or `Authorization: Token`/`Bearer`), or run unauthenticated against an OpenL Studio in single-user mode.

### Fixed

- A global install (`npm i -g openl-mcp`) now actually runs. The binary is exposed as a `bin` symlink, and the entry-point check only ran `main()` when `process.argv[1]` ended in `index.js` — which a symlink launch (global install, npm `.bin` shim) does not — so `openl-mcp …` silently did nothing. The check now compares resolved realpaths, so symlinked launches start correctly while importing the module (tests) still doesn't.
- Server no longer refuses to start when no authentication is configured. OpenL Studio in single-user mode accepts unauthenticated requests, but the previous startup check required credentials and exited with `"At least one authentication method must be configured"` — the auth interceptor already skips the `Authorization` header when no token is present, so the check was the only blocker. The server now logs an info line when running without credentials.
- `openl_create_project` clone mode (default, branch-less) now goes through the same create-from-zip endpoint as blank create: the source project folder is downloaded as a ZIP and re-uploaded under the new name (EPBDS-16088). The clone is committed in ONE atomic revision, the project name in rules.xml is renamed by the server, and — critically — the project is registered in OpenL's workspace index, so it appears in `openl_list_projects` immediately instead of staying invisible until a repository re-index. A `branch` clone still uses the raw git file-copy path (the create-from-zip endpoint cannot target a branch) and keeps the re-index caveat.
- `openl_get_trace_nodes` and `openl_export_trace` now wait server-side while the trace is still running instead of surfacing 409 Conflict to the caller (EPBDS-16089). On a 409 the tools subscribe to the studio's trace-status websocket topic (`/user/topic/projects/{id}/tables/{tableId}/trace/status` — the same STOMP channel already used for compile-status tracking) and resume on the `COMPLETED`/`INTERRUPTED`/`ERROR` event, bounded by `waitTimeoutMs` (default 120s, cap 600s) and reported via MCP progress notifications — no polling. An LLM agent that cannot sleep between calls completes the start → read workflow in one call instead of burning its step budget retrying. The traced table is remembered by `openl_start_trace`; pass `tableId` explicitly when the trace was started by a different process (e.g. a separate CLI run — combine with `--cookie-jar` to stay in the studio session). Pass `wait: false` for the previous immediate-409 behavior; on timeout the error explains the trace is still running and how to proceed; a studio-side trace failure is reported with the studio's error message.
- `openl_append_table` / `openl_update_table` now handle the table id becoming stale after an edit (EPBDS-16084). OpenL Studio derives a table id from its location, so an edit that relocates the table (it had no room to grow in place) changes the id; previously the post-edit recompile read silently failed and any client that kept the pre-edit id permanently lost access to the table. The edit tools now report the table's current id as `tableId` in the response (with `previousTableId`/`tableIdChanged` when it changed), record the rename, and use the new id for the recompile read. `openl_get_table`, `openl_update_table`, and `openl_append_table` transparently resolve ids that went stale through an edit made via this server.
- The edit tools now take the new table id straight from the studio's write response when available: studio PR #1778 (EPBDS-16086) returns `200` with a `{ id }` body and a `Location` header on a relocating edit (and `204` when the id is unchanged), so `openl_update_table` / `openl_append_table` use that authoritative id directly. The previous identity-based re-resolution (list-by-name, narrow by kind/file/pos, before/after id diff) is kept only as a fallback for older studios that do not report the id.
- `openl_append_table` with `tableType: RawSource` now validates the row width against the table's actual column count before writing (EPBDS-16085). Previously a row with too few cells was accepted and persisted with the remaining cells silently blank; now the call fails with a clear validation error and nothing is written.
- 404 errors from table endpoints now explain that table ids go stale after edits — that the preceding edit was applied (not rolled back) and how to refresh ids — instead of a bare "The table is not found" (EPBDS-16086).
- `openl_append_table`, `openl_update_table`, and `openl_create_project_table` now validate the table payload against the tool schema before calling OpenL Studio, returning a precise, actionable error instead of the backend's opaque 400 "Failed to read request" (EPBDS-16110, EPBDS-16112). This catches a missing or miscased `tableType` and a payload whose shape does not match its type (e.g. a `Data` append using `rules` instead of `rows`). A payload mistakenly sent as a JSON *string* (e.g. `appendData: "{…}"`) is now parsed into an object and accepted instead of failing.
- Starting the HTTP server with the base URL as a positional argument (`openl-mcp <url> --http`, the form used by `compose.yaml`) now works. The positional URL was ignored in `--http` mode — only `OPENL_BASE_URL` was read — so the server started but every request failed with "No OpenL client available". The positional now takes precedence over `OPENL_BASE_URL`, matching stdio mode.

### Added

- CLI tool names drop the `openl_` prefix: run `openl-mcp <url> list_repositories` (not `openl_list_repositories`, which the CLI no longer accepts). The prefix is now a protocol-boundary concern only — the internal tool registry and the CLI both use bare names, and the `openl_` prefix is added/stripped solely on the MCP `tools/list` / `tools/call` wire, where it namespaces this server's tools against others'.
- The `openl-mcp` binary now accepts the OpenL Studio base URL as a positional argument: `openl-mcp <url>` starts the MCP server against that URL, and `openl-mcp <url> <tool>` runs a CLI tool against it. `OPENL_BASE_URL` still works as a fallback; the positional argument takes precedence. Auth and timeout can also be supplied as flags on the server launch.
- `openl_append_table` now supports appending to a full multi-column `Spreadsheet` table (`rows` row headers + `cells` 2D value grid), matching OpenL Studio's new append capability; previously only the single-column `SimpleSpreadsheet` form could be appended.
- `openl_search_project_files` - search a project's files and folders through the studio's `POST /projects/{projectId}/file-search` endpoint (EPBDS-16012). Filter by ant-glob path `pattern`, file `extensions`, resource `type` (FILE/FOLDER/ANY), and/or a case-insensitive full-text `content` substring; `recursive` toggles nested-folder search (default false = top level only). Scope `SUBTREE` (default) searches within the project and can target a historical `version`; scope `ANCESTORS` walks up to the repository root.
- `openl_get_project_agents_md` - load the AGENTS.md guidance that applies to a project as a single aggregated markdown document (EPBDS-16012). Walks UP from the project directory — or an optional `folder` sub-directory, for "the AGENTS.md nearest the edited file wins" — to the repository root, collecting every AGENTS.md along the way (implemented as an `ANCESTORS`-scope file-search), and returns them concatenated ordered from the repository root (lowest priority) down to the project folder (highest priority); on conflict, later sections override earlier ones. Also exposed read-only as the `openl://docs/{project}/AGENTS.md` resource and documented by the `project_agents_md` guidance prompt.
- `openl_create_project` - create a new project in a design repository, in one of two modes (EPBDS-15661):
  - **blank** (omit `template`): create an empty project from the bundled skeleton; committed atomically on the repository's default branch and returns the commit hash.
  - **clone** (`template` = an existing project name): copy the source project's full structure (rules, tests, settings, examples) into the new project and rename it in `rules.xml`, matching OpenL Studio's Copy Project; `branch` is honored.

  Name collisions return 409, a missing clone source returns 404, and missing permission returns 403.
- CLI mode — the `openl-mcp` binary can run any `openl_*` tool directly from the shell via `npx`, without an MCP client; `--help` lists tools by category and `--list-tools` dumps their JSON schemas. With no arguments it still starts the stdio MCP server (EPBDS-16027).
- Six tools for tracing OpenL rule and test-table execution: `openl_start_trace`, `openl_get_trace_nodes`, `openl_get_trace_node_details`, `openl_get_trace_parameter`, `openl_cancel_trace`, and `openl_export_trace` (EPBDS-15552).
- Project status validation — the read-only `openl_project_status` tool and `openl://status/{projectId}` resource report a project's compilation state, diagnostics, and pending changes, with an optional wait-for-compilation mode and live updates; adds resource templates and `projectId`/`branch` autocompletion (EPBDS-15919).
- Five Project Files tools for working with any file in a project by path: `openl_read_project_file` (read/list/metadata), `openl_write_project_file`, `openl_delete_project_file`, `openl_copy_project_file`, and `openl_move_project_file` (EPBDS-16080).
- Bundled an `openl-trace-investigation` skill that guides diagnosing unexpected OpenL results (wrong values, nulls, rejected claims), including cases where a clean trace hides an upstream mapping/integration defect (EPBDS-15859).
- `@jest/globals` is now declared directly as a dev dependency instead of being relied on transitively.

### Removed

- Six tools that were never enabled have been removed along with their input schemas and the client methods that backed them: `openl_upload_file`, `openl_download_file`, `openl_execute_rule`, `openl_revert_version`, `openl_get_file_history`, and `openl_get_project_history`.
- Three obsolete guidance prompts have been removed: `execute_rule`, `file_history`, and `get_project_errors`.
- Dropped the dead `src/tools.ts` tool registry (and its tool-category groupings); `tool-handlers.ts` is now the single source of registered tools.
- Pruned roughly 30 unused type definitions left over from the removed features.
- Removed unused dev dependencies: `ts-node`, `@types/js-yaml`, and `@types/jest`.

### Deprecated

- Passing the Personal Access Token via a URL query parameter is deprecated and now logs a warning — query strings can leak into proxy logs, browser history, and `Referer` headers. Use the `Authorization: Token <PAT>` header instead; query-parameter support is kept for backward compatibility (EPBDS-15654).

### Notes

- A default (branch-less) clone is committed atomically through the create-from-zip endpoint and is indexed/visible immediately (see EPBDS-16088 above). Cloning onto a specific `branch` still writes directly to the repository's Git via the files API (one commit per file, not atomic, bypassing OpenL's workspace indexing) — a branch clone may not appear in `openl_list_projects` until OpenL re-indexes the repository, and there is currently no API to trigger re-indexing on demand.
- A blank project is always created on the repository's default branch (the create endpoint cannot target a branch).

### Security

- Resolved all known `npm audit` advisories in the dependency tree, including the high-severity `hono` path-traversal issue (pulled in transitively via the MCP SDK) and a `js-yaml` denial-of-service issue in the test toolchain (pinned to a patched version via an override). `npm audit` now reports zero vulnerabilities.

## [1.0.0] - 2026-02-23

### Added

- Initial public release of OpenL MCP Server
- 25 production-ready MCP tools organized into 4 categories: Repository Management (4), Project Management (13), Rules & Tables Management (5), Deployment (3)
- Support for multiple transport modes: stdio, HTTP SSE, and streamablehttp
- Support for multiple AI clients: Claude Desktop, Cursor IDE, and VS Code Copilot
- Supported authentication: Basic Auth and Personal Access Token (PAT)
- Four response formats: json, markdown, markdown_concise, markdown_detailed
- 15 AI guidance prompts for complex workflows (table creation, testing, deployment, version control)
- 4 MCP resources for read-only access to OpenL data via URI patterns
- Docker support with official image and Docker Compose examples
- Comprehensive documentation: 19+ guides organized into Getting Started, Setup, Usage, and Development sections
- Type-safe implementation with Zod schemas and TypeScript strict mode
- Automatic credential redaction in logs and error messages
- Request tracking via Client Document ID (OPENL_CLIENT_DOCUMENT_ID) for audit trails
- Comprehensive test suite with 11 test files covering unit, integration, and E2E testing
- Input validation for all tool parameters preventing injection attacks
- Support for OpenL Studio dual versioning: Git-based (temporal) and Dimension Properties (business context)
- Health check endpoint for Docker container orchestration
- Multi-architecture Docker images (AMD64 and ARM64)

### Security

- Automatic credential redaction protects sensitive data in error messages and logs
- Environment variable-based credential storage prevents code exposure
- HTTPS/TLS support for encrypted connections in production environments

### Compatibility

- Node.js: ≥24.0.0 (tested on Node.js 24)
- OpenL Studio: 6.0.0+ (tested with OpenL Tablets 6.x)
- MCP SDK: @modelcontextprotocol/sdk v1.26.0
- TypeScript: 5.7.2
- Supported transports: stdio, HTTP SSE, streamablehttp
- Supported authentication: Basic Auth and Personal Access Token (PAT)

[Unreleased]: https://github.com/openl-tablets/openl-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/openl-tablets/openl-mcp/releases/tag/v1.0.0
