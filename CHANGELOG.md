# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `OPENL_MCP_TOOLS`: an optional server-side allow-list of the tools to serve. **Unset** — the default — serves every tool, so no existing deployment changes. **Set** to a comma-separated list (bare or `openl_`-prefixed), only those tools are listed and only those can be called; anything else answers `MethodNotFound`. **Set but naming no tool** (`""`, whitespace, a lone comma) serves nothing and logs why — a restriction setting must not fail towards less restriction. A read-and-diagnostics subset of 39 tools cuts the schema payload a client receives from ~169 KB to ~85 KB.
- `OPENL_MCP_PRESERVE_AUTH_SCHEME` (HTTP transport, **off by default**): present an inbound `Bearer` credential to OpenL Studio as `Bearer` instead of rewriting it to `Token`. A Studio in oauth2 mode accepts an IdP access token that way, and the same token sent as `Token` does not authenticate, so an OAuth-capable MCP client could previously reach this server but not Studio through it. The scheme now travels on the client config and is applied at both outgoing sites — the REST interceptor and the `Authorization` header used for the STOMP handshake behind `openl_project_status(wait: true)`. With the flag **off**, behaviour is unchanged: both schemes are accepted inbound and `Token` goes out. With it **on**, the server logs once that it forwards a caller-supplied credential without validating it — validation (`iss`/`aud`/`exp` against the IdP JWKS) and RFC 9728 resource metadata are not part of this change.
- `openl_get_version` reports the running server's version and the build it came from (commit, branch or tag, build time, Node.js and platform), so a problem can be tied to an exact build. The same identity now appears in `openl-mcp --version`, the startup logs, and the HTTP `/health` response (EPBDS-16471).
- Studio workflow coverage for running and copying tables, dependency/property/module discovery, project-aware branches, branch merging with read-only conflict inspection, and confirmed project/branch deletion (EPBDS-16385).

### Changed

- `openl_get_table_dependencies` now exposes Studio's datatype/vocabulary graph with project-level layer filtering and datatype relationship and value details (EPBDS-15474).
- Binary project/conflict file reads now return lossless base64 in an interoperable JSON TextContent envelope, and `openl_write_project_file` accepts a schema-declared base64 `blob` while retaining whitespace-wrapped legacy base64 input (EPBDS-16385).
- Upgraded to the MCP TypeScript SDK v2 and added negotiation for the modern `2026-07-28` protocol while retaining the legacy 2025 protocol for existing clients. HTTP modern requests are stateless; stdio remains connection-pinned (EPBDS-16385).
- **BREAKING:** tool responses now default to structured JSON so read results can be reused safely in later tool calls; Markdown remains available through explicit `response_format` values (EPBDS-16385).
- **BREAKING:** table content is now exposed only as the authoritative `RawSource` cell matrix. `openl_get_table` always requests raw content, while create/update/append reject the incomplete typed table DTOs that could lose workbook structure during round trips (EPBDS-16385).
- **BREAKING:** `openl_repository_project_revisions` now requires the stable `projectId` returned by `openl_list_projects` and no longer accepts `repository`, `projectName`, or `branch`; it uses the project-level history API so an unsaved rename does not fail with 404 (EPBDS-16432).
- **BREAKING:** `openl_create_project` COPY mode now requires `template` to be the exact source `projectId` returned by `openl_list_projects`, instead of a project name. It sends Studio's new `sourceProject` field so duplicate business names in mapped repositories remain unambiguous (EPBDS-16328).
- Aligned MCP project, repository, table, test, trace, deployment, and file contracts with the current OpenL Studio OpenAPI (EPBDS-16385).
- `openl_create_project` now creates blank projects on an optional target branch and copies existing projects through Studio's atomic, indexed server-side copy API instead of downloading ZIPs or writing branch files individually (EPBDS-16385).

### Fixed

- `openl_run_table` now rejects `{ params: [...] }` with an actionable validation error instead of allowing Studio to execute it with null arguments, and no longer presents top-level arrays as positional arguments (EPBDS-16491).
- Merge tools now state that the precheck covers branch relationship and attempt blockers rather than conflicts, and conflict responses no longer repeat the superseded `mergeable` verdict (EPBDS-16489).
- `openl_delete_project_branch` now checks whether the current branch is merged into the repository base and requires explicit data-loss confirmation before deleting unmerged commits, unsaved changes, or a branch whose divergence cannot be verified (EPBDS-16488).
- `openl_update_table` now checks the submitted row count against the live table before writing, so removing `totalRows` from a sliced view cannot silently delete unseen rows (EPBDS-16486).
- Paginated list responses now advance `next_offset` by the rows actually delivered after size truncation, preventing agents from silently skipping results (EPBDS-16483).
- CLI output piped into another command (`openl-mcp --list-tools | jq …`) is no longer cut off after the first ~64 KB: the process exited before stdout had drained.
- Markdown test-result responses now identify each returned test unit and show failed assertions with expected and actual values (EPBDS-16134).
- Updated the transitive `@hono/node-server` dependency to a patched release for the Windows `serve-static` path-traversal advisory GHSA-frvp-7c67-39w9.
- `openl_list_project_branches` now supports repository-wide merge-target discovery, so projects created on isolated branches can be merged into a base branch that does not hold the project yet (EPBDS-16410).
- Streamable HTTP now rejects browser requests from origins outside the explicit `MCP_ALLOWED_ORIGINS` allowlist, exposes `Mcp-Session-Id` to approved browser clients, and gives every anonymous legacy MCP session its own Studio HTTP client (EPBDS-16385).
- Append, test-start, deploy, and redeploy tools no longer advertise themselves as idempotent, preventing MCP clients from treating repeatable side effects as safe automatic retries (EPBDS-16385).
- Windowed `openl_get_table` responses can no longer be passed to `openl_update_table`, preventing omitted rows from being deleted during a partial-view round trip (EPBDS-16385).
- Table writes now reject read-only cell styles instead of reporting success when Studio silently ignores formatting changes (EPBDS-16385).
- Project-file content search now documents Studio's text-only boundary instead of implying that XLSX, ZIP, or other binary contents are indexed (EPBDS-16385).
- Large single-object JSON responses are now replaced with a bounded valid-JSON preview instead of exceeding the response limit while claiming to be truncated (EPBDS-16385).
- `openl_run_table` now bounds the complete start-and-result workflow with backoff, rejects overlapping session-scoped runs, and cancels pending Studio state after any failed workflow, preventing result mix-ups, endless polling, and stale runs (EPBDS-16385).
- Markdown responses from `openl_get_table_dependencies` now render dependency and dependent edges, table metadata, and query context instead of silently collapsing the graph into a flat table list (EPBDS-16385).
- `openl_project_status` now defaults to waiting for a conclusive result and lazily starts compilation when Studio initially reports `idle`, instead of leaving agents with a status that cannot distinguish an uncompiled project from a valid one. Explicit `wait=false` remains a read-only snapshot (EPBDS-16385).
- `openl_create_project` now returns the same opaque backend `projectId` as `openl_list_projects` instead of incorrectly labeling the project name as its ID, including projects created or copied onto a target branch (EPBDS-16385).
- `openl_list_projects` and `openl_list_tables` now preserve Studio's pagination metadata instead of treating one backend page as the complete result and paginating it a second time. `total_count`, `has_more`, and `next_offset` describe the full collection, and current Studio's true item offsets preserve non-page-aligned requests exactly (EPBDS-16387).

### Removed

- **BREAKING:** `openl_resolve_merge_conflicts` is removed because Studio does not expose a sufficiently safe API for autonomous conflict resolution. Agents can inspect BASE/OURS/THEIRS evidence, but must hand the decision to the user for manual resolution in Studio rather than risk discarding work (EPBDS-16385).
- **BREAKING:** the `openl-mcp login` / `openl-mcp logout` browser sign-in commands and the
  credential cache (`~/.config/openl-mcp/credentials.json`) are removed. Authentication is now
  explicit-token-only: `OPENL_PERSONAL_ACCESS_TOKEN` / `--token` when supplied, otherwise
  anonymous (single-user Studio). A blank/whitespace token is still treated as absent. Anyone who
  relied on the cached browser sign-in should create a Personal Access Token in OpenL Studio
  (**User Settings → Personal Access Tokens**) and pass it explicitly; a leftover cache file can be deleted
  manually. Rationale: the loopback OAuth flow only worked with the browser and the CLI on the
  same machine, and the silent cache fallback made "cleared token setting" look signed-out while
  requests kept authenticating.

## [1.1.0] - 2026-07-06

### Added

- `openl_expand_trace_tree` tool to walk a profiling run's executed call tree lazily, one level at a time (`GET /projects/{projectId}/trace/tree/children`). The studio now returns the profiling `tree` one level deep so a huge run is never serialized whole: each step carries a `childrenTotal` count instead of nested `children`. Expand a step whose `childrenTotal` > 0 by its node (`uri` + `instance`) and step `ref`; the tool returns `{ children, total }` (each child itself shallow), pages a loop's thousands of sub-calls with `offset`/`limit` (flagging `hasMore`/`nextOffset`), and surfaces each node's `notRetained` (sub-calls dropped once the retained tree hit its size limit).
- `openl_get_started` onboarding tool — read-only, meant to be called once per session before any other tool. It returns the mandatory workflow protocol (load the project's agent context before working on it, consult reference docs on demand, edit → validate → save) plus a short orientation over the bundled documentation.
- `openl_list_guides` and `openl_get_guides` tools serving the official OpenL Tablets documentation (specifications from `Docs/ref` and the Reference Guide chapters), embedded into the server at build time from the release tag matching the targeted OpenL Studio version. The index is metadata-only (id, type, title, size; filterable and paginated); full markdown bodies are fetched by id on demand, and unknown ids fail with an actionable error.
- 12 raw table-source action tools that edit a table's raw source in place (any type). One tool per operation×orientation handles ONE OR MORE rows/columns — `openl_append_table_rows`/`_columns`, `openl_insert_table_rows`/`_columns`, `openl_delete_table_rows`/`_columns` — sending the studio's `rows`/`columns` block target (a single row/column is a one-element block), so there is no separate single-vs-block tool. Plus `openl_update_table_row`/`_column`/`_cell`, `openl_update_table_range` (overwrite a rectangular range), and `openl_merge_table_cells`/`openl_unmerge_table_cells`. Each returns the table's current id (table ids change when an edit relocates the table) and triggers a recompile.
- `openl-mcp login` / `openl-mcp logout`: browser-based sign-in that mints and caches an OpenL Personal Access Token, so the server authenticates automatically without manually copy-pasting a token. Requires an OpenL Studio in OAuth2 mode; an explicit `OPENL_PERSONAL_ACCESS_TOKEN` / `--token` still takes precedence over the cached login.
- `openl_delete_table` tool to delete an entire table from a project (`DELETE /projects/{projectId}/tables/{tableId}`).
- `openl_get_table` raw view options: `startRow`/`maxRows` read a large table in row slices (a windowed response reports the table's `totalRows`), and `styles=true` returns each cell's Excel style (background/font colour, bold/italic/underline, alignment, indent, borders).

### Changed

- Raised the HTTP / Streamable HTTP transport's inbound request-body cap from Express's 100 KB default to 5 MB, so a large tool-call argument — a trace `inputJson` (a rating census / policy object) or a table payload — is no longer rejected with HTTP 413 before reaching the MCP handler. Override with the `MCP_MAX_BODY_SIZE` env var (e.g. `10mb`), which is validated before use so a malformed value cannot silently drop the limit. This does not affect the stdio transport (unbounded) and cannot lift a client's own tool-call output-size limit.
- Refreshed the development improvement plan (`docs/development/improvement-plans.md`) from a full-codebase review: re-verified the remaining items of the previous plan and reorganized all findings into prioritized workstreams (correctness, HTTP transport hardening, validation, dead code, tests/CI, docs).
- Reworked the trace tools into an **interactive rule debugger** (EPBDS-16195), following the studio's new Trace Debug API (the tree-based trace endpoints are gone). The tree-trace tools `openl_get_trace_nodes`, `openl_get_trace_node_details`, `openl_get_trace_parameter`, `openl_cancel_trace`, and `openl_export_trace` are removed; the nine debugger tools are: `openl_start_trace` (runs to the first stop; optional initial breakpoints, test case or JSON input, input replay, and `profiling`), `openl_step_trace` (out/into/over), `openl_resume_trace` (runs to the next breakpoint/exception/completion, waiting inside the call), `openl_inspect_trace_frame` (live frame variables, decision-table outcome, optional cell-highlight overlay with the raw grid), `openl_set_trace_breakpoints` (read/replace the set — by table name, URI, spreadsheet cell, any or a specific fired rule — and list targets), `openl_get_trace_value` (expand lazy values), `openl_expand_trace_tree` (page a profiling run's executed call tree one level at a time), `openl_watch_trace_cells` (watch named cells across a whole run — one series per cell, including cells inside lazy result branches, which the run forces to materialize; the server caps points per series and reports each series' `total` execution count so a cell deep in a combinatorial branch can't overflow the response), and `openl_stop_trace`.
- Kept trace responses within the 1 MB tool-result limit and cut their verbosity, using the studio's response-shaping support:
  - **Profiling returns a constant-size overview.** `openl_start_trace` with `profiling: true` returns the `profile` — the top-N slowest tables (selfMillis/totalMillis/count) plus nodeCount/distinctTables/totalMillis — instead of the full executed tree, which on a real project exceeds 1 MB (a FPQ5 run dropped from ~1 MB to ~6 KB). `profileTop` tunes the hotspot count; `includeTree: true` opts into the raw tree to browse one branch.
  - **Compact stacks.** `openl_step_trace` / `openl_resume_trace` return steps only for the active frame, so a step no longer resends every frame's steps; use `openl_inspect_trace_frame` for another frame's detail.
  - **Fewer round-trips and less noise.** `openl_step_trace` takes `withValues: true` to bundle the active frame's variables (the usual step→inspect in one call); `openl_inspect_trace_frame` takes `onlyExecutedSteps` and `excludeStepValues` (e.g. `[1]`) to surface an outlier among neutral factors — a lazy step value is resolved before the comparison, so a neutral factor that arrived lazy (as most key multipliers do) is dropped too instead of surviving unmatched. Value JSON Schemas remain omitted by default (`full: true` / `withSchema: true` restore them).
  - **Break on a specific iteration.** A breakpoint key takes an `@N` suffix (e.g. `<uri>#R48C0@3`) to stop only on a table's N-th execution (0-based), matching `DebugFrameView.instance` and an `openl_watch_trace_cells` series' `instance` — so a watch outlier at instance 3 is reached directly instead of resuming past every earlier pass of a table that runs once per coverage/iteration.
  - **Lazy call tree.** The studio now returns a profiling run's `tree` one level deep — each step carries a `childrenTotal` count instead of nested `children`, so a huge run is never serialized whole and `includeTree: true` is safe. Deeper levels load on demand through the new `openl_expand_trace_tree` tool (paged for a loop's thousands of sub-calls), and a node reports `notRetained` when the retained tree dropped some sub-calls at its size limit. `profile.hotspots[].count` now counts every table call (accurate even on a truncated tree, where it previously under-reported) and `profile.truncated` is set when the tree hit its node cap.
- Tightened raw table-action validation to match the studio's constraints: `cells` is now required (non-empty) for the row/column edit tools, and the delete tools reject `position` 0 (the header row / leading-label column cannot be deleted) — both now fail locally with an actionable error instead of an opaque backend response.
- Simplified how the server is delivered: run it with `npx -y openl-mcp <openl-url>` when Node.js is installed, or on the official `node:lts-alpine` image (`docker run --rm -i node:lts-alpine npx -y openl-mcp <openl-url>`) when it isn't — there is no longer a custom Docker image to pull. Setup docs now cover Claude Code, Claude Desktop, Cursor, and VS Code (GitHub Copilot) connecting over stdio.
- `compose.yaml` now starts OpenL Studio together with the MCP server, with the MCP service running the latest nightly build (the `x` prerelease tarball) via `npx` on `node:lts-alpine`; the separate `compose.studio.yaml` was folded into it.
- The prompt registry is now built by reading the `prompts/` directory and deriving each prompt's title, description, and arguments from its file's YAML frontmatter, instead of duplicating those definitions in a hardcoded array. A prompt's name comes from its filename, so the redundant `name` field was dropped from every prompt's frontmatter.
- Prompt files are now read and parsed once at startup, when the registry is built, and their content is cached in memory — instead of being re-read and re-parsed on every prompt request.
- Updated all runtime and development dependencies to their latest versions, including the major bump of `@types/node` to v26 and bumps of the MCP SDK (v1.29), `zod` (v4.4), `axios` (v1.18), `eslint`, `jest`, and `ts-jest`.
- The HTTP server now serves MCP over the Streamable HTTP transport (MCP spec 2025-11-25) at a single `/mcp` endpoint (`POST` to send messages, `GET` for the server stream, `DELETE` to end a session), replacing the previous `/mcp/sse` + `/mcp/messages` endpoints. Update client configs to `"url": ".../mcp"` with `"transport": "streamablehttp"`.
- The server now has a single entry point: `dist/index.js` runs the stdio transport by default, or the Streamable HTTP transport when launched with `--http`. The standalone `dist/server.js` is gone — `npm run start:http` now uses `dist/index.js --http`.
- Reworked the user documentation: one linear Quick Start (a step plan, prerequisites, copy-paste config for each client, and checkpoints); an Advanced Guide that consolidates server settings, authentication, Docker, and CLI mode; and shorter, plainer usage and troubleshooting guides (a stale "build the server" step was dropped from the examples). All user guides now live in `docs/guides/`, the per-directory index pages were replaced by a single documentation index, and `AGENTS.md` was trimmed to the agent-facing essentials.
- Trimmed the CLI reference and moved it from the repository root (`README.cli.md`) to [`docs/guides/cli.md`](docs/guides/cli.md) alongside the other user guides. It now documents the `login`/`logout` sign-in and defers per-tool detail to `--help` / `--list-tools`; it is linked from the npm README rather than bundled in the package.

### Removed

- Removed all MCP resources: the `openl://…` resource catalog and templates, live project-status updates over `resources/subscribe`, and resource-argument autocompletion (`completion/complete`). The server now exposes only tools and prompts — the same data is available through the equivalent tools (e.g. `openl_list_projects`, `openl_project_status`, `openl_get_project_agent_context`).
- Removed the custom Docker image and its build pipeline — the `Dockerfile`, `.dockerignore`, the nightly GHCR image build, and Docker Hub / GHCR `openl-mcp` image distribution. Run the npm package via `npx` or the official `node:lts-alpine` image instead.
- Removed the `deploy.sh` helper script: its Docker commands are gone, and the rest duplicated existing `npm` scripts.
- Dropped the `mcp-remote` proxy from the Claude Desktop setup — clients now launch the server directly over stdio (`npx`, or Docker without Node.js).
- Removed the legacy HTTP+SSE transport (`GET /mcp/sse`, `POST /mcp/messages`) and the nginx-proxy path aliases (`/sse`, `/messages`). Only Streamable HTTP at `/mcp` is supported.
- Removed the standalone REST tool endpoints (`GET /tools`, `GET /tools/:name`, `POST /tools/:name/execute`, `POST /execute`); use the MCP protocol over `/mcp` instead. The unauthenticated `GET /health` liveness probe is retained.
- The HTTP transport no longer accepts credentials via URL query parameters (e.g. `?OPENL_PERSONAL_ACCESS_TOKEN=…`); pass them in the `Authorization` header (`Token`/`Bearer`). Query strings leak into proxy/access logs, browser history, and `Referer` headers.
- Removed HTTP Basic Authentication — the server now authenticates only with a Personal Access Token. The `OPENL_USERNAME`/`OPENL_PASSWORD` environment variables and the `--user`/`--password` CLI flags are gone, and the HTTP transport no longer accepts `Authorization: Basic`. Use `OPENL_PERSONAL_ACCESS_TOKEN` (or `--token`, or `Authorization: Token`/`Bearer`), or run unauthenticated against an OpenL Studio in single-user mode.
- Removed the CLI `--anonymous` flag — it was the redundant opposite of `--token`. The CLI now treats a missing token (no `--token` / `OPENL_PERSONAL_ACCESS_TOKEN`) as an unauthenticated request instead of failing fast, matching the stdio server; pass `--token` (or set the env var) to authenticate.
- Removed request tracking via the `Client-Document-Id` header: the `OPENL_CLIENT_DOCUMENT_ID` environment variable and the `--client-document-id` CLI flag are gone.

### Fixed

- A studio `ValidationError`'s per-field and additional global errors now appear in the message the agent sees, instead of being hidden behind a generic top-level message (e.g. "Validation failed"). The error text now lists each failing field with its reason and rejected value (and any extra global errors), so the model can pinpoint and fix the exact problem.
- Tool failures now reach the agent with their detailed reason instead of a generic "tool execution failed". A tool's own error (backend 4xx/5xx, argument validation) was thrown as a JSON-RPC protocol error, which clients surface generically with the cause dropped; it is now returned as an MCP tool result with `isError: true` carrying the full message (e.g. "column height 6 exceeds table height 5"), so the model can self-correct. A genuinely unknown tool name stays a protocol error.
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
- `openl_search_project_files` - search a project's files and folders through the studio's `POST /projects/{projectId}/file-search` endpoint (EPBDS-16012). Filter by ant-glob path `pattern`, file `extensions`, resource `type` (FILE/FOLDER/ANY), and/or a case-insensitive text-file `content` substring (Studio does not inspect binary contents); `recursive` toggles nested-folder search (default false = top level only). Scope `SUBTREE` (default) searches within the project and can target a historical `version`; scope `ANCESTORS` walks up to the repository root.
- `openl_get_project_agent_context` - load the AGENTS.md guidance that applies to a project as a single aggregated markdown document (EPBDS-16012, tool named per EPBDS-16156). Walks UP from the project directory — or an optional `folder` sub-directory, for "the AGENTS.md nearest the edited file wins" — to the repository root, collecting every AGENTS.md along the way (implemented as an `ANCESTORS`-scope file-search), and returns them concatenated ordered from the repository root (lowest priority) down to the project folder (highest priority); on conflict, later sections override earlier ones. When the guidance references bundled reference guides by id, those ids are listed at the end for `openl_get_guides`. Documented by the `project_agents_md` guidance prompt.
- `openl_create_project` - create a new project in a design repository, in one of two modes (EPBDS-15661):
  - **blank** (omit `template`): create an empty project from the bundled skeleton; committed atomically on the repository's default branch and returns the commit hash.
  - **clone** (`template` = an existing project name): copy the source project's full structure (rules, tests, settings, examples) into the new project and rename it in `rules.xml`, matching OpenL Studio's Copy Project; `branch` is honored.

  Name collisions return 409, a missing clone source returns 404, and missing permission returns 403.
- CLI mode — the `openl-mcp` binary can run any `openl_*` tool directly from the shell via `npx`, without an MCP client; `--help` lists tools by category and `--list-tools` dumps their JSON schemas. With no arguments it still starts the stdio MCP server (EPBDS-16027).
- Six tools for tracing OpenL rule and test-table execution: `openl_start_trace`, `openl_get_trace_nodes`, `openl_get_trace_node_details`, `openl_get_trace_parameter`, `openl_cancel_trace`, and `openl_export_trace` (EPBDS-15552).
- Project status validation — the read-only `openl_project_status` tool reports a project's compilation state, diagnostics, and pending changes, with an optional wait-for-compilation mode (EPBDS-15919).
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

[Unreleased]: https://github.com/openl-tablets/openl-mcp/compare/1.1.0...HEAD
[1.1.0]: https://github.com/openl-tablets/openl-mcp/releases/tag/1.1.0
[1.0.0]: https://github.com/openl-tablets/openl-mcp/releases/tag/1.0.0
