# OpenL MCP Server — Agent Guide

This is the runtime reference for AI agents using the server — its tools, prompts,
and behaviour. To connect and configure a client, see the
[Quick Start](docs/guides/quick-start.md). Conventions for changing this codebase
are in [Contributing to this repository](#contributing-to-this-repository) at the end.

## Overview

The OpenL MCP Server connects AI coding agents (Claude Code, Claude Desktop,
Cursor, VS Code / GitHub Copilot) to the OpenL Studio Business Rules Management
System (BRMS). Through its tools you can:

- **Get oriented** with an onboarding entry point and bundled OpenL reference docs
- **Discover** repositories, projects, and rules
- **Read** project structure, table definitions, and rule logic
- **Modify** rules, tables, and project files
- **Test** rules and inspect results
- **Debug** rule execution interactively (breakpoints, stepping, live inspection)
- **Deploy** projects, and manage Git-based history

## How it talks to OpenL Studio

The server calls the OpenL Studio REST API (JSON, optional Personal Access Token).
For the studio's asynchronous work it also opens a STOMP WebSocket so a single tool
call can wait for the result instead of polling — project compilation
(`openl_project_status` with `wait: true`). Details:
[docs/development/websockets.md](docs/development/websockets.md).

## Tools (58 Total)

All tools are prefixed with `openl_` and share the server's version.

### Guidance Tools (4)
The onboarding and reference-documentation layer. Call `openl_get_started` once per
session before anything else; call `openl_get_project_agent_context` before working on
or creating any project. The documentation tools serve a bundle of the official OpenL
Tablets docs **embedded at build time** from the release tag matching the targeted
OpenL Studio version — progressive disclosure: the index is metadata-only, bodies are
fetched by id on demand.
- `openl_get_started` - Read-only onboarding bootstrap: the mandatory workflow protocol (load agent context per project, consult guides on demand, edit → validate → save) plus a workspace orientation (which specification/guide categories exist and how to discover more — not an index dump)
- `openl_get_project_agent_context` - Resolve the **AGENTS.md hierarchy** for a project as a **single aggregated markdown document**: walks UP from the project (or an optional `folder`) to the repository root, collects every applicable `AGENTS.md`, and returns them concatenated in one response — ordered from the root folder (lowest priority) down to the project folder (highest priority), later sections winning on conflict. Ends with the ids of bundled guides the guidance references
- `openl_list_guides` - The canonical index of the bundled docs: **metadata only** (id, type, title, source path, size), filterable by `type` ('specification'/'guide') and case-insensitive `search` over id+title, paginated
- `openl_get_guides` - Full markdown bodies for 1-5 ids from the index (e.g. `spec/rules.xml`, `guide/introduction/basic-concepts`); unknown ids fail with an actionable error — it never falls back to the index

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
- `openl_get_table` - Get table structure and data (use `raw=true` for raw 2D cell matrix view; raw-only options: `startRow`/`maxRows` read a large table in row slices — a windowed response carries `totalRows` — and `styles=true` adds each cell's Excel style: background/font colour, bold/italic/underline, alignment, indent, borders)
- `openl_update_table` - Replace entire table
- `openl_append_table` - Add rows/fields to table
- `openl_create_project_table` - Create new table
- `openl_delete_table` - Delete an entire table (to remove a row/column WITHIN a table, use the raw action tools below)

### Raw Table-Source Action Tools (12)
In-place edits to a table's raw source (any table type). One tool per operation×orientation handles **one OR more** rows/columns — pass a single row/column or several; the studio takes a single `rows`/`columns` block target (one row/column is just a one-element block), so there is no separate "row" vs "rows" tool. Positions are 0-based (row 0 is the header, column 0 the leading labels). `cells` is required and non-empty (one cell per column/row; use `{ value: null }` for a blank cell). An edit that relocates the table changes its id; each tool returns the table's CURRENT `tableId` (plus `previousTableId` when it changed) and reads the table back to trigger a recompile.

Rows / columns (one or many):
- `openl_append_table_rows` / `openl_append_table_columns` - Add one or more rows/columns to the end (`cells` is a 2D array, one inner list per row/column)
- `openl_insert_table_rows` / `openl_insert_table_columns` - Insert one or more rows/columns at `position` 1..
- `openl_delete_table_rows` / `openl_delete_table_columns` - Delete `count` (default 1) rows/columns from `position` 1.. (the header row / label column 0 cannot be deleted)

Cells / ranges:
- `openl_update_table_row` / `openl_update_table_column` - Overwrite the cells of the row/column at `position`
- `openl_update_table_cell` - Set a single cell's value at (`row`, `column`)
- `openl_update_table_range` - Overwrite a rectangular range (> 1 cell) anchored at (`row`, `column`)
- `openl_merge_table_cells` - Merge a `rowspan`×`colspan` range from (`row`, `column`)
- `openl_unmerge_table_cells` - Unmerge the cell covering (`row`, `column`)

### Project Files Tools (6, BETA)
Operate on ANY file in a project by exact project-relative path (not just Excel rule files). Writes/deletes/copies/moves land in the project **working copy** — commit them with `openl_save_project`. Use the optional `branch` to pin the project's branch (omit for `local`/non-branch repositories).
- `openl_read_project_file` - Read a file (text verbatim, binary as base64; optional `offset`/`length` byte range), read file metadata (`view: "meta"`), or list a folder (`recursive`, `viewMode` FLAT/NESTED, `extensions`, `namePattern`, `foldersOnly`); optional `version` reads a historical revision
- `openl_write_project_file` - Create/replace a file from UTF-8 or base64 `content`; `createFolders` (default true), `conflictPolicy` FAIL/OVERWRITE/SKIP
- `openl_delete_project_file` - Delete a file/folder (auto-cleans dangling config references)
- `openl_search_project_files` - Search by glob `pattern`, `extensions`, `type`, or case-insensitive `content` substring; `scope` SUBTREE (default) or ANCESTORS
- `openl_copy_project_file` - Copy a file within the project (no overwrite — destination collision returns 409)
- `openl_move_project_file` - Move or rename a file within the project

### Trace Tools (8, BETA)
An **interactive debugger** for rules: the rule runs on a server-side worker that
suspends at breakpoints and step points, and the tools inspect that live, suspended
execution. The debug session is bound to the MCP server's HTTP session — the whole
flow must go through one server instance (or one CLI `--cookie-jar`). One active
session per user (a new start terminates the previous); idle sessions are reaped
after ~10 minutes.

- `openl_start_trace` - Start a debug session for a table (test case via `testRanges`, or `inputJson`; omit both to replay the remembered input) and run to the first stop; optional initial `breakpoints`. With `profiling: true` + `stopAtEntry: false` it returns a constant-size `profile` overview (see below)
- `openl_step_trace` - Step the current frame. `out` (run the frame to its exit so its result is inspectable) + breakpoints is the main move for declarative rules; `into`/`over` are advanced (imperative TBasic/loops). Returns a compact stack (steps for the active frame only); `withValues: true` bundles the active frame's variables so you don't need a separate inspect
- `openl_resume_trace` - Run to the next breakpoint / exception / completion (further than `step out`, which stops at the current frame's exit), waiting inside the call (re-invoke after a timeout to keep waiting)
- `openl_inspect_trace_frame` - Freeze one stack frame: parameters, context, result, sub-step values; for decision tables `decision` (which rule fired, how each condition evaluated) and `ruleNames`; optional A1-keyed cell `highlights` + raw grid. Filter steps with `onlyExecutedSteps` / `excludeStepValues` (e.g. `[1]`) to surface an outlier among neutral factors
- `openl_set_trace_breakpoints` - Read the active breakpoint keys and available targets; `set` replaces the whole set. Key forms: `<name>`, `<uri>`, `<uri>#R{r}C{c}`, `<uri>#rule` (any rule fires), `<uri>#<ruleName>` (specific rule)
- `openl_get_trace_value` - Expand a lazy value (`lazy: true` + `parameterId`) from openl_inspect_trace_frame; returns name/description/value only — `withSchema: true` adds the value's (large) JSON Schema
- `openl_watch_trace_cells` - Watch named cells (e.g. `['$VehiclePriceFactor']`) across a whole run and return one series per cell with its value at every execution of its table — "show me this factor across all coverages" without dumping frames; spot the outlier, then replay into it with a breakpoint
- `openl_stop_trace` - Terminate the session (idempotent; breakpoints survive)

Lifecycle (status values are lowercase): `running ⇄ suspended → completed | error | terminated`.
Stepping and inspection are valid only while `suspended`; on a terminal status read the
final state (structured `error`, profiling `profile`/`tree`) from the stack that the last
start/step/resume call already returned.

Cheapest whole-run overview: `openl_start_trace` with `profiling: true`,
`stopAtEntry: false` and no breakpoints completes in one call and returns `profile` —
a **constant-size** overview: the top-N slowest tables (`hotspots` with
`selfMillis`/`totalMillis`/`count`) plus `nodeCount`/`distinctTables`/`totalMillis`.
It stays small regardless of project size (the full call `tree` is omitted by default
because it can exceed the 1 MB response limit; `profileTop` tunes the hotspot count).
Find the hot or unexpected table in `hotspots`, then restart with a breakpoint on it
(the input is remembered) and inspect live for values. Pull the full `tree` only to
browse one branch's structure, with `includeTree: true`.

### Deployment (4)
- `openl_list_deploy_repositories` - List deployment repositories
- `openl_list_deployments` - List active deployments
- `openl_deploy_project` - Deploy to production
- `openl_redeploy_project` - Redeploy with new version

## Local projects (repository: local)

Projects with `repository: 'local'` are stored on disk without Git; **OPENED/EDITING status is not checked or required** for them — local projects are always considered editable.

**For local, these work:**
- `openl_list_projects` (call without repository filter, then filter by `repository: "local"` in the response; the `repository: "local"` filter may fail because the "local" repository is often not returned by `openl_list_repositories`), `openl_get_project`;
- Table tools: `openl_list_tables`, `openl_get_table`, `openl_update_table`, `openl_append_table`, `openl_create_project_table`, `openl_delete_table`, and the raw table-source action tools (`openl_insert_table_rows`/`openl_delete_table_rows`/`openl_update_table_cell`/`openl_merge_table_cells`/…);
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

## Authentication

Authentication is optional — an OpenL Studio in single-user mode accepts
unauthenticated requests. Otherwise a Personal Access Token (PAT) is used. The token
always comes from the client (its `env` for stdio, or the `Authorization` header for
HTTP), never from the server. A PAT can be supplied directly
(`OPENL_PERSONAL_ACCESS_TOKEN` / `--token`) or obtained via the browser with
`openl-mcp login <url> --issuer <idp-realm-url>` (OAuth2 deployments), which signs in,
mints a PAT, and caches it so the server authenticates automatically thereafter.
Setup: [docs/guides/quick-start.md](docs/guides/quick-start.md).

## Response formatting

- Formats: `json`, `markdown`, `markdown_concise`, `markdown_detailed` (the `response_format` argument).
- List operations return pagination metadata.
- Large responses are truncated at a 25K-character limit — except `openl_get_guides` bodies, which are returned verbatim (sizes are published in the index so callers can budget).

## OpenL-specific behaviour

- **Dual versioning** — Git commits (temporal) and dimension properties (business context).
- **Table types** — Rules, SimpleRules, SmartRules, Lookups, Spreadsheet, Datatype, Method, Test, and others.
- **Project ID formats** — both the current and legacy path formats are handled.

## External Resources

- [OpenL Studio](https://github.com/openl-tablets/openl-tablets)
- [OpenL Documentation](https://openl-tablets.org/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## Contributing to this repository

These conventions are mandatory for anyone — human or AI agent — changing this codebase.

### Code Quality

- Keep the code clean at all times: no dead code (unused files, exports, functions, variables, or unreachable branches) and no unused dependencies. Remove them as soon as they become orphaned.
- Add a third-party library only when it brings significant benefit — that is, it substantially reduces the code we would otherwise write and maintain. Prefer reimplementing small or simple functionality over taking on a dependency.
- When a library is used, keep it on the latest version that is practical for the project.

### Testing

- Tests must exercise real logic — the behavior a unit computes (transformations, branches, parsing, error paths, edge cases) — not static facts. Asserting the shape or literal value of a declared constant, that a literal equals itself, or a type the compiler already guarantees adds no coverage; don't write such tests. A test should fail when behavior regresses, not only when someone edits a constant.
- Do not duplicate tests: cover each behavior once. Before adding a test, check whether an existing one already exercises that path — if so, strengthen it instead of adding a near-copy. A consistency check that cross-validates two independent sources (e.g. code vs. data files) is not a duplicate; it earns its place by catching drift.
- Keep test location and names predictable and meaningful: a unit's tests live in the conventional, obvious place for that unit, and each test name states the behavior it verifies so a failure reads as a plain statement of what broke.
- Follow the file-naming convention so the test layout mirrors `src/`: a unit test for `src/<module>.ts` lives in `tests/<module>.test.ts`, and integration tests (those that drive the MCP surface through the client's mocked HTTP layer) live under `tests/integration/`. Name every test file for the unit it actually exercises.
- A test's scope must match the file it lives in. Do not test one unit's behavior from inside another unit's test file — e.g. `constants.ts`'s `mcpToolName`/`stripToolPrefix` or the `tool-handlers.ts` registry returned by `getAllTools()` do not belong in a server test. Put each test with the code it exercises.
- When code is moved or renamed, move or rename its test file (and update any references to it) in the same change, so the convention above never drifts.

### Documentation

- Keep all documentation up to date with every code change. When a change adds, removes, or alters tools, prompts, dependencies, configuration, or behavior, update the affected docs in the same change — never leave them for later.
- This covers every document, not just the README: this `AGENTS.md`, the `README*.md` files, everything under `docs/`, the prompt files in `prompts/`, and the spec docs under `.specify/`.
- Remove obsolete information rather than letting it accumulate: no references to removed tools, prompts, or APIs, and no stale counts, examples, or links.

### Git Commits

- Commit every completed piece of work.
- Write a short, meaningful subject that answers *why* the change was made, not *what* changed — the "what" is already visible in the diff and history.
- The subject should explain the benefit to a user or a developer.
- Add an extended body only when the subject alone cannot convey the meaning gracefully.
- Do NOT add a `Co-Authored-By: Claude` trailer (or any co-author trailer) to commit messages.

### Pull Requests

- Before creating a pull request, add an entry to [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` (in the matching `### Added` / `### Fixed` / etc. section, following the Keep a Changelog format).
- Keep changelog entries short and to the point — describe the user-facing change, not the implementation. No deep technical details.
