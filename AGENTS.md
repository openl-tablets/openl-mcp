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
call can wait for the result instead of agent-side polling — project compilation
uses STOMP (`openl_project_status` with `wait: true`), while regular table execution
is polled internally by `openl_run_table`. STOMP details:
[docs/development/websockets.md](docs/development/websockets.md).

## Tools (73 Total)

All tools are prefixed with `openl_` and share the server's version.

### Guidance Tools (4)
The onboarding and reference-documentation layer. Call `openl_get_started` once per
session before anything else; call `openl_get_project_agent_context` before working on
or creating any project. The documentation tools serve a bundle of the official OpenL
Tablets docs **embedded at build time** from the revision configured in
`package.json` — progressive disclosure: the index is metadata-only, bodies are fetched
by id on demand.
- `openl_get_started` - Read-only onboarding bootstrap: the mandatory workflow protocol (load agent context per project, consult guides on demand, edit → validate → save) plus a workspace orientation (which specification/guide categories exist and how to discover more — not an index dump)
- `openl_get_project_agent_context` - Resolve the **AGENTS.md hierarchy** for a project as a **single aggregated markdown document**: walks UP from the project (or an optional `folder`) to the repository root, collects every applicable `AGENTS.md`, and returns them concatenated in one response — ordered from the root folder (lowest priority) down to the project folder (highest priority), later sections winning on conflict. Ends with the ids of bundled guides the guidance references
- `openl_list_guides` - The canonical index of the bundled docs: **metadata only** (id, type, title, source path, size), filterable by `type` ('specification'/'guide') and case-insensitive `search` over id+title, paginated
- `openl_get_guides` - Full markdown bodies for 1-5 ids from the index (e.g. `spec/rules.xml`, `guide/introduction/basic-concepts`); unknown ids fail with an actionable error — it never falls back to the index

### Repository Tools (4)
- `openl_list_repositories` - List all design repositories
- `openl_list_branches` - List Git branches in a repository
- `openl_list_repository_features` - Get repository capabilities
- `openl_repository_project_revisions` - Get project revision history

### Project Tools (16)
- `openl_list_projects` - List projects with filters and pagination; follow `has_more` / `next_offset` until `has_more` is false when a complete inventory is required
- `openl_get_project` - Get project details
- `openl_project_status` - Compile lazily when needed and return project compile state and diagnostics (errors/warnings with location); `wait=true` is the default, while explicit `wait=false` is a snapshot that may return `idle`/`compiling`
- `openl_create_project` - Create or copy a project atomically through Studio: omit `template` for a BLANK project, or pass an existing project name to copy its full structure and rename it. Both modes accept an optional target `branch`, are indexed immediately, and return the commit revision plus Studio's opaque `projectId`
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
- `openl_list_project_modules` - List declared project modules, including path patterns and their matched modules
- `openl_list_module_sheets` - List worksheets in a project module

### Project Branch/Merge/Deletion Tools (8, BETA)

Merge conflict state is bound to the Studio HTTP session. After a merge returns
`status: "conflicts"`, inspect it through the same MCP server instance, present
the evidence to the user, and leave resolution to them in Studio. Conflict
resolution is intentionally not exposed: Studio does not provide a sufficiently
safe API for autonomous resolution, and choosing `OURS` or `THEIRS` can discard
valid work. Never choose or apply a conflict side automatically. Use the cancel
tool only to clear pending MCP session state after the user takes over or the
merge is abandoned. `receive` merges the other branch into the project's current
branch; `send` merges the current branch into the other branch.

- `openl_list_project_branches` - List branches with base/protected flags: `scope: "project"` (default) returns branches that hold the project for switching/deletion; `scope: "repository"` returns every repository branch for merge-target discovery, including branches that do not hold the project yet
- `openl_check_project_merge` - Preview merge direction, status, permissions, and blockers without changing Git
- `openl_merge_project_branches` - Recheck and merge branches; creates session-bound conflict state when needed
- `openl_get_merge_conflicts` - Get grouped conflicted paths, BASE/OURS/THEIRS revisions, and the default message
- `openl_read_merge_conflict_file` - Read a bounded UTF-8 or base64 binary chunk for one BASE/OURS/THEIRS file version
- `openl_cancel_merge_conflicts` - Clear the pending conflict session without modifying files or branches
- `openl_delete_project` - Delete a project after exact current-name confirmation
- `openl_delete_project_branch` - Delete a non-base branch after exact branch confirmation; protected bypass requires explicit force confirmation

### Rules/Tables Tools (10)
- `openl_list_tables` - List project tables with pagination; follow `has_more` / `next_offset` until `has_more` is false when a complete inventory is required
- `openl_get_table` - Get the authoritative `RawSource` 2D cell matrix; `startRow`/`maxRows` read a large table in row slices and `styles=true` includes read-only Excel cell styles. A sliced response carries `totalRows` and is for reading or narrow raw actions only
- `openl_update_table` - Replace the complete `RawSource` matrix; rejects a window carrying `totalRows` because writing it would delete omitted rows. Call `openl_get_table` without `styles=true`: Studio write APIs cannot change formatting, and `style` is rejected rather than silently ignored
- `openl_append_table` - Append full-width `RawSource` rows
- `openl_create_project_table` - Create a table from a complete `RawSource` matrix in an existing module, or pass `modulePath` (an `.xlsx` project-relative path) to create a new module; cell formatting is unsupported by Studio write APIs
- `openl_delete_table` - Delete an entire table (to remove a row/column WITHIN a table, use the raw action tools below)
- `openl_run_table` - Execute a regular (non-Test) table with JSON input and wait for its result; `timeoutMs` bounds the complete start-and-result workflow (default 2 minutes), and cancellation, timeout, or any other failed workflow clears the pending Studio run. Studio permits only one run per HTTP session, so concurrent calls through the same MCP connection are rejected rather than allowed to replace each other's result
- `openl_get_table_dependencies` - Get the whole project/module dependency graph or a table's dependency/dependent neighborhood
- `openl_list_table_property_definitions` - List properties allowed in a table context, including types and enum values
- `openl_copy_table` - Copy a table server-side inside the project while preserving formatting, merged cells, comments, and structure

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
- `openl_read_project_file` - Read a file (text verbatim; arbitrary binary as lossless base64 `content` in a JSON TextContent envelope with MIME/byte metadata; optional `offset`/`length` byte range), read file metadata (`view: "meta"`), or list a folder (`recursive`, `viewMode` FLAT/NESTED, `extensions`, `namePattern`, `foldersOnly`); optional `version` reads a historical revision
- `openl_write_project_file` - Create/replace a file from UTF-8 `content` or a base64 `blob` advertised with JSON Schema `contentEncoding: "base64"`; the legacy base64 `content` + `encoding` form remains accepted, including whitespace-wrapped base64; `createFolders` (default true), `conflictPolicy` FAIL/OVERWRITE/SKIP
- `openl_delete_project_file` - Delete a file/folder (auto-cleans dangling config references)
- `openl_search_project_files` - Search by glob `pattern`, `extensions`, `type`, or case-insensitive `content` substring; `scope` SUBTREE (default) or ANCESTORS. Studio searches `content` only inside text files—not XLSX/XLS/ZIP/images; locate binary files by path/extension and read them separately
- `openl_copy_project_file` - Copy a file within the project (no overwrite — destination collision returns 409)
- `openl_move_project_file` - Move or rename a file within the project

### Trace Tools (9, BETA)
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
- `openl_set_trace_breakpoints` - Read the active breakpoint keys and available targets; `set` replaces the whole set. Key forms: `<name>`, `<uri>`, `<uri>#R{r}C{c}`, `<uri>#rule` (any rule fires), `<uri>#<ruleName>` (specific rule). Append `@N` to any key to break only on the table's N-th execution (0-based) — e.g. `<uri>#R48C0@3`; without it a cell breakpoint hits every pass of a table that runs many times. `N` matches `frames[].instance` and a watch series' `instance`
- `openl_get_trace_value` - Expand a lazy value (`lazy: true` + `parameterId`) from openl_inspect_trace_frame; returns name/description/value only — `withSchema: true` adds the value's (large) JSON Schema
- `openl_expand_trace_tree` - Load one level of a **profiling** run's executed call tree on demand — it comes back lazy, so each step carries a `childrenTotal` count instead of nested `children`. Expand a step whose `childrenTotal` > 0 by its node (`uri` + `instance`) and step `ref`; returns `{ children, total }` where each child is itself shallow (expand again). Page a loop's many sub-calls with `offset`/`limit` (the reply flags `hasMore`/`nextOffset`); a node's `notRetained` counts sub-calls dropped once the tree hit its size limit. Start from the `tree` root (`includeTree: true`)
- `openl_watch_trace_cells` - Watch **scalar** cells (a single number/string factor, e.g. `['$VehiclePriceFactor']`) across a whole run and return one series per cell with its value at every execution of its table — "show me this factor across all coverages" without dumping frames; spot the outlier, then jump straight to that pass with a `<point.ref>@<point.instance>` breakpoint + replay. Do NOT watch a cell whose value is a big aggregate object (a whole spreadsheet result like `$RateCardPremium`) — it makes every point huge; drill into an aggregate with a breakpoint + inspect instead. Captures cells inside lazy result branches too. Each point's value is a ParameterValue (lazy when large — expand with `openl_get_trace_value`); value JSON Schemas are omitted unless `withSchema: true`. The server caps points per series for a cell deep in a combinatorial branch — each series reports `total` (full execution count) and `WatchView.truncated` flags dropped late executions (reach a specific one with a `<ref>@N` breakpoint)
- `openl_stop_trace` - Terminate the session (idempotent; breakpoints survive)

Lifecycle (status values are lowercase): `running ⇄ suspended → completed | error | terminated`.
Stepping and inspection are valid only while `suspended`; on a terminal status read the
final state (structured `error`, profiling `profile`/`tree`) from the stack that the last
start/step/resume call already returned.

Cheapest whole-run overview: `openl_start_trace` with `profiling: true`,
`stopAtEntry: false` and no breakpoints completes in one call and returns `profile` —
a **constant-size** overview: the top-N slowest tables (`hotspots` with
`selfMillis`/`totalMillis`/`count`) plus `nodeCount`/`distinctTables`/`totalMillis`.
It stays small regardless of project size (the call `tree` is omitted by default;
`profileTop` tunes the hotspot count). The `hotspots[].count` counts every table
call, so it is accurate even on a huge run whose tree was truncated, and
`profile.truncated` flags a tree that hit its node cap.
For a profiling overview always pass `inputJson`/`testRanges` with `profiling: true`
and `stopAtEntry: false` **explicitly** — don't rely on replay (omitting the input):
a replay only reproduces the compact profile if the remembered run was itself a
profiling run, otherwise it can return a much larger stack that overflows the limit.
Find the hot or unexpected table in `hotspots`, then restart with a breakpoint on it
(the input is remembered) and inspect live for values. To browse a branch's call
structure, set `includeTree: true` for the **one-level** `tree` root (its steps carry
a `childrenTotal` count, not nested children — a huge run is no longer returned whole)
and walk it level by level with `openl_expand_trace_tree`.

### Deployment (4)
- `openl_list_deploy_repositories` - List deployment repositories
- `openl_list_deployments` - List active deployments
- `openl_deploy_project` - Deploy to production
- `openl_redeploy_project` - Redeploy with new version

## Local projects (repository: local)

Projects with `repository: 'local'` are stored on disk without Git; **OPENED/EDITING status is not checked or required** for them — local projects are always considered editable.

**For local, these work:**
- `openl_list_projects` (call without repository filter, follow pagination to completion, then filter by `repository: "local"` in the response; the `repository: "local"` filter may fail because the "local" repository is often not returned by `openl_list_repositories`), `openl_get_project`;
- Table tools: `openl_list_tables`, `openl_get_table`, `openl_update_table`, `openl_append_table`, `openl_create_project_table`, `openl_copy_table`, `openl_delete_table`, dependency/property discovery, and the raw table-source action tools (`openl_insert_table_rows`/`openl_delete_table_rows`/`openl_update_table_cell`/`openl_merge_table_cells`/…);
- Module/sheet discovery and regular table execution: `openl_list_project_modules`, `openl_list_module_sheets`, `openl_run_table`;
- Project deletion: `openl_delete_project` after exact project-name confirmation;
- Test execution and results: `openl_start_project_tests`, `openl_get_test_results_summary`, `openl_get_test_results`, `openl_get_test_results_by_table` (the project is not opened before running tests for local).

**For local, do not use:**
- `openl_open_project`, `openl_save_project`, `openl_close_project` (no commits or status changes);
- Git tools: `openl_list_branches`, `openl_create_project_branch`, `openl_repository_project_revisions`;
- Project branch/merge tools: `openl_list_project_branches`, `openl_check_project_merge`, `openl_merge_project_branches`, read-only merge-conflict inspection, conflict-session cancellation, and `openl_delete_project_branch`;
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
HTTP), never from the server. A PAT is supplied as
`OPENL_PERSONAL_ACCESS_TOKEN` / `--token`; without one, requests are anonymous
(single-user Studio). Setup: [docs/guides/quick-start.md](docs/guides/quick-start.md).

## MCP transports

- The MCP SDK v2 serves both the modern `2026-07-28` protocol and legacy 2025 clients over stdio and Streamable HTTP.
- Streamable HTTP validates browser `Origin` values against `MCP_ALLOWED_ORIGINS`; requests without `Origin` are treated as non-browser clients. Every approved browser response exposes `Mcp-Session-Id` for legacy clients.
- Every anonymous legacy MCP session owns a distinct `OpenLClient` and Studio cookie jar. Never reuse a credential-less client across MCP sessions.
- Modern HTTP is stateless and constructs a fresh Studio client per request. Use stdio or a legacy 2025 HTTP connection for multi-call workflows whose state is held in Studio's HTTP session (interactive trace, test results, and merge-conflict inspection).

## Response formatting

- Formats: `json` (default), `markdown`, `markdown_concise`, `markdown_detailed` (the `response_format` argument). JSON is the authoritative, round-trippable representation for agent workflows; request a Markdown format only for human-readable output.
- Binary file reads use a lossless JSON TextContent envelope with base64 `content`, MIME type, total/returned byte counts, and optional range metadata. Do not return arbitrary XLSX/ZIP/octet-stream bytes as embedded resources: clients commonly route every embedded blob to an image decoder and reject valid non-image files. Use `offset`/`length` to page large files.
- List operations return pagination metadata.
- Large responses are truncated at a 25K-character limit — except `openl_get_guides` bodies, which are returned verbatim (sizes are published in the index so callers can budget).

## OpenL-specific behaviour

- **Dual versioning** — Git commits (temporal) and dimension properties (business context).
- **Table types** — Rules, SimpleRules, SmartRules, Lookups, Spreadsheet, Datatype, Method, Test, and others.
- **Project ID formats** — both the current and legacy path formats are handled.

### RawSource-only table content

- The MCP table-content contract is intentionally **RawSource-only**. `openl_get_table`
  always returns the raw cell matrix; create, update, and append accept only
  `tableType: "RawSource"` payloads.
- Never add typed table request/response variants such as `EditableTableView`,
  `AppendTableView`, `SimpleRules`, `Spreadsheet`, `Datatype`, or `Test` DTOs to
  MCP schemas, TypeScript content types, handlers, prompts, or examples. Studio's
  typed views are incomplete and lossy and cannot reliably round-trip workbook
  cells, layout, styles, merged regions, and less common table features.
- A table's semantic kind still appears in list/run/dependency metadata and is
  encoded by the OpenL grid itself. That metadata is not authorization to expose
  a typed content contract.
- Prefer the narrow raw table-source action tools for isolated edits. When a full
  replacement is necessary, call `openl_get_table` without `styles=true` and
  round-trip the complete `source`, preserving blank/covered cells and spans.
- Cell styles are read-only in Studio's table REST API. `styles=true` is useful
  for inspection, but every MCP table write schema rejects `style`; never
  advertise formatting edits unless Studio adds a working write contract.

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

### Pull Requests

- Before creating a pull request, add an entry to [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` (in the matching `### Added` / `### Fixed` / etc. section, following the Keep a Changelog format).
- Keep changelog entries short and to the point — describe the user-facing change, not the implementation. No deep technical details.

### Commit Convention

```
EPBDS-NNNNN <subject>

<optional body>
```

- **Commit every completed piece of work.**
- **One logical change per commit** — one small piece of functionality or one refactoring step, with its tests and
  documentation, buildable and green on its own.
- **Fix issues in the commit that introduced them.** On an unpushed branch, fold fixes (bugs, failing tests,
  documentation, review findings) into the originating commit instead of stacking follow-up commits:
  - for the latest commit, use `git commit --amend`;
  - for an earlier commit, use `git commit --fixup=<sha>` and squash with
    `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --autostash <base>`;
  - when a fix interacts with code changed by later commits (for example, an import they removed), adjust those
    commits in the same rebase so that every commit in the history stays buildable.
- **Prefix with the Jira ticket** (`EPBDS-NNNNN`), usually equal to the branch name.
- **The subject explains _why_ or _what_, not the mechanical move** already visible in the diff. Start it with an
  imperative verb.
  - Good — `EPBDS-15494 Stream file downloads instead of buffering`
  - Avoid — `EPBDS-15494 Move FileService into the rest package`
- **For bug fixes, name the cause and its observable effect**, not the symptom:
  - `EPBDS-15981 Fix NPE when ProjectDescriptor.name is null` — not `Fix 'something went wrong' message`
  - `Fix date parsing which breaks UI rendering` — not `Fix missed input`
- **Subject line only.** Add a body only when a single line cannot explain the change with fewer words.
- **No `Co-Authored-By:` or other co-author trailers.**
- **Skip the Jira prefix** when the change is unrelated to the ticket or conversation theme — an independent bug, a
  misconfiguration, code cleanup or a dependency bump.

### Sources of Truth

- **Repository documentation is the centralized primary source.** `docs/` (notably `docs/development/architecture.md`) and
  `AGENTS.md` files hold the approved architecture and decisions and must always contain the most current
  knowledge.
- **Jira is supplementary, non-centralized working information.** Tickets may contradict each other and the
  repository documentation.
- **Surface every conflict.** When tickets disagree with the repository documentation or with each other, show
  the divergence to the user instead of silently preferring one side. The repository document remains the
  approved position until the user decides otherwise.

### Jira Workflow

- **Search Jira before creating a ticket.** When a bug or an improvement is implemented, look for existing issues
  first, trying different wordings — do not duplicate tickets.
- **Keep the ticket description up to date.** When the scope or behavior changes during development, update the
  description so it matches the real implementation.
- **Create the ticket when it is absent** and fill it in completely:
  - the actual sprint;
  - the component;
  - the fix version;
  - additionally the affected version for a bug;
  - Story Points and the original estimate (1 Story Point ≈ 8 hours).
- **Link the tickets** when the relation is known: related to, depends on, and caused by.
- **Show ticket IDs as links** (`https://jira.eisgroup.com/browse/EPBDS-NNNNN`) in replies and reports for easy
  navigation.
- **Ticket creation can be skipped** when the change does not affect the code functionality (build configuration,
  process documentation, developer tooling, dead code) and no relevant ticket exists in Jira.

### Markdown Rules

- GFM style only
- Single located images MUST have descriptive title text
- Prefer bullet lists over dense prose
- Tables only when both columns are short or 3+ columns; otherwise use `- **label** — description`
- No version stamp in headings
- Mermaid for structural diagrams
- Admonitions: `> [!Note]` (single blockquote level only without title and nesting)
