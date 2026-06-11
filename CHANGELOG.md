# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `openl_create_project` clone mode (default, branch-less) now goes through the same create-from-zip endpoint as blank create: the source project folder is downloaded as a ZIP and re-uploaded under the new name (EPBDS-16088). The clone is committed in ONE atomic revision, the project name in rules.xml is renamed by the server, and — critically — the project is registered in OpenL's workspace index, so it appears in `openl_list_projects` immediately instead of staying invisible until a repository re-index. A `branch` clone still uses the raw git file-copy path (the create-from-zip endpoint cannot target a branch) and keeps the re-index caveat.
- `openl_get_trace_nodes` and `openl_export_trace` now wait server-side while the trace is still running instead of surfacing 409 Conflict to the caller (EPBDS-16089). On a 409 the tools subscribe to the studio's trace-status websocket topic (`/user/topic/projects/{id}/tables/{tableId}/trace/status` — the same STOMP channel already used for compile-status tracking) and resume on the `COMPLETED`/`INTERRUPTED`/`ERROR` event, bounded by `waitTimeoutMs` (default 120s, cap 600s) and reported via MCP progress notifications — no polling. An LLM agent that cannot sleep between calls completes the start → read workflow in one call instead of burning its step budget retrying. The traced table is remembered by `openl_start_trace`; pass `tableId` explicitly when the trace was started by a different process (e.g. a separate CLI run — combine with `--cookie-jar` to stay in the studio session). Pass `wait: false` for the previous immediate-409 behavior; on timeout the error explains the trace is still running and how to proceed; a studio-side trace failure is reported with the studio's error message.
- `openl_append_table` / `openl_update_table` now handle the table id becoming stale after an edit (EPBDS-16084). OpenL Studio derives a table id from its location, so an edit that relocates the table (it had no room to grow in place) changes the id; previously the post-edit recompile read silently failed and any client that kept the pre-edit id permanently lost access to the table. The edit tools now report the table's current id as `tableId` in the response (with `previousTableId`/`tableIdChanged` when it changed), record the rename, and use the new id for the recompile read. `openl_get_table`, `openl_update_table`, and `openl_append_table` transparently resolve ids that went stale through an edit made via this server.
- The edit tools now take the new table id straight from the studio's write response when available: studio PR #1778 (EPBDS-16086) returns `200` with a `{ id }` body and a `Location` header on a relocating edit (and `204` when the id is unchanged), so `openl_update_table` / `openl_append_table` use that authoritative id directly. The previous identity-based re-resolution (list-by-name, narrow by kind/file/pos, before/after id diff) is kept only as a fallback for older studios that do not report the id.
- `openl_append_table` with `tableType: RawSource` now validates the row width against the table's actual column count before writing (EPBDS-16085). Previously a row with too few cells was accepted and persisted with the remaining cells silently blank; now the call fails with a clear validation error and nothing is written.
- 404 errors from table endpoints now explain that table ids go stale after edits — that the preceding edit was applied (not rolled back) and how to refresh ids — instead of a bare "The table is not found" (EPBDS-16086).

### Added

- `openl_create_project` - create a new project in a design repository, in one of two modes (EPBDS-15661):
  - **blank** (omit `template`): create an empty project from the bundled skeleton; committed atomically on the repository's default branch and returns the commit hash.
  - **clone** (`template` = an existing project name): copy the source project's full structure (rules, tests, settings, examples) into the new project and rename it in `rules.xml`, matching OpenL Studio's Copy Project; `branch` is honored.

  Name collisions return 409, a missing clone source returns 404, and missing permission returns 403.

### Notes

- A default (branch-less) clone is committed atomically through the create-from-zip endpoint and is indexed/visible immediately (see EPBDS-16088 above). Cloning onto a specific `branch` still writes directly to the repository's Git via the files API (one commit per file, not atomic, bypassing OpenL's workspace indexing) — a branch clone may not appear in `openl_list_projects` until OpenL re-indexes the repository, and there is currently no API to trigger re-indexing on demand.
- A blank project is always created on the repository's default branch (the create endpoint cannot target a branch).

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
