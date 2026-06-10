# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `openl_append_table` / `openl_update_table` now handle the table id becoming stale after an edit (EPBDS-16084). OpenL Studio derives table ids from the table's content/position, so every successful edit changes the edited table's id; previously the post-edit recompile read silently failed and any client that kept the pre-edit id permanently lost access to the table. The edit tools now re-resolve the table's current id after the edit, return it as `tableId` in the response (with `previousTableId`/`tableIdChanged` when it changed), record the rename, and use the new id for the recompile read. `openl_get_table`, `openl_update_table`, and `openl_append_table` transparently resolve ids that went stale through an edit made via this server.
- `openl_append_table` with `tableType: RawSource` now validates the row width against the table's actual column count before writing (EPBDS-16085). Previously a row with too few cells was accepted and persisted with the remaining cells silently blank; now the call fails with a clear validation error and nothing is written.
- 404 errors from table endpoints now explain that table ids go stale after edits — that the preceding edit was applied (not rolled back) and how to refresh ids — instead of a bare "The table is not found" (EPBDS-16086).

### Added

- `openl_create_project` - create a new project in a design repository, in one of two modes (EPBDS-15661):
  - **blank** (omit `template`): create an empty project from the bundled skeleton; committed atomically on the repository's default branch and returns the commit hash.
  - **clone** (`template` = an existing project name): copy the source project's full structure (rules, tests, settings, examples) into the new project and rename it in `rules.xml`, matching OpenL Studio's Copy Project; `branch` is honored.

  Name collisions return 409, a missing clone source returns 404, and missing permission returns 403.

### Notes

- Cloning (`openl_create_project` with `template`) writes directly to the repository's Git via the files API, which bypasses OpenL's workspace indexing. The clone is committed, but the new project may not appear in `openl_list_projects` (and its commit revision may be unavailable) until OpenL re-indexes the repository — there is currently no API to trigger re-indexing on demand.
- Targeting a specific `branch` is supported when cloning; a blank project is always created on the repository's default branch (the create endpoint cannot target a branch).

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
