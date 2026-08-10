# MCP Tools Review - OpenL Studio API Comparison

**Date**: 2025-01-27  
**Version**: 1.0.0  
**Purpose**: Review MCP tools against OpenL Studio API to identify missing inputs, extra parameters, and recommendations

---

## Local projects (repository: local)

Projects with `repository: 'local'` are stored on disk without Git. For them, **open/save/close** and **Git-related tools** are not supported; **table/rule/test tools** work without opening the project.

| Tool group | Tools | Local |
|------------|--------|--------|
| Repositories/projects | `openl_list_repositories`, `openl_list_repository_features`, `openl_list_projects`, `openl_get_project` | ✅ Supported. Note: `openl_list_projects(repository: "local")` may fail if "local" is not in list_repositories; list without filter then filter by `repository === "local"` in response. For repo "local", branches/versions N/A |
| Open/save/close | `openl_open_project`, `openl_save_project`, `openl_close_project` | ❌ Blocked in MCP and API |
| Git (branches, history) | `openl_list_branches`, `openl_create_project_branch`, `openl_repository_project_revisions` | ❌ Not applicable (no Git) |
| Session history | `openl_list_project_local_changes`, `openl_restore_project_local_change` | ❌ Require opened project; local cannot be opened |
| Tables/tests | `openl_list_tables`, `openl_get_table`, `openl_update_table`, `openl_append_table`, `openl_create_project_table`, `openl_delete_table`, the raw table-source action tools (`openl_insert_table_rows`, `openl_delete_table_rows`, `openl_update_table_cell`, `openl_merge_table_cells`, …), `openl_start_project_tests`, `openl_get_test_results_*` | ✅ Allowed; no OPENED/EDITING check; tests run without open |
| Project files | `openl_read_project_file`, `openl_write_project_file`, `openl_search_project_files`, `openl_copy_project_file`, `openl_move_project_file`, `openl_delete_project_file` | ✅ Work directly on project files |
| Deploy | `openl_list_deploy_repositories`, `openl_list_deployments`, `openl_deploy_project`, `openl_redeploy_project` | Deploy from design repo; local usually not used |

See **AGENTS.md** § "Local projects (repository: local)" for agent-facing summary.

---

## Repository Tools

### 1. `openl_list_repositories`

**Status**: ✅ Complete
**OpenL API**: `GET /repos`

**Extra/Missed Inputs**:
- ✅ No missing inputs - API has no query parameters

**Recommendations**:
- None - tool matches API perfectly

---

### 2. `openl_list_branches`

**Status**: ✅ Complete  
**OpenL API**: `GET /repos/{repository}/branches`

**Extra/Missed Inputs**:
- ✅ No missing inputs - API has no query parameters

**Recommendations**:
- None - tool matches API perfectly

---

### 3. `openl_list_repository_features`

**Status**: ✅ Complete  
**OpenL API**: `GET /repos` (`features` is embedded in the matching repository)

**Extra/Missed Inputs**:
- ✅ Accepts a repository ID or display name and resolves it case-insensitively
- ✅ Returns the matching repository's embedded `features` object without calling a separate endpoint

**Recommendations**:
- None - tool matches the current repository contract

---

### 4. `openl_list_deploy_repositories`

**Status**: ✅ Complete  
**OpenL API**: `GET /production-repos`

**Extra/Missed Inputs**:
- ✅ No missing inputs - API has no query parameters

**Recommendations**:
- None

---

## Project Tools

### 5. `openl_list_projects`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects` with filters and `offset`/`size`

**Extra/Missed Inputs**:
- ✅ Current filters covered: `repository`, `status`, `dependsOn`, `name`, `author`, `branch`, `sort`, `include`, `tags`
- ✅ MCP `limit` maps to API `size`; `offset` is passed through exactly

**Recommendations**:
- None - tool matches API perfectly

---

### 6. `openl_get_project`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects/{projectId}`

**Extra/Missed Inputs**:
- ✅ Always requests `raw=true`; supports `startRow`, `maxRows`, and `styles`
- ✅ Returns only the authoritative `RawTableView` cell matrix
- ✅ Treats styles as read-only; write schemas reject `style` because Studio ignores formatting updates

**Recommendations**:
- Do not expose Studio's typed/parsed table views. They are incomplete and lossy.
- Never pass a window carrying `totalRows` to `openl_update_table`; read the complete matrix first or use a narrow raw action.
- Read with `styles=true` only for inspection; read without styles before a full update.

---

### 7. `openl_open_project`, `openl_save_project`, `openl_close_project`

**Status**: ✅ Complete  
**OpenL API**: 
- `openl_open_project`: `PATCH /projects/{projectId}` with `status: "OPENED"`
- `openl_save_project`: `PATCH /projects/{projectId}` with `{ comment }` (Update project status API; when project is modified and comment present, server saves and commits; no separate `/save` endpoint)
- `openl_close_project`: `PATCH /projects/{projectId}` with `status: "CLOSED"`

**Extra/Missed Inputs**:
- ✅ Covered: `branch`, `revision` (in `openl_open_project`)
- ✅ Covered: `comment` (in `openl_save_project` and `openl_close_project`)
- ✅ Covered: `saveChanges`, `discardChanges` (in `openl_close_project` for safety)

**Recommendations**:
- ✅ Implemented: Tools provide clear separation of concerns
- ✅ Implemented: Safety checks prevent accidental data loss
- ✅ Implemented: Save via PATCH with comment (backend has no separate save endpoint)

---

## File Management Tools

Project files are managed through the binary-safe file tools `openl_read_project_file`,
`openl_write_project_file`, `openl_search_project_files`, `openl_copy_project_file`,
`openl_move_project_file`, and `openl_delete_project_file`.

`openl_search_project_files.content` is text-only: Studio does not index or
inspect XLSX, ZIP, images, or other binary formats. Binary files can be located
by path pattern/extension and then read separately.

MCP binary reads use a JSON TextContent envelope with base64 `content`, `mimeType`,
and byte-range metadata; binary writes accept the `blob` parameter whose JSON Schema declares
`contentEncoding: "base64"` and `contentMediaType: "application/octet-stream"`.
The old `content` plus `encoding: "base64"` request remains accepted for compatibility.

> **Removed**: there is no separate Excel-file upload/download tool. The earlier
> `openl_upload_file` / `openl_download_file` tools have been removed and have no
> one-purpose replacement; the generic project-file tools handle Excel and other
> binary files through standard MCP binary content.

---

## Table/Rule Tools

### 10. `openl_list_tables`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects/{projectId}/tables` with filters and `offset`/`size`

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `kind` (array), `name`, `properties`
- ✅ MCP `limit` maps to API `size`; `offset` is passed through exactly

**Recommendations**:
- None - tool matches API perfectly

---

### 11. `openl_get_table`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects/{projectId}/tables/{tableId}`

**Extra/Missed Inputs**:
- ✅ No missing inputs

**Recommendations**:
- None

---

### 12. `openl_update_table`

**Status**: ✅ Complete  
**OpenL API**: `PUT /projects/{projectId}/tables/{tableId}` with `RawTableView`

**Extra/Missed Inputs**:
- ✅ Covered: `projectId`, `tableId`, `view` (complete RawSource matrix)
- ✅ All required API parameters are covered

**Recommendations**:
- Keep `tableType: "RawSource"` as the only accepted content discriminator.

---

### 13. `openl_append_table`

**Status**: ✅ Complete  
**OpenL API**: `POST /projects/{projectId}/tables/{tableId}/lines` with `RawTableAppend`

**Extra/Missed Inputs**:
- ✅ Covered: `projectId`, `tableId`, `appendData` (non-empty full-width raw rows)
- ✅ All required API parameters are covered

**Recommendations**:
- Keep typed append DTOs out of MCP; validate raw row width before writing.

---

### 14. `openl_create_project_table` (NEW - BETA API)

**Status**: ✅ ACTIVE  
**OpenL API**: `POST /projects/{projectId}/tables` (BETA API with `CreateNewTableRequest`)

**Extra/Missed Inputs**:
- ✅ Covered: `projectId`, `moduleName`, `modulePath`, `sheetName`, `table` (`RawTableView` with nonblank name)

**Recommendations**:
- ✅ Tool uses BETA API format which works correctly in OpenL 6.0.0+
- ✅ Requires a complete `RawSource` structure; use `get_table()` and bundled guides as references
- ✅ Any semantic OpenL table kind can be encoded in the raw workbook grid
- ❌ Typed Rules/Spreadsheet/Datatype/Test request variants must not be exposed

---

## Deployment Tools

### 15. `openl_list_deployments`

**Status**: ✅ Complete
**OpenL API**: `GET /deployments?repository={repository}&project={project}`

**Extra/Missed Inputs**:
- ✅ Supports the backend `repository` and `project` filters

**Recommendations**:
- None

---

### 16. `openl_deploy_project`

**Status**: ✅ Complete  
**OpenL API**: `POST /deployments` with `DeployProjectRequest`

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `projectId`, `deploymentName`, `productionRepositoryId`, `comment`

**Recommendations**:
- None

---

### 17. `openl_redeploy_project`

**Status**: ✅ Complete  
**OpenL API**: `POST /deployments/{deploymentId}` with `RedeployProjectRequest`

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `deploymentId`, `projectId`, `comment`

**Recommendations**:
- None

---

## Version Control Tools

### 18. `openl_create_project_branch`

**Status**: ✅ Complete  
**OpenL API**: `POST /projects/{projectId}/branches` with `CreateBranchModel`

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `projectId`, `branchName`, `revision` (optional)

**Recommendations**:
- None

---

### 19. `openl_repository_project_revisions`

**Status**: ✅ Complete  
**OpenL API**: `GET /repos/{repository}/projects/{projectName}/history?branch={branch}&search={search}&techRevs={techRevs}&page={page}&size={size}`

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `repository`, `projectName`, `branch`, `search`, `techRevs`, `page`, `size`

**Recommendations**:
- None - tool matches API perfectly

---

### 20. `openl_list_project_local_changes`

**Status**: ✅ Complete  
**OpenL API**: `GET /history/project` (session-based, requires project to be open)

**Extra/Missed Inputs**:
- ✅ Covered: No `projectId` parameter needed (endpoint uses session-based project context)

**Recommendations**:
- Document that project must be opened in OpenL Studio session first (use `openl_open_project` to open the project)
- Consider adding validation to check if project is open before calling

---

### 21. `openl_restore_project_local_change`

**Status**: ✅ Complete  
**OpenL API**: `POST /history/restore` with `historyId` (text/plain body)

**Extra/Missed Inputs**:
- ✅ Covered: `historyId` (no `projectId` parameter needed - endpoint uses session-based project context)

**Recommendations**:
- Document that project must be opened in OpenL Studio session first (use `openl_open_project` to open the project)

---

> **Removed**: `openl_revert_version`, `openl_get_file_history`, and
> `openl_get_project_history` have been removed (no backing API endpoint).
> There is no MCP replacement for git revert or single-file history. For
> project history use `openl_repository_project_revisions` (committed revisions)
> and `openl_list_project_local_changes` (uncommitted workspace history).

---

## Testing & Validation Tools

### 25. `openl_start_project_tests`

**Status**: ✅ Complete  
**OpenL API**: `POST /projects/{projectId}/tests/run`

**Description**: Start project test execution. The project will be automatically opened if closed. Returns execution status and metadata. Test results can be retrieved using separate tools.

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `projectId`, `tableId`, `testRanges`
- ✅ Automatically opens project if closed
- ✅ Automatically captures and stores HTTP headers from test start response for use in result retrieval tools
- ✅ `fromModule` is passed to the Studio API

**Recommendations**:
- ✅ Preferred tool for starting test execution
- ✅ Headers from start response are automatically stored for use in `openl_get_test_results*` tools
- ✅ Supports table filtering and test ranges
- ✅ Ensures project is opened before running tests

---

### 26. `openl_get_test_results_summary`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects/{projectId}/tests/summary`

**Description**: Get brief test execution summary without detailed test cases. Returns aggregated statistics (execution time, total tests, passed, failed) without the testCases array.

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `projectId`, `failures`, `unpaged`
- ✅ Uses stored headers from test execution session
- ✅ Returns only summary fields (no testCases array)

**Recommendations**:
- ✅ Use for quick status checks without loading full test details
- ✅ Requires test execution to be started first with `openl_start_project_tests`

---

### 27. `openl_get_test_results`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects/{projectId}/tests/summary`

**Description**: Get full test execution results with pagination support. Returns complete test execution summary including testCases array grouped by table. **IMPORTANT**: Pagination applies to test tables (not individual test cases). Each page returns test results aggregated by table (e.g., 'TestTable1' with 7 tests, 'TestTable2' with 8 tests).

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `projectId`, `failuresOnly`, `failures`, `page`, `offset`, `size`, `limit` (alias for size), `unpaged`
- ✅ Validates mutual exclusivity: `page` vs `offset`, `unpaged` vs `page`/`offset`/`size`
- ✅ Uses stored headers from test execution session
- ✅ Supports pagination and filtering
- ⚠️ **Note**: Pagination is per-table, not per-test-case. If a project has 5 test tables, pagination will show these 5 tables across pages, not individual test cases.

**Recommendations**:
- ✅ Use for full test results with pagination
- ✅ Requires test execution to be started first with `openl_start_project_tests`
- ✅ Supports pagination options: page-based or offset-based
- ⚠️ **Important**: Understand that pagination controls which test tables are shown, not individual test cases within tables
- ⚠️ **Note**: The 'unpaged' parameter may not work correctly on the backend - use pagination (page/offset/size) instead

---

### 28. `openl_get_test_results_by_table`

**Status**: ✅ Complete  
**OpenL API**: `GET /projects/{projectId}/tests/summary` + client-side filtering

**Description**: Get test execution results filtered by specific table ID. Returns filtered test execution summary with only test cases for the specified table.

**Extra/Missed Inputs**:
- ✅ All API parameters covered: `projectId`, `tableId`, `failuresOnly`, `failures`, `unpaged`
- ✅ Uses stored headers from test execution session
- ✅ Filters testCases by tableId on client side
- ⚠️ **Note**: The 'unpaged' parameter may not work correctly on the backend - use pagination if needed

**Recommendations**:
- ✅ Use for getting results for a specific table
- ✅ Requires test execution to be started first with `openl_start_project_tests`
- ✅ Filters results on client side after retrieving from API

---

### 29. `openl_project_status`

**Status**: ✅ Complete  
**OpenL API**: project compilation/validation state

**Description**: Returns the project's `compileState` plus diagnostics (errors and
warnings with their location). This is the supported way to check a project for
compilation errors. Saving a project (`openl_save_project`) also validates it.

**Recommendations**:
- ✅ Use `openl_project_status` to validate a project and surface errors/warnings.

> **Removed**: the previously proposed `openl_validate_project` and
> `openl_get_project_errors` tools were never registered and have been dropped.
> Use `openl_project_status` instead.

---

## Execution Tools

> **Removed**: `openl_execute_rule` has been removed. There is no MCP tool for
> executing a rule with input data; run a project's test tables with
> `openl_start_project_tests` and read results via `openl_get_test_results` /
> `openl_get_test_results_summary` / `openl_get_test_results_by_table`.

---

## Comparison Tools

> **Removed**: the previously proposed `openl_compare_versions` tool was never
> registered and has been dropped. There is no MCP tool for comparing two
> versions.

---

## Historical Project Lifecycle Review

### 34. `saveProject` (Missing Tool - RESOLVED)

**Status**: ❌ MISSING TOOL  
**OpenL API**: `POST /projects/{projectId}/save?comment={comment}`

**Extra/Missed Inputs**:
- Client method exists: `saveProject(projectId, comment)`
- Schema exists: `saveProjectSchema`
- **Tool is not registered**

**Recommendations**:
- **ADD TOOL**: Create `openl_save_project` tool
- ✅ **RESOLVED**: `openl_save_project` tool now available (v1.0.0)
- Should validate project before saving (client already does this)

---

### 35. `openProject` / `closeProject` (Missing Tools - RESOLVED)

**Status**: ❌ MISSING TOOLS  
**OpenL API**: `PATCH /projects/{projectId}` with `status: "OPENED"` or `status: "CLOSED"`

**Extra/Missed Inputs**:
- Client methods exist: `openProject(projectId, options)`, `closeProject(projectId, comment)`
- ✅ **RESOLVED**: Tools are now registered as `openl_open_project`, `openl_save_project`, `openl_close_project`

**Recommendations**:
- Consider adding dedicated `openl_open_project` and `openl_close_project` tools for clarity
- ✅ **RESOLVED**: Use `openl_save_project` for saving changes
- Current approach (unified tool) is fine, but dedicated tools may be more intuitive

---

### 36. `openl_health_check` (Missing Tool)

**Status**: ❌ MISSING TOOL  
**OpenL API**: Uses `GET /repos` as connectivity check

**Extra/Missed Inputs**:
- Client method exists: `healthCheck()`
- **Tool is not registered**

**Recommendations**:
- **ADD TOOL**: Create `openl_health_check` tool
- Very useful for debugging connection issues
- Should be exposed as a tool

---

## Complete Tools List

### Full Tools Table

The server registers **73 tools**. All are listed below.

| # | Tool Name | Category | Status | OpenL API Endpoint | Description |
|---|-----------|----------|--------|-------------------|-------------|
| 1 | `openl_list_repositories` | Repository | ✅ Complete | `GET /repos` | List all design repositories |
| 2 | `openl_list_branches` | Repository | ✅ Complete | `GET /repos/{repository}/branches` | List Git branches in a repository |
| 3 | `openl_list_repository_features` | Repository | ✅ Complete | `GET /repos` | Get embedded repository features (branching, mapped folders, searchable) |
| 4 | `openl_list_deploy_repositories` | Deployment | ✅ Complete | `GET /production-repos` | List all deployment repositories |
| 5 | `openl_list_projects` | Project | ✅ Complete | `GET /projects?...&offset={offset}&size={size}` | List projects with current Studio filters and exact item-offset pagination |
| 6 | `openl_get_project` | Project | ✅ Complete | `GET /projects/{projectId}` | Get comprehensive project information |
| 7 | `openl_create_project` | Project | ✅ Complete | `PUT /repos/{repo}/projects/{name}` / `POST .../from-project` | Create or copy a project on an optional target branch |
| 8 | `openl_open_project` | Project | ✅ Complete | `PATCH /projects/{projectId}` with `status: "OPENED"` | Open project for editing (supports branch/revision) |
| 9 | `openl_save_project` | Project | ✅ Complete | `PATCH /projects/{projectId}` with `{ comment }` | Save project changes to Git (validates on save) |
| 10 | `openl_close_project` | Project | ✅ Complete | `PATCH /projects/{projectId}` with `status: "CLOSED"` | Close project (with save/discard safety checks) |
| 11 | `openl_project_status` | Project | ✅ Complete | project compile state + diagnostics | Get `compileState` plus errors/warnings with location |
| 12 | `openl_get_project_agent_context` | Guidance | ✅ Complete | project AGENTS.md chain (file-search, ANCESTORS scope) | Resolve the AGENTS.md hierarchy applying to a project path, with referenced bundled-guide ids |
| 13 | `openl_create_project_branch` | Project | ✅ Complete | `POST /projects/{projectId}/branches` | Create new branch from revision |
| 14 | `openl_list_project_local_changes` | Project | ✅ Complete | `GET /history/project` (session-based) | List local change history (requires project open) |
| 15 | `openl_restore_project_local_change` | Project | ✅ Complete | `POST /history/restore` with `historyId` | Restore project to previous local version |
| 16 | `openl_repository_project_revisions` | Repository | ✅ Complete | `GET /repos/{repository}/projects/{projectName}/history` | Get committed project revision history |
| 17 | `openl_read_project_file` | Files | ✅ Complete | project file read | Read a file from the project |
| 18 | `openl_write_project_file` | Files | ✅ Complete | project file write | Create or overwrite a project file |
| 19 | `openl_search_project_files` | Files | ✅ Complete | project file search | Search paths and text-file content |
| 20 | `openl_copy_project_file` | Files | ✅ Complete | project file copy | Copy a project file |
| 21 | `openl_move_project_file` | Files | ✅ Complete | project file move | Move/rename a project file |
| 22 | `openl_delete_project_file` | Files | ✅ Complete | project file delete | Delete a project file |
| 23 | `openl_list_tables` | Rules | ✅ Complete | `GET /projects/{projectId}/tables?...&offset={offset}&size={size}` | List project tables/rules with exact item-offset pagination |
| 24 | `openl_get_table` | Rules | ✅ Complete | `GET /projects/{projectId}/tables/{tableId}?raw=true` | Get the RawSource matrix |
| 25 | `openl_update_table` | Rules | ✅ Complete | `PUT /projects/{projectId}/tables/{tableId}` | Replace the complete RawSource matrix |
| 26 | `openl_append_table` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/lines` | Append full-width RawSource rows |
| 27 | `openl_create_project_table` | Rules | ✅ Complete | `POST /projects/{projectId}/tables` (BETA API) | Create a table from RawSource |
| 28 | `openl_list_deployments` | Deployment | ✅ Complete | `GET /deployments?repository={repository}&project={project}` | List active deployments with backend filters |
| 29 | `openl_deploy_project` | Deployment | ✅ Complete | `POST /deployments` | Deploy project to production |
| 30 | `openl_redeploy_project` | Deployment | ✅ Complete | `POST /deployments/{deploymentId}` | Redeploy with new version |
| 31 | `openl_start_project_tests` | Testing | ✅ Complete | `POST /projects/{projectId}/tests/run` | Start project test execution |
| 32 | `openl_get_test_results_summary` | Testing | ✅ Complete | `GET /projects/{projectId}/tests/summary` | Get brief test execution summary |
| 33 | `openl_get_test_results` | Testing | ✅ Complete | `GET /projects/{projectId}/tests/summary` | Get full test execution results |
| 34 | `openl_get_test_results_by_table` | Testing | ✅ Complete | `GET /projects/{projectId}/tests/summary` + filtering | Get test results filtered by table |
| 35 | `openl_start_trace` | Trace | ✅ Complete | `POST /projects/{projectId}/trace` (+ optional `PUT /trace/breakpoints`) | Start a debug session and run to the first stop; profiling returns the bounded `profile` overview (includeTree=false) |
| 36 | `openl_step_trace` | Trace | ✅ Complete | `POST /projects/{projectId}/trace/step?type={into\|over\|out}&view=compact` (+ optional `GET /frames/{i}/variables`) | Step once; compact stack, optional bundled active-frame values |
| 37 | `openl_resume_trace` | Trace | ✅ Complete | `POST /trace/resume` + `GET /trace/status` poll + `GET /trace/stack?view=compact` | Run to the next breakpoint/exception/completion, waiting inside the call |
| 38 | `openl_inspect_trace_frame` | Trace | ✅ Complete | `GET /trace/frames/{index}/variables?fields=…` (+ optional `/highlights` + raw table) | Freeze one frame's variables; optional client-side step filter |
| 39 | `openl_set_trace_breakpoints` | Trace | ✅ Complete | `GET`/`PUT /trace/breakpoints` + `GET /trace/breakpoint-tables` | Read/replace the breakpoint set and list targets |
| 40 | `openl_get_trace_value` | Trace | ✅ Complete | `GET /projects/{projectId}/trace/parameters/{parameterId}` | Expand a lazy parameter value |
| 41 | `openl_watch_trace_cells` | Trace | ✅ Complete | `PUT /trace/watches` + `POST /trace?stopAtEntry=false&includeTree=false` + `GET /trace/watch` | Watch named cells across a whole run — one series per cell |
| 42 | `openl_expand_trace_tree` | Trace | ✅ Complete | `GET /projects/{projectId}/trace/tree/children` | Load one paginated level of a profiling call tree |
| 43 | `openl_stop_trace` | Trace | ✅ Complete | `DELETE /projects/{projectId}/trace` | Terminate the debug session (idempotent) |
| 44 | `openl_append_table_rows` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`append`/`rows`) | Append one or more rows to a table's raw source |
| 45 | `openl_append_table_columns` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`append`/`columns`) | Append one or more columns |
| 46 | `openl_insert_table_rows` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`insert`/`rows`) | Insert one or more rows at a position |
| 47 | `openl_insert_table_columns` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`insert`/`columns`) | Insert one or more columns at a position |
| 48 | `openl_delete_table_rows` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`delete`/`rows`) | Delete one or more rows from a position (count default 1) |
| 49 | `openl_delete_table_columns` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`delete`/`columns`) | Delete one or more columns from a position (count default 1) |
| 50 | `openl_update_table_row` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`update`/`row`) | Overwrite the row at a position |
| 51 | `openl_update_table_column` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`update`/`column`) | Overwrite the column at a position |
| 52 | `openl_update_table_cell` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`update`/`cell`) | Set a single cell's value |
| 53 | `openl_update_table_range` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`update`/`range`) | Overwrite a rectangular range of cells |
| 54 | `openl_merge_table_cells` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`merge`/`cells`) | Merge a rectangular range of cells |
| 55 | `openl_unmerge_table_cells` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/actions` (`unmerge`/`cells`) | Unmerge the cell covering a position |
| 56 | `openl_delete_table` | Rules | ✅ Complete | `DELETE /projects/{projectId}/tables/{tableId}` | Delete an entire table from the project |
| 57 | `openl_get_started` | Guidance | ✅ Complete | none (local) | Onboarding bootstrap: workflow protocol + workspace orientation |
| 58 | `openl_list_guides` | Guidance | ✅ Complete | none (local guides bundle) | Metadata index of the bundled OpenL docs (filterable, paginated) |
| 59 | `openl_get_guides` | Guidance | ✅ Complete | none (local guides bundle) | Full markdown bodies for requested guide ids |
| 60 | `openl_run_table` | Rules | ✅ Complete | single-active `POST /projects/{projectId}/run` + bounded `GET /run/result` polling (`DELETE /run` on failure) | Execute a regular table within one session-wide deadline and wait inside one tool call for its result |
| 61 | `openl_get_table_dependencies` | Rules | ✅ Complete | `GET /projects/{projectId}/tables/graph` or `/tables/{tableId}/graph` | Get the project/module graph or one table's dependency neighborhood |
| 62 | `openl_list_project_modules` | Project | ✅ Complete | `GET /projects/{projectId}/modules` | List modules declared by a project |
| 63 | `openl_list_module_sheets` | Project | ✅ Complete | `GET /projects/{projectId}/modules/{moduleName}/sheets` | List worksheet names in a module |
| 64 | `openl_list_table_property_definitions` | Rules | ✅ Complete | `GET /projects/{projectId}/properties` | List properties allowed for a table context |
| 65 | `openl_copy_table` | Rules | ✅ Complete | `POST /projects/{projectId}/tables/{tableId}/copy` | Copy a table server-side with its source structure and formatting |
| 66 | `openl_list_project_branches` | Project | ✅ Complete | `GET /projects/{projectId}/branches?scope=project\|repository` | List project-holding branches by default or all repository merge targets, with base/protected flags |
| 67 | `openl_check_project_merge` | Project | ✅ Complete | `POST /projects/{projectId}/merge/check` | Preview merge direction, feasibility, permissions, and blockers |
| 68 | `openl_merge_project_branches` | Project | ✅ Complete | `POST /merge/check` + `POST /projects/{projectId}/merge` | Recheck and merge branches; return session-bound conflicts when present |
| 69 | `openl_get_merge_conflicts` | Project | ✅ Complete | `GET /projects/{projectId}/merge/conflicts` | Get conflicted paths, revision sides, and default merge message |
| 70 | `openl_read_merge_conflict_file` | Project | ✅ Complete | `GET /projects/{projectId}/merge/conflicts/files` | Read bounded BASE/OURS/THEIRS conflict-file content |
| 71 | `openl_cancel_merge_conflicts` | Project | ✅ Complete | `DELETE /projects/{projectId}/merge/conflicts` | Clear pending session-bound conflict state after user handoff or cancellation |
| 72 | `openl_delete_project` | Project | ✅ Complete | `DELETE /projects/{projectId}?comment=…` | Delete a project after exact-name confirmation |
| 73 | `openl_delete_project_branch` | Project | ✅ Complete | `DELETE /projects/{projectId}/branches/{branch}?force=…` | Delete a non-base project branch with confirmation/protection guards |

**Legend:**
- ✅ **Complete**: Tool is fully implemented and working
- ⚠️ **Partial**: Tool works but missing some API parameters


---

## Summary

### Tools Status

| Status | Count | Tools |
|--------|-------|-------|
| ✅ Complete | 73 | All registered guidance, repository, project, file, table, raw table-source action, deployment, testing, and trace tools. |
| ⚠️ Partial | 0 | None. |

Total registered tools: **73**.

Conflict resolution is intentionally excluded. Studio's current API is not safe
enough for an agent to apply BASE/OURS/THEIRS decisions without risking data loss;
the registered tools expose conflict metadata and file sides only so the agent can
hand the evidence to the user for manual resolution in Studio.

### Critical Issues

1. **Missing Inputs**:
   - None known for the registered MCP abstractions

2. **Extra Parameters** (not in API):
   - None

### Recommendations Priority

**MEDIUM PRIORITY**:
1. Consider adding an `openl_health_check` tool (uses `GET /repos` as a connectivity check) for diagnosing connection issues.

**LOW PRIORITY**:
1. Add timeout parameters to long-running operations.

---

## End of Review
