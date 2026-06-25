# OpenL MCP Server - Agent Description

## Overview

The OpenL MCP Server is a Model Context Protocol (MCP) server that provides AI coding agents with seamless access to the OpenL Studio Business Rules Management System (BRMS). It acts as a bridge between AI assistants (like Claude Code, Claude Desktop, Cursor, and VS Code / GitHub Copilot) and the OpenL Studio API, enabling natural language interaction with business rules management.

## Purpose

This MCP server enables AI agents to:
- **Discover** repositories, projects, and rules in OpenL Studio
- **Read** project structures, table definitions, and rule logic
- **Modify** rules, tables, and project configurations
- **Test** rules by running project tests and inspecting results
- **Deploy** projects to production environments
- **Manage** version control and Git-based history

## Architecture

```text
┌─────────────────┐
│ AI Assistant    │  ← Claude Desktop, Cursor IDE, etc.
│ (MCP Client)    │
└────────┬────────┘
         │ MCP Protocol
         │ (stdio / Streamable HTTP)
         ▼
┌─────────────────┐
│  MCP Server     │  ← This Agent (Node.js/TypeScript)
│  (openl-mcp)    │
└────────┬────────┘
         │ HTTP API (JSON, PAT)
         │ + WebSocket/STOMP (waits for async studio work:
         │   compile status & trace status topics)
         ▼
┌─────────────────┐
│ OpenL Studio   │  ← Business Rules Server
│  (Java/Jetty)   │     (port 8080)
└─────────────────┘
```

Most traffic is plain REST. The WebSocket (STOMP) channel is used only to wait, inside a single tool call, for the studio's asynchronous work — project compilation (`openl_project_status` with `wait: true`, the `openl://status/...` resource) and trace execution (`openl_get_trace_nodes` / `openl_export_trace` while the trace is running) — instead of forcing the agent to poll. Details: [docs/development/websockets.md](docs/development/websockets.md).

## Capabilities

### 1. Repository Management
- List design repositories
- List deployment repositories
- List Git branches
- Get repository features
- View project revision history

### 2. Project Lifecycle
- List projects with filtering (repository, status, tags)
- Get comprehensive project details
- Create new projects from a blank skeleton, or by cloning an existing project (full copy + rename)
- Open projects (with branch/revision support)
- Save project changes (with validation)
- Close projects (with save/discard safety checks)
- Create project branches
- View local change history
- Restore previous versions

### 3. Rules & Tables Management
- List all tables/rules in a project
- Get detailed table structure and data
- Update entire tables (modify, delete, reorder rows)
- Append rows/fields to tables (additive changes)
- Create new tables programmatically

### 4. Project Files (BETA)
- Read any project file by path (text returned verbatim, binary as base64) with optional byte range
- List folders (flat or nested, recursive, with extension/name filters) and read file metadata
- Write files to the project working copy (UTF-8 or base64; commit via save)
- Delete files/folders (auto-cleans dangling config references)
- Search by glob pattern, extensions, type, or case-insensitive content substring
- Copy and move/rename files within a project

### 5. Version Control
- View committed project revision history
- View uncommitted workspace change history
- Restore previous workspace versions

### 6. Testing & Validation
- Run project tests (all or specific tables) and inspect results
- Check project status for compile state and diagnostics (errors/warnings with location)

### 7. Trace (BETA)
- Start trace execution for rules/test tables
- Get trace tree nodes and node details
- Inspect parameters, context, and results
- Export trace as text
- Cancel ongoing trace

### 8. Deployment
- List active deployments
- Deploy projects to production
- Redeploy with new versions

## Tools (52 Total)

All tools are prefixed with `openl_` and versioned (v1.0.0+).

### Repository Tools (4)
- `openl_list_repositories` - List all design repositories
- `openl_list_branches` - List Git branches in a repository
- `openl_list_repository_features` - Get repository capabilities
- `openl_repository_project_revisions` - Get project revision history

### Project Tools (14)
- `openl_list_projects` - List projects with filters
- `openl_get_project` - Get project details
- `openl_project_status` - Get project compile state and diagnostics (errors/warnings with location)
- `openl_create_project` - Create a new project: omit `template` for a BLANK project (atomic commit on the default branch; returns commit revision), or pass `template` = an existing project name to CLONE it (full copy + rename in rules.xml). A default (branch-less) clone is committed atomically and indexed, so it appears in `openl_list_projects` immediately. Cloning onto a specific `branch` writes directly to repository Git via the files API, so a branch clone may not appear in `openl_list_projects` (and its revision may be unavailable) until OpenL re-indexes the repository
- `openl_open_project` - Open project for editing (supports branch/revision switching)
- `openl_save_project` - Save project changes to Git with validation
- `openl_close_project` - Close project with save/discard options (prevents data loss)
- `openl_create_project_branch` - Create new branch
- `openl_list_project_local_changes` - View workspace history
- `openl_restore_project_local_change` - Restore previous version
- `openl_start_project_tests` - Start project test execution
- `openl_get_test_results_summary` - Get brief test execution summary
- `openl_get_test_results` - Get full test execution results with pagination
- `openl_get_test_results_by_table` - Get test results filtered by table ID

### Rules/Tables Tools (6)
- `openl_list_tables` - List all tables in project
- `openl_get_table` - Get table structure and data (use `raw=true` for raw 2D cell matrix view)
- `openl_update_table` - Replace entire table
- `openl_append_table` - Add rows/fields to table
- `openl_create_project_table` - Create new table
- `openl_delete_table` - Delete an entire table (to remove a row/column WITHIN a table, use the raw action tools below)

### Raw Table-Source Action Tools (11)
Apply a SINGLE in-place edit to a table's raw source (any table type). Positions are 0-based (row 0 is the header, column 0 the leading labels). An edit that relocates the table changes its id; each tool returns the table's CURRENT `tableId` (plus `previousTableId` when it changed) and reads the table back to trigger a recompile.
- `openl_append_table_row` - Add a row to the end (optional `cells`)
- `openl_append_table_column` - Add a column to the end (optional `cells`)
- `openl_insert_table_row` - Insert a row at `position` (optional `cells`)
- `openl_insert_table_column` - Insert a column at `position` (optional `cells`)
- `openl_delete_table_row` - Delete the row at `position`
- `openl_delete_table_column` - Delete the column at `position`
- `openl_update_table_row` - Overwrite the row at `position` (optional `cells`)
- `openl_update_table_column` - Overwrite the column at `position` (optional `cells`)
- `openl_update_table_cell` - Set a single cell's value at (`row`, `column`)
- `openl_merge_table_cells` - Merge a `rowspan`×`colspan` range from (`row`, `column`)
- `openl_unmerge_table_cells` - Unmerge the cell covering (`row`, `column`)

### Project Files Tools (7, BETA)
Operate on ANY file in a project by exact project-relative path (not just Excel rule files). Writes/deletes/copies/moves land in the project **working copy** — commit them with `openl_save_project`. Use the optional `branch` to pin the project's branch (omit for `local`/non-branch repositories).
- `openl_read_project_file` - Read a file (text verbatim, binary as base64; optional `offset`/`length` byte range), read file metadata (`view: "meta"`), or list a folder (`recursive`, `viewMode` FLAT/NESTED, `extensions`, `namePattern`, `foldersOnly`); optional `version` reads a historical revision
- `openl_write_project_file` - Create/replace a file from UTF-8 or base64 `content`; `createFolders` (default true), `conflictPolicy` FAIL/OVERWRITE/SKIP
- `openl_delete_project_file` - Delete a file/folder (auto-cleans dangling config references)
- `openl_search_project_files` - Search by glob `pattern`, `extensions`, `type`, or case-insensitive `content` substring; `scope` SUBTREE (default) or ANCESTORS
- `openl_copy_project_file` - Copy a file within the project (no overwrite — destination collision returns 409)
- `openl_move_project_file` - Move or rename a file within the project
- `openl_get_project_agents_md` - Load the **AGENTS.md** guidance for a project as a **single aggregated markdown document**: walks UP from the project (or an optional `folder`) to the repository root, collects every applicable `AGENTS.md`, and returns them concatenated in one response — ordered from the root folder (lowest priority) down to the project folder (highest priority), later sections winning on conflict. (Also exposed as the `openl://docs/{project}/AGENTS.md` resource.)

### Trace Tools (6, BETA)
- `openl_start_trace` - Start trace execution for a table
- `openl_get_trace_nodes` - Get trace tree nodes (root or children)
- `openl_get_trace_node_details` - Get node details (parameters, context, result)
- `openl_get_trace_parameter` - Get lazy-loaded parameter value
- `openl_cancel_trace` - Cancel ongoing trace
- `openl_export_trace` - Export trace as text

### Deployment (4)
- `openl_list_deploy_repositories` - List deployment repositories
- `openl_list_deployments` - List active deployments
- `openl_deploy_project` - Deploy to production
- `openl_redeploy_project` - Redeploy with new version

## Local projects (repository: local)

Projects with `repository: 'local'` are stored on disk without Git; **OPENED/EDITING status is not checked or required** for them — local projects are always considered editable.

**For local, these work:**
- `openl_list_projects` (call without repository filter, then filter by `repository: "local"` in the response; the `repository: "local"` filter may fail because the "local" repository is often not returned by `openl_list_repositories`), `openl_get_project`;
- Table tools: `openl_list_tables`, `openl_get_table`, `openl_update_table`, `openl_append_table`, `openl_create_project_table`, `openl_delete_table`, and the raw table-source action tools (`openl_insert_table_row`/`openl_delete_table_row`/`openl_update_table_cell`/`openl_merge_table_cells`/…);
- Test execution and results: `openl_start_project_tests`, `openl_get_test_results_summary`, `openl_get_test_results`, `openl_get_test_results_by_table` (the project is not opened before running tests for local).

**For local, do not use:**
- `openl_open_project`, `openl_save_project`, `openl_close_project` (no commits or status changes);
- Git tools: `openl_list_branches`, `openl_create_project_branch`, `openl_repository_project_revisions`;
- `openl_list_project_local_changes`, `openl_restore_project_local_change` (require an opened project; local projects cannot be opened).

Deployment (`openl_deploy_project`, `openl_redeploy_project`) for projects with `repository: 'local'` is typically not used via the studio.

## Prompts (14 Total)

Expert guidance templates for complex OpenL workflows:

1. **local_projects** - Working with projects in repository 'local' (no open/save/close; table/rule/test tools only)
2. **create_rule** - Guide for creating OpenL tables (general overview)
3. **create_rule_decision_tables** - Comprehensive guide for decision tables (Rules, SimpleRules, SmartRules, SimpleLookup, SmartLookup)
4. **create_rule_spreadsheet** - Detailed guide for Spreadsheet tables with formula syntax and JSON structure
5. **create_test** - Guide for creating test tables
6. **update_test** - Guide for modifying tests
7. **run_test** - Test execution workflow
8. **append_table** - Incremental table updates
9. **datatype_vocabulary** - Data structure definitions
10. **dimension_properties** - Context-based rule selection
11. **deploy_project** - Deployment workflow
12. **project_history** - Project audit trail
13. **validate_after_edit** - Post-edit validation workflow (compile state, error surfacing, re-validation)
14. **project_agents_md** - Load and apply a project's AGENTS.md guidance (walk up to repo root; nearest-file-wins)

## Resources

MCP resources provide read-only access to OpenL data:

- `openl://repositories` - All design repositories
- `openl://projects` - All projects
- `openl://projects/{projectId}` - Specific project details
- `openl://projects/{projectId}/tables` - Project tables
- `openl://projects/{projectId}/tables/{tableId}` - Specific table
- `openl://projects/{projectId}/history` - Project Git history
- `openl://projects/{projectId}/files/{filePath}` - Download file
- `openl://docs/{project}/AGENTS.md` - The project's applicable **AGENTS.md** guidance as one aggregated markdown document (root-first, later sections win); mirrors `openl_get_project_agents_md`
- `openl://deployments` - All deployments

## Authentication

The agent authenticates with a Personal Access Token (PAT). Authentication is
optional — an OpenL Studio in single-user mode accepts unauthenticated requests.

```env
OPENL_PERSONAL_ACCESS_TOKEN=openl_pat_your-token
```

## Configuration

### Environment Variables

**Required:**
- `OPENL_BASE_URL` - OpenL API base URL (e.g., `http://localhost:8080`)

**Authentication (optional — omit for single-user mode):**
- `OPENL_PERSONAL_ACCESS_TOKEN` (PAT)

**Optional:**
- `OPENL_TIMEOUT` - Request timeout in milliseconds (default: 30000)

### Transport Modes

1. **stdio** (default) - for MCP clients (Claude Code, Claude Desktop, Cursor, VS Code) that launch the server via `npx` or Docker
2. **Streamable HTTP** - MCP spec 2025-11-25 transport at `POST/GET/DELETE /mcp`, enabled with `--http` (for one shared server that several clients connect to)

## Key Features

### Type Safety
- Zod schemas for input validation
- TypeScript types for all API responses
- Compile-time type checking

### Error Handling
- Detailed error messages with context
- Actionable suggestions for fixes
- Automatic credential redaction in logs

### Response Formatting
- Multiple formats: `json`, `markdown`, `markdown_concise`, `markdown_detailed`
- Automatic truncation for large responses (25K character limit)
- Pagination support with metadata

### Security
- Credentials never logged
- Request tracking via Client Document ID (OPENL_CLIENT_DOCUMENT_ID) for audit and debugging

## Security Best Practices for AI Agents

### Critical Rule: Never Write Sensitive Data in Code

When writing code, configuration files, or examples as an AI agent:

**❌ NEVER DO THIS:**
- Hardcode passwords, tokens, or API keys in source code
- Commit files with real credentials to Git
- Use real values in examples or documentation

**✅ ALWAYS DO THIS:**
- Use environment variables: `process.env.VARIABLE_NAME`
- Use placeholders in examples: `<your-token>`
- Create `.env.example` files with placeholders
- Add `.env` to `.gitignore`

### Examples

**Wrong:**
```typescript
const token = "openl_pat_abc123.xyz789"; // ❌ Real token in code
```

**Correct:**
```typescript
const token = process.env.OPENL_PERSONAL_ACCESS_TOKEN; // ✅ From environment

if (!token) {
  throw new Error("OPENL_PERSONAL_ACCESS_TOKEN is required");
}
```

### When Creating Configuration Examples

Always use placeholders:
```json
{
  "OPENL_BASE_URL": "http://localhost:8080",
  "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>"
}
```

### Environment Variables Best Practices

1. **For local development:**
   - Use `.env` files (never commit these)
   - Create `.env.example` with placeholders
   - Add `.env` to `.gitignore`

2. **For production:**
   - Use secure vaults or secret management systems
   - Never hardcode credentials in deployment configs
   - Rotate credentials regularly

3. **When writing code:**
   - Always read from `process.env`
   - Validate that required variables are set
   - Provide clear error messages if variables are missing

**Remember:** Never use real values, even in examples or test code. Always use placeholders or environment variables.

### OpenL-Specific Features
- Dual versioning (Git commits + dimension properties)
- Table type awareness (Rules, Spreadsheet, Datatype, etc.)
- Project ID format handling (current and legacy path formats)

## Usage Examples

### List Repositories
```json
{
  "tool": "openl_list_repositories",
  "arguments": {
    "response_format": "markdown"
  }
}
```

### Get Project Details
```json
{
 "tool": "openl_get_project",
 "arguments": {
 "projectId": "<PROJECT_ID>",
 "response_format": "<RESPONSE_FORMAT>"
 }
}
```

### Open Project
```json
{
 "tool": "openl_open_project",
 "arguments": {
 "projectId": "<PROJECT_ID>",
 "branch": "<BRANCH>"
 }
}
```

### Save Project
```json
{
 "tool": "openl_save_project",
 "arguments": {
 "projectId": "<PROJECT_ID>",
 "comment": "<COMMENT>"
 }
}
```

### Close Project
```json
{
 "tool": "openl_close_project",
 "arguments": {
 "projectId": "<PROJECT_ID>",
 "saveChanges": <SAVE_CHANGES>,
 "comment": "<COMMENT>"
 }
}
```

### Run Project Tests
```json
{
  "tool": "openl_start_project_tests",
  "arguments": {
    "projectId": "<PROJECT_ID>"
  }
}
```

## Technical Stack

- **Language**: TypeScript (ES2020+)
- **Runtime**: Node.js 24+
- **MCP SDK**: @modelcontextprotocol/sdk v1.29.0
- **HTTP Client**: axios
- **Validation**: Zod
- **Testing**: Jest
- **Build**: TypeScript Compiler

## Project Structure

```text
openl-mcp/
├── src/                    # Source code
│   ├── index.ts           # Binary entry point / transport dispatcher
│   ├── stdio-server.ts    # stdio transport (Claude Desktop / Cursor)
│   ├── http-server.ts     # HTTP server (Streamable HTTP transport at /mcp)
│   ├── mcp-core.ts        # Shared MCP core (handlers) for both transports
│   ├── client.ts          # OpenL API client
│   ├── handlers/          # Per-category tool registry + register*Handlers/executeTool
│   ├── auth.ts            # Authentication (Basic/PAT)
│   ├── schemas.ts         # Zod validation schemas
│   ├── prompts.ts         # Prompt definitions
│   └── ...
├── tests/                  # Test suites
├── prompts/               # Prompt templates (markdown)
├── docs/                  # Documentation
└── dist/                  # Compiled output
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run in development mode
npm run watch
```

## Deployment

The server ships only as the npm package `openl-mcp`. There is no custom
Docker image — run it with Node.js via `npx`, or on the official Node image when
Node.js isn't available.

### With Node.js (stdio)
```bash
npx -y openl-mcp http://localhost:8080
```

### Without Node.js (Docker)
```bash
docker run --rm -i node:lts-alpine npx -y openl-mcp http://host.docker.internal:8080
```

### Shared HTTP server / full stack
Add `--http` to serve MCP over HTTP at `/mcp`, or use [`compose.yaml`](compose.yaml)
to run OpenL Studio + the MCP server together (`docker compose up -d`). See
[docs/setup/docker.md](docs/setup/docker.md).

## Version

**Current Version**: 1.0.0  
**MCP SDK**: 1.26.0  
**Node.js**: 24+  
**OpenL Studio**: 6.0.0+

## License

LGPL-3.0 (follows OpenL Studio project license)

## External Resources

- [OpenL Studio](https://github.com/openl-tablets/openl-tablets)
- [OpenL Documentation](https://openl-tablets.org/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
