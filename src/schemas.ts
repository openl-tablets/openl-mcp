/**
 * Zod Schemas for MCP Tool Input Validation
 *
 * This module defines all input schemas for OpenL MCP tools using Zod.
 * Benefits:
 * - Type-safe input validation with runtime checks
 * - Automatic TypeScript type inference
 * - Self-documenting API through schema descriptions
 * - Clear validation error messages
 *
 * To add a new tool schema:
 * 1. Define the schema using z.object() with descriptive field names
 * 2. Add .describe() to each field for documentation
 * 3. Export the schema
 * 4. Reference it in tools.ts
 */

import { z } from "zod";

// Re-export z for convenience
export { z };

// Response format enum
export const ResponseFormat = z
  .enum(["json", "markdown", "markdown_concise", "markdown_detailed"])
  .default("markdown")
  .describe(
    "Response format: 'json' for structured data, 'markdown' for human-readable (default), 'markdown_concise' for brief summary (1-2 paragraphs), 'markdown_detailed' for full details with context"
  );

// Pagination parameters
export const PaginationParams = z.object({
  limit: z.number().int().positive().max(200).default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

// Project ID: opaque backend identifier from openl_list_projects() response
export const projectIdSchema = z.string().describe("Project ID returned by backend. Use the exact 'projectId' value from openl_list_projects() response without modification or reformatting.");

export const repositoryNameSchema = z.string().describe("Repository identifier. Pass either the 'id' or the 'name' field from openl_list_repositories() — the tool accepts both (and is case-insensitive). DO NOT invent values like 'Design Repository' or 'design-repo'; the actual names are typically short tokens (e.g. 'Design'). Always call openl_list_repositories() first if you don't already have the value in context.");

export const projectNameSchema = z.string().describe("Project name within the repository (e.g., 'InsuranceRules', 'AutoPremium', 'ClaimProcessing')");

export const tableIdSchema = z.string().describe("Table identifier - unique ID assigned by OpenL Studio (e.g., 'calculatePremium_1234'). VOLATILE: derived from the table's location, so it changes when an edit relocates the table (it had no room to grow in place) — use the 'tableId' returned by the latest openl_update_table/openl_append_table response, or refresh via openl_list_tables().");

export const branchNameSchema = z.string().describe("Git branch name (e.g., 'main', 'development', 'feature/new-rules')");

export const commentSchema = z.string().optional().describe("Commit comment describing the change (e.g., 'Updated CA premium rates', 'Fixed calculation bug')");

// Tool input schemas
export const listProjectsSchema = z.object({
  repository: z.string().optional().describe("Filter by repository name (display name, not ID). Use the 'name' field from openl_list_repositories() response (e.g., if list_repositories returns {id: 'design-repo', name: 'Design Repository'}, use 'Design Repository' here, NOT 'design-repo'). Omit to show projects from all repositories."),
  status: z.enum(["LOCAL", "ARCHIVED", "OPENED", "VIEWING_VERSION", "EDITING", "CLOSED"]).optional().describe("Filter by project status. Valid values: 'LOCAL', 'ARCHIVED', 'OPENED', 'VIEWING_VERSION', 'EDITING', 'CLOSED'."),
  tags: z.record(z.string(), z.string()).optional().describe("Filter by project tags. Tags must be prefixed with 'tags.' in the query string (e.g., tags.version='1.0', tags.environment='production'). This is handled automatically by the API client - provide as object with tag names as keys."),
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

export const getProjectSchema = z.object({
  projectId: projectIdSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const projectStatusSchema = z.object({
  projectId: projectIdSchema,
  branch: branchNameSchema.optional().describe(
    "Optional branch name. When provided, must match the project's currently opened branch (the backend returns 409 on mismatch). Omit for repositories that do not support branches and for projects with repository 'local'."
  ),
  wait: z.boolean().default(false).optional().describe(
    "When true, the tool subscribes to the studio's real-time status topic and blocks until compileState is terminal (ok/warnings/errors), emitting MCP progress notifications along the way. Use this immediately after an edit (openl_update_table/openl_append_table/openl_upload_file) to get the post-compile state in one call instead of polling. If the initial state is already terminal, returns immediately. Default false (one-shot snapshot)."
  ),
  timeoutMs: z.number().int().positive().max(600000).default(120000).optional().describe(
    "Max time in milliseconds to wait for compilation when wait=true. On expiry, the last-seen status is returned (no error). Default 120000 (2 minutes). Cap 600000 (10 minutes). Ignored when wait=false."
  ),
  severity: z.array(z.enum(["ERROR", "WARN", "INFO"])).optional().describe(
    "Filter compilation.messages.items to only these severities. Useful when the project has many warnings and you want to isolate errors: pass severity: ['ERROR']. Default: all severities. Note: items are always sorted ERROR → WARN → INFO before any filter or truncation is applied, so errors are visible without this filter."
  ),
  maxMessages: z.number().int().positive().max(1000).optional().describe(
    "Cap the number of items returned in compilation.messages.items. The list is sorted ERROR → WARN → INFO first so the most actionable items are preserved when capped. Pair with severity to bound very large diagnostic lists. Default: no cap (relies on the response-format character truncation)."
  ),
  response_format: ResponseFormat.optional(),
}).strict();

export const openProjectSchema = z.object({
  projectId: projectIdSchema,
  branch: branchNameSchema.optional().describe("Open project on a specific Git branch (e.g., 'main', 'development', 'feature/new-rules')"),
  revision: z.string().optional().describe("Open project at a specific Git revision/commit hash for read-only viewing"),
  response_format: ResponseFormat.optional(),
}).strict();

export const closeProjectSchema = z.object({
  projectId: projectIdSchema,
  saveChanges: z.boolean().optional().describe("If true, save changes before closing (requires comment). If false or omitted and project has unsaved changes, will error unless discardChanges is true."),
  comment: commentSchema.describe("Git commit comment. Required if saveChanges is true. Optional if saveChanges is false or omitted."),
  discardChanges: z.boolean().optional().describe("If true, close without saving (unsaved changes will be lost). When project is EDITING, you must also set confirmDiscard: true to confirm."),
  confirmDiscard: z.boolean().optional().describe("When closing with discardChanges: true and project has unsaved changes, must be set to true (explicitly) to confirm. Omitted or false will return a confirmation prompt. Ask the user first, then call again with confirmDiscard: true."),
  response_format: ResponseFormat.optional(),
}).strict();

export const listTablesSchema = z.object({
  projectId: projectIdSchema,
  kind: z.array(z.string()).optional().describe("Filter by table kinds (array of strings). Valid values: 'Rules', 'Spreadsheet', 'Datatype', 'Data', 'Test', 'TBasic', 'Column Match', 'Method', 'Run', 'Constants', 'Conditions', 'Actions', 'Returns', 'Environment', 'Properties', 'Other'. Omit to show all kinds."),
  name: z.string().optional().describe("Filter by table name fragment (e.g., 'calculate', 'Premium'). Omit to show all tables."),
  properties: z.record(z.string(), z.string()).optional().describe("Filter by project properties. Properties must be prefixed with 'properties.' in the query string (e.g., properties.state='CA', properties.lob='Auto'). This is handled automatically by the API client."),
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

export const getTableSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema,
  raw: z.boolean().optional().describe("If true, returns the raw table view as a 2D matrix of cells without any parsing or structure interpretation. Useful for reading tables of unknown or custom types, preserving exact cell positioning and merge regions."),
  response_format: ResponseFormat.optional(),
}).strict();

export const deleteTableSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const updateTableSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema,
  view: z.record(z.string(), z.any()).describe("FULL table structure from get_table() with your modifications applied. MUST include: id, tableType, kind, name, plus type-specific data (rules for SimpleRules, rows for Spreadsheet, fields for Datatype). Keep 'tableType' EXACTLY as get_table() returned it (it is a CASE-SENSITIVE discriminator: Datatype, Spreadsheet, SimpleRules, SmartRules, SimpleSpreadsheet, Vocabulary, Data, Test, SimpleLookup, SmartLookup, RawSource — lowercase is rejected). Do NOT send only the changed fields - send the complete structure. Workflow: 1) currentTable = get_table(), 2) currentTable.rules[0]['Column'] = newValue, 3) update_table(view=currentTable)"),
  response_format: ResponseFormat.optional(),
}).strict();

export const appendTableSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema,
  appendData: z.discriminatedUnion("tableType", [
    // DatatypeAppend
    z.object({
      tableType: z.literal("Datatype"),
      fields: z.array(z.object({
        name: z.string().describe("Field name"),
        type: z.string().describe("Field type (e.g., 'String', 'int', 'double')"),
        required: z.union([z.boolean(), z.string()]).optional().describe("Whether the field is required (backend field is a String; a boolean is accepted and coerced)."),
        defaultValue: z.any().optional().describe("Default value for the field"),
      })).describe("Array of field definitions to append"),
    }),
    // SimpleRulesAppend
    z.object({
      tableType: z.literal("SimpleRules"),
      rules: z.array(z.record(z.string(), z.unknown())).describe("Array of rule objects to append. Each rule is a map with condition and action columns."),
    }),
    // SimpleSpreadsheetAppend
    z.object({
      tableType: z.literal("SimpleSpreadsheet"),
      steps: z.array(z.object({
        name: z.string().describe("Step name (referenced elsewhere as $StepName)."),
        type: z.string().optional().describe("Step result type, e.g. 'Double'."),
        value: z.any().describe("The step's formula or value, e.g. '= app.annualIncome / 12'. NOT 'formula'."),
      })).describe("Array of spreadsheet steps to append: [{ name, type?, value }]."),
    }),
    // SpreadsheetAppend — append rows to a FULL (multi-column) Spreadsheet: row
    // headers in `rows` plus the matching grid of cell values in `cells` (one inner
    // array per appended row). Use SimpleSpreadsheet for the single-column form.
    z.object({
      tableType: z.literal("Spreadsheet"),
      rows: z.array(z.object({
        name: z.string().optional().describe("Row name (referenced elsewhere as $RowName)."),
        type: z.string().optional().describe("Row result type, e.g. 'Double', 'String'."),
      })).optional().describe("Optional spreadsheet row headers to append: [{ name, type? }] — when provided, one per appended row (must align 1:1 with 'cells')."),
      cells: z.array(z.array(z.object({ value: z.any() }))).min(1).describe(
        "Required. Cells to append as a non-empty 2D array — one inner array (the row's cells across the columns) per appended row: [[{ value }]]. The formula/value goes in each cell's 'value'."
      ),
    }),
    // SmartRulesAppend
    z.object({
      tableType: z.literal("SmartRules"),
      rules: z.array(z.record(z.string(), z.unknown())).describe("Array of rule objects to append. Each rule is a map with condition and action columns."),
    }),
    // VocabularyAppend
    z.object({
      tableType: z.literal("Vocabulary"),
      values: z.array(z.object({ value: z.any() })).describe("Array of vocabulary values to append: [{ value }]."),
    }),
    // LookupAppend (SimpleLookup / SmartLookup) — rows are an array of maps.
    z.object({
      tableType: z.literal("SimpleLookup"),
      rows: z.array(z.record(z.string(), z.unknown())).describe("Array of lookup rows to append; each row is a map keyed by the table's columns."),
    }),
    z.object({
      tableType: z.literal("SmartLookup"),
      rows: z.array(z.record(z.string(), z.unknown())).describe("Array of lookup rows to append; each row is a map keyed by the table's columns."),
    }),
    // DataAppend — rows are positional { values: [...] }.
    z.object({
      tableType: z.literal("Data"),
      rows: z.array(z.object({ values: z.array(z.any()) })).describe("Array of data rows to append: [{ values: [...] }] (one value per column)."),
    }),
    // TestAppend — rows are positional { values: [...] }; use this to add test cases
    // to an existing Test table (create writes only the header, then append the cases).
    z.object({
      tableType: z.literal("Test"),
      rows: z.array(z.object({ values: z.array(z.any()) })).describe("Array of test cases to append: [{ values: [...] }] (one value per header column)."),
    }),
    // RawSourceAppend
    z.object({
      tableType: z.literal("RawSource"),
      rows: z.array(z.array(z.record(z.string(), z.unknown()))).describe("Array of rows to append; each row is an array of cell objects (e.g. { value: string, colspan?: number } or { covered?: boolean }). Each row must cover ALL columns of the table (read it back with openl_get_table(raw=true) to see the width) — use { value: \"\" } for intentionally blank cells; a row narrower than the table is rejected before anything is written."),
    }),
  ]).describe("Data structure to append to the table. Structure depends on tableType: Datatype uses 'fields'; SimpleRules/SmartRules use 'rules'; SimpleLookup/SmartLookup use 'rows' (array of maps); Data/Test use 'rows' (array of { values }); SimpleSpreadsheet uses 'steps'; Spreadsheet uses 'rows' (row headers) + 'cells' (2D cell array); Vocabulary uses 'values'; RawSource uses 'rows' (array of cell-arrays)."),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Raw table-source actions (POST /projects/{projectId}/tables/{tableId}/actions)
//
// One narrow tool per operation×orientation. Each applies a SINGLE in-place edit
// to the table's RAW source (any table type), unlike openl_update_table /
// openl_append_table which take the parsed, per-type structure. Positions are
// 0-based; row 0 is the header row and column 0 carries the leading labels, so
// insert positions start at 1. An edit that relocates the table changes its id —
// the tools surface the new id the same way update/append do.
// =============================================================================

/** A cell value for a raw table-source edit. */
const rawCellInputSchema = z.object({
  value: z.any().optional().describe("Cell value (string, number, boolean, …). Null or omitted is an empty cell."),
  colspan: z.number().int().optional().describe("Number of columns this cell spans (>= 2 to merge; omit or 1 for a single column)."),
  rowspan: z.number().int().optional().describe("Number of rows this cell spans (>= 2 to merge; omit or 1 for a single row)."),
  covered: z.boolean().optional().describe("Marks a cell covered by another cell's span; its value is ignored."),
}).strict();

const rowCellsSchema = z.array(rawCellInputSchema).optional().describe(
  "Row cells, left to right. A cell may set colspan/rowspan to merge. Must not be wider than the table. Omit to add blank cells.",
);
const columnCellsSchema = z.array(rawCellInputSchema).optional().describe(
  "Column cells, top to bottom. A cell may set colspan/rowspan to merge. Must not be taller than the table. Omit to add blank cells.",
);

const tableActionBase = {
  projectId: projectIdSchema,
  tableId: tableIdSchema,
  response_format: ResponseFormat.optional(),
};

export const appendTableRowSchema = z.object({
  ...tableActionBase,
  cells: rowCellsSchema,
}).strict();

export const appendTableColumnSchema = z.object({
  ...tableActionBase,
  cells: columnCellsSchema,
}).strict();

export const insertTableRowSchema = z.object({
  ...tableActionBase,
  position: z.number().int().min(1).describe("0-based index the new row will occupy. Row 0 is the header, so this must be between 1 and the table height (height appends to the end)."),
  cells: rowCellsSchema,
}).strict();

export const insertTableColumnSchema = z.object({
  ...tableActionBase,
  position: z.number().int().min(1).describe("0-based index the new column will occupy. Column 0 carries the leading labels, so this must be between 1 and the table width (width appends to the end)."),
  cells: columnCellsSchema,
}).strict();

export const deleteTableRowSchema = z.object({
  ...tableActionBase,
  position: z.number().int().min(0).describe("0-based index of the row to delete (0..height-1). Rows below it shift up."),
}).strict();

export const deleteTableColumnSchema = z.object({
  ...tableActionBase,
  position: z.number().int().min(0).describe("0-based index of the column to delete (0..width-1). Columns to its right shift left."),
}).strict();

export const updateTableRowSchema = z.object({
  ...tableActionBase,
  position: z.number().int().min(0).describe("0-based index of the row to overwrite (0..height-1). The table is not resized."),
  cells: rowCellsSchema,
}).strict();

export const updateTableColumnSchema = z.object({
  ...tableActionBase,
  position: z.number().int().min(0).describe("0-based index of the column to overwrite (0..width-1). The table is not resized."),
  cells: columnCellsSchema,
}).strict();

export const updateTableCellSchema = z.object({
  ...tableActionBase,
  row: z.number().int().min(0).describe("0-based row index of the cell (0..height-1)."),
  column: z.number().int().min(0).describe("0-based column index of the cell (0..width-1)."),
  value: z.any().optional().describe("New cell value. Null or omitted clears the cell."),
}).strict();

export const mergeTableCellsSchema = z.object({
  ...tableActionBase,
  row: z.number().int().min(0).describe("0-based row index of the top-left cell of the range (0..height-1)."),
  column: z.number().int().min(0).describe("0-based column index of the top-left cell of the range (0..width-1)."),
  rowspan: z.number().int().min(1).describe("Number of rows the merged cell spans (>= 1)."),
  colspan: z.number().int().min(1).describe("Number of columns the merged cell spans (>= 1)."),
}).strict().refine((d) => d.rowspan * d.colspan > 1, {
  // A 1×1 merge is a no-op; the range must cover more than one cell (the tool's contract).
  error: "A merge must cover more than one cell: rowspan × colspan must be greater than 1.",
  path: ["rowspan"],
});

export const unmergeTableCellsSchema = z.object({
  ...tableActionBase,
  row: z.number().int().min(0).describe("0-based row index of any cell in the merged region (0..height-1)."),
  column: z.number().int().min(0).describe("0-based column index of any cell in the merged region (0..width-1)."),
}).strict();

export const listBranchesSchema = z.object({
  repository: repositoryNameSchema,
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

export const createBranchSchema = z.object({
  projectId: projectIdSchema,
  branchName: branchNameSchema,
  revision: z.string().optional().describe("Revision to branch from. Allows to branch from specific revision, tag or another branch. If not specified, HEAD revision will be used."),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Project Creation & Cloning Schema (single tool: blank create or clone)
// =============================================================================

export const createProjectSchema = z.object({
  repository: repositoryNameSchema,
  projectName: projectNameSchema.describe(
    "Name for the new project (the ticket's `project`). Becomes the project folder name and — when cloning — the renamed project name written into rules.xml. Must be unique in the repository; a collision is rejected with 409. Allowed characters: letters, digits, space, '_' and '-'."
  ),
  template: z.string().optional().describe(
    "How to create the project (the ticket's `template`). OMIT to create a BLANK project from the default empty skeleton. To CLONE an existing project, pass its name (from openl_list_projects()): its full structure is copied (rules, tests, settings, request/response examples) and the project is renamed to projectName. The clone source must be in the same repository."
  ),
  branch: branchNameSchema.optional().describe(
    "Target branch (the ticket's `defaultBranch`). Honored when CLONING (the source is read from and the clone written to this branch). For a BLANK project, omit this — blank projects are created on the repository's default branch (the create endpoint cannot target a branch); passing branch without template is rejected."
  ),
  comment: commentSchema.describe(
    "Commit comment for audit. Applied when creating a BLANK project; clone commit messages are system-generated. Defaults to 'Project <name> is created.' when omitted."
  ),
  response_format: ResponseFormat.optional(),
}).strict();

export const deployProjectSchema = z.object({
  projectId: projectIdSchema.describe("Project ID to deploy. Use the exact 'projectId' value from openl_list_projects() response."),
  deploymentName: z.string().describe("Name for the deployment (e.g., 'InsuranceRules', 'AutoPremium'). This will be the deployment identifier."),
  productionRepositoryId: z.string().describe("Target production repository name (display name, not ID). Use the 'name' field from openl_list_deploy_repositories() response (e.g., if list_deploy_repositories returns {id: 'production-deploy', name: 'Production Deployment'}, use 'Production Deployment' here, NOT 'production-deploy'). Must be configured in OpenL Studio."),
  comment: commentSchema.describe("Deployment reason comment (e.g., 'Deploy version 1.2.0', 'Production release')"),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Phase 1: New Tool Schemas
// =============================================================================

export const saveProjectSchema = z.object({
  projectId: projectIdSchema,
  comment: z.string().min(1).describe("Required. Comment for the new revision (commit message). Save only works when project status is EDITING; after save a new revision is created and project transitions to OPENED."),
  closeAfterSave: z.boolean().optional().describe("Optional. If true, close the project after saving (sends status CLOSED with comment in one request). Use when user asks to 'save and close'."),
  response_format: ResponseFormat.optional(),
}).strict();

// -----------------------------------------------------------------------------
// EditableTableView — discriminated union on the CASE-SENSITIVE `tableType`.
//
// The backend EditableTableView is a polymorphic Jackson type (one shape per
// tableType) that rejects unknown fields with an opaque 400 "Failed to read
// request". Modelling it as a discriminated union (mirroring appendTableSchema)
// publishes the correct REQUIRED/allowed fields PER table type in the tool's JSON
// Schema, so an LLM picks the right shape up front instead of reusing, say, the
// SimpleRules shape (args/returnType/headers[title]/rules) for a Test table — which
// actually needs the data-table shape (testedTableName/headers[fieldName]/rows[values]).
// Field sets mirror the backend view classes (TableView + per-type subtypes).
// -----------------------------------------------------------------------------
const commonTableFields = {
  name: z.string().describe("Table name (a valid Java identifier, e.g. 'calculatePremium')."),
  id: z.string().optional().describe("Optional; ignored on create."),
  kind: z.string().optional().describe("Informational only — NOT the discriminator (that is tableType)."),
  properties: z.record(z.string(), z.any()).optional().describe("Dimension/table properties, e.g. { state: 'CA', lob: 'Auto' }."),
  messages: z.array(z.any()).optional().describe("Read-only diagnostics; tolerated if a payload is copied from openl_get_table()."),
};
// ExecutableView base (rules, lookups, spreadsheets): the method signature is
// defined by name + returnType + args — there is NO 'signature' field.
const executableFields = {
  returnType: z.string().optional().describe("Return type, e.g. 'String', 'Double', 'EligibilityResult', 'SpreadsheetResult'."),
  args: z.array(z.object({
    name: z.string().describe("Parameter name, e.g. 'app'."),
    type: z.string().describe("Parameter type, e.g. 'LoanApplication', 'Integer'."),
  })).optional().describe("Input parameters: [{ name, type }]. There is NO 'signature' field — use this instead."),
};
const rulesHeaderView = z.object({ title: z.string().describe("Column caption.") });
const dataHeaderView = z.object({
  fieldName: z.string().describe("Column accessor, e.g. 'app.age' (an input) or '_res_.eligible' (an expected result)."),
  displayName: z.string().optional(),
  foreignKey: z.string().optional(),
});
const dataRowView = z.object({
  values: z.array(z.any()).describe("Positional cell values — one per header, in header order."),
});
// Spreadsheet step/row/column/cell shapes (backend SpreadsheetStepView etc.).
// IMPORTANT: a step's formula goes in `value` (e.g. "= app.annualIncome / 12"),
// NOT a `formula` field.
const spreadsheetStepView = z.object({
  name: z.string().describe("Step name (referenced elsewhere as $StepName)."),
  type: z.string().optional().describe("Step result type, e.g. 'Double', 'String'."),
  value: z.any().describe("The step's formula or value, e.g. '= app.annualIncome / 12'. NOT 'formula'."),
});
const spreadsheetRowColView = z.object({
  name: z.string(),
  type: z.string().optional(),
});
// Lookup column header (LookupView/LookupHeaderView): a caption plus optional
// nested sub-columns for multi-level column grouping (modelled one level deep —
// nested children are open maps of the same {title, children} shape).
const lookupHeaderView = z.object({
  title: z.string().optional().describe("Header caption."),
  children: z.array(z.record(z.string(), z.any())).optional().describe("Nested sub-column headers ({ title, children }) for multi-level grouping."),
});

const editableTableViewSchema = z.discriminatedUnion("tableType", [
  // Datatype — a data structure definition.
  z.object({
    tableType: z.literal("Datatype"),
    ...commonTableFields,
    extends: z.string().optional().describe("Parent datatype to extend, if any."),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.union([z.boolean(), z.string()]).optional().describe("Whether the field is required (backend stores a String; a boolean is accepted and coerced)."),
      defaultValue: z.any().optional(),
    })).optional().describe("Field definitions: [{ name, type }]."),
  }),
  // Vocabulary — an enumeration of values.
  z.object({
    tableType: z.literal("Vocabulary"),
    ...commonTableFields,
    type: z.string().optional().describe("Vocabulary element type."),
    values: z.array(z.object({ value: z.any() })).optional().describe("Vocabulary values: [{ value }]."),
  }),
  // SimpleRules / SmartRules — decision tables. headers are captions [{title}];
  // each rules row is a MAP keyed by those titles (return column usually 'RET1').
  z.object({
    tableType: z.literal("SimpleRules"),
    ...commonTableFields,
    ...executableFields,
    collect: z.boolean().optional(),
    headers: z.array(rulesHeaderView).optional().describe("Column captions, e.g. [{title:'creditScore'},{title:'RET1'}]."),
    rules: z.array(z.record(z.string(), z.any())).optional().describe("Rows as maps keyed by the header titles, e.g. { creditScore: '< 580', RET1: 'Poor' }."),
  }),
  z.object({
    tableType: z.literal("SmartRules"),
    ...commonTableFields,
    ...executableFields,
    collect: z.boolean().optional(),
    headers: z.array(z.object({
      title: z.string().optional().describe("Condition column caption."),
      width: z.number().int().optional().describe("Number of condition columns this header spans (defaults to 1)."),
    })).optional().describe("Condition column headers: [{ title, width? }]."),
    rules: z.array(z.record(z.string(), z.any())).optional().describe("Rows as maps keyed by the header captions."),
  }),
  // SimpleLookup / SmartLookup — lookup tables (LookupView): rows is an array of maps.
  z.object({
    tableType: z.literal("SimpleLookup"),
    ...commonTableFields,
    ...executableFields,
    collect: z.boolean().optional(),
    headers: z.array(lookupHeaderView).optional().describe("Lookup column headers: [{ title?, children? }] — children nest for multi-level column grouping."),
    rows: z.array(z.record(z.string(), z.any())).optional().describe("Lookup rows as maps keyed by the columns."),
  }),
  z.object({
    tableType: z.literal("SmartLookup"),
    ...commonTableFields,
    ...executableFields,
    collect: z.boolean().optional(),
    headers: z.array(lookupHeaderView).optional().describe("Lookup column headers: [{ title?, children? }] — children nest for multi-level column grouping."),
    rows: z.array(z.record(z.string(), z.any())).optional().describe("Lookup rows as maps keyed by the columns."),
  }),
  // SimpleSpreadsheet — a single-column spreadsheet of named steps. Each step's
  // formula goes in `value` (e.g. value: "= app.annualIncome / 12"), NOT 'formula'.
  z.object({
    tableType: z.literal("SimpleSpreadsheet"),
    ...commonTableFields,
    ...executableFields,
    steps: z.array(spreadsheetStepView).optional().describe(
      "Named steps: [{ name, type?, value }]. The formula goes in 'value' (e.g. value: '= app.annualIncome / 12'); there is NO 'formula' field. Reference earlier steps as $StepName."
    ),
  }),
  // Spreadsheet — full row/column/cell grid.
  z.object({
    tableType: z.literal("Spreadsheet"),
    ...commonTableFields,
    ...executableFields,
    rows: z.array(spreadsheetRowColView).optional().describe("Row headers: [{ name, type? }]."),
    columns: z.array(spreadsheetRowColView).optional().describe("Column headers: [{ name, type? }]."),
    cells: z.array(z.array(z.object({ value: z.any() }))).optional().describe("2D matrix of cells: [[{ value }]]. The formula/value goes in each cell's 'value'."),
  }),
  // Data — a data table (AbstractDataView): headers[fieldName] + rows[{values}].
  z.object({
    tableType: z.literal("Data"),
    ...commonTableFields,
    dataType: z.string().optional().describe("Element type of the data table."),
    headers: z.array(dataHeaderView).optional().describe("Columns: [{fieldName}]."),
    rows: z.array(dataRowView).optional().describe("Rows as positional { values: [...] }."),
  }),
  // Test — a test table (AbstractDataView). NOTE: 'testedTableName' (NOT
  // 'testedMethodName'), headers use 'fieldName' (NOT 'title'), and test cases go
  // in 'rows' as positional { values } (NOT 'rules').
  z.object({
    tableType: z.literal("Test"),
    ...commonTableFields,
    testedTableName: z.string().describe("Name of the table/method under test (NOT 'testedMethodName')."),
    headers: z.array(dataHeaderView).optional().describe("Test columns: [{fieldName}] — inputs like 'app.age' and expected results like '_res_.eligible'."),
    rows: z.array(dataRowView).optional().describe("Test cases as positional { values: [...] } (NOT 'rules'); one value per header."),
  }),
  // RawSource — raw 2D cell matrix.
  z.object({
    tableType: z.literal("RawSource"),
    ...commonTableFields,
    pos: z.string().optional(),
    source: z.array(z.array(z.object({
      value: z.any().optional(),
      colspan: z.number().int().optional(),
      rowspan: z.number().int().optional(),
      covered: z.boolean().optional(),
    }))).optional().describe("2D matrix of raw cells: [[{ value, colspan?, rowspan?, covered? }]]."),
  }),
]).describe(
  "Complete table structure (EditableTableView), selected by the CASE-SENSITIVE 'tableType' discriminator " +
  "(Datatype, Vocabulary, Spreadsheet, SimpleSpreadsheet, SimpleRules, SmartRules, SimpleLookup, SmartLookup, Data, Test, RawSource — " +
  "lowercase like 'datatype' is rejected). Each table type has a DIFFERENT shape (shown per branch); the backend rejects unknown/extra " +
  "fields with a 400 'Failed to read request'. Rules tables use args/returnType/headers[{title}]/rules; Data and Test tables use " +
  "headers[{fieldName}]/rows[{values}] (Test also needs testedTableName) — do NOT mix the two. There is NO 'signature' field. " +
  "Tip: openl_get_table() on an existing table of the SAME type returns this exact shape to copy."
);

export const createProjectTableSchema = z.object({
  projectId: projectIdSchema,
  moduleName: z.string().min(1).describe("Name of an existing project module where the table will be created (for example, 'Main' or 'Rules')."),
  sheetName: z.string().optional().describe("Name of the sheet where the table will be created within the Excel file. If not provided, the table name will be used as the sheet name."),
  table: editableTableViewSchema,
  response_format: ResponseFormat.optional(),
}).strict();

// -----------------------------------------------------------------------------
// Canonical, CASE-SENSITIVE tableType discriminators, derived from the
// discriminated unions above so the lists cannot drift from the schemas they
// describe. Both unions now cover the same 11 tableType values (append gained the
// full multi-column Spreadsheet alongside SimpleSpreadsheet). The `options[].shape.tableType`
// access mirrors what z.discriminatedUnion exposes; discriminatorValues asserts
// it extracted non-empty strings, so a future Zod-internal change throws here at
// load time rather than silently degrading to `[]`/`[undefined, …]`. The
// "derived tableType constants" test in schemas.test.ts pins the expected values.
// -----------------------------------------------------------------------------
interface DiscriminatedUnionLike {
  options: ReadonlyArray<{ shape: { tableType: { value: string } } }>;
}

function discriminatorValues(union: DiscriminatedUnionLike): readonly string[] {
  const values = union.options.map((option) => option.shape.tableType.value);
  if (values.length === 0 || values.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new Error(
      `discriminatorValues: failed to extract tableType discriminators (got ${JSON.stringify(values)}). ` +
        `The Zod discriminated-union internal shape may have changed.`
    );
  }
  return values;
}

/** Append-able tableType discriminators (from appendTableSchema.appendData). */
export const APPEND_TABLE_TYPES: readonly string[] = discriminatorValues(
  appendTableSchema.shape.appendData as unknown as DiscriminatedUnionLike,
);

/** EditableTableView tableType discriminators (from createProjectTableSchema.table). */
export const EDITABLE_TABLE_TYPES: readonly string[] = discriminatorValues(
  editableTableViewSchema as unknown as DiscriminatedUnionLike,
);

// =============================================================================
// Trace API Schemas (BETA)
// =============================================================================

export const startTraceSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema.describe("Table ID to trace (e.g., 'calculatePremium_1234'). Get from openl_list_tables()."),
  testRanges: z.string().optional().describe("For test tables: comma-separated ranges (e.g., '1-3,5'). Omit for regular rule/table execution."),
  fromModule: z.string().optional().describe("Module name for opened module execution. Usually omit."),
  inputJson: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("For regular rules: JSON input. Use object with params (required) and runtimeContext (optional). E.g. { params: { age: 25 }, runtimeContext: { lob: 'Auto' } }."),
  response_format: ResponseFormat.optional(),
}).strict();

/**
 * Server-side wait parameters for trace reads (EPBDS-16089). While a trace is
 * running the backend answers 409 Conflict; LLM agents cannot sleep between
 * calls, so by default the SERVER retries internally until the trace completes.
 */
const traceWaitParams = {
  tableId: z.string().optional().describe("Table id the trace was started for (the same value passed to openl_start_trace). Used to subscribe to the studio's per-table trace-status websocket topic while waiting out the 409 window. OPTIONAL when openl_start_trace ran through this same server instance — the table is remembered automatically; pass it explicitly when the trace was started by another process (e.g. a separate CLI run)."),
  wait: z.boolean().optional().describe("When true (DEFAULT), if the trace is still running (backend returns 409 Conflict) the server subscribes to the studio's trace-status websocket and waits until the trace completes or waitTimeoutMs elapses — no client-side polling needed. Set false to get the raw immediate 409 behavior."),
  waitTimeoutMs: z.number().int().positive().max(600000).optional().describe("Maximum time to wait for trace completion, in milliseconds. Default 120000 (2 min), cap 600000 (10 min). On timeout an error is returned explaining that the trace is still running server-side."),
};

export const getTraceNodesSchema = z.object({
  projectId: projectIdSchema,
  nodeId: z.number().int().nonnegative().optional().describe("Parent node ID. Omit for root nodes."),
  showRealNumbers: z.boolean().optional().describe("Show exact numbers instead of formatted (default: false)."),
  ...traceWaitParams,
  response_format: ResponseFormat.optional(),
}).strict();

export const getTraceNodeDetailsSchema = z.object({
  projectId: projectIdSchema,
  nodeId: z.number().int().nonnegative().describe("Trace node ID from get_trace_nodes."),
  showRealNumbers: z.boolean().optional(),
  response_format: ResponseFormat.optional(),
}).strict();

export const getTraceParameterSchema = z.object({
  projectId: projectIdSchema,
  parameterId: z.number().int().nonnegative().describe("Parameter ID from TraceParameterValue (lazy-loaded params)."),
  response_format: ResponseFormat.optional(),
}).strict();


export const cancelTraceSchema = z.object({
  projectId: projectIdSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const exportTraceSchema = z.object({
  projectId: projectIdSchema,
  showRealNumbers: z.boolean().optional(),
  release: z.boolean().optional().describe("Clear trace from memory after export (default: false)."),
  ...traceWaitParams,
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Repository Features & Revisions Schemas
// =============================================================================

export const getRepositoryFeaturesSchema = z.object({
  repository: repositoryNameSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const getProjectRevisionsSchema = z.object({
  repository: repositoryNameSchema,
  projectName: projectNameSchema,
  branch: branchNameSchema.optional().describe("Branch name (optional, only if repository supports branches)"),
  search: z.string().optional().describe("Search term to filter revisions by commit message or author"),
  techRevs: z.boolean().optional().describe("Include technical revisions (default: false)"),
  page: z.number().int().nonnegative().optional().describe("Page number (0-based, default: 0)"),
  size: z.number().int().positive().max(200).optional().describe("Page size (default: 50, max: 200)"),
  response_format: ResponseFormat.optional(),
}).strict();

export const listDeployRepositoriesSchema = z.object({
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

// =============================================================================
// Local Changes & Restore Schemas
// =============================================================================

export const listProjectLocalChangesSchema = z.object({
  response_format: ResponseFormat.optional(),
}).strict();

export const restoreProjectLocalChangeSchema = z.object({
  historyId: z.string().describe("History ID to restore (from list_project_local_changes response)"),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Test Execution Schemas
// =============================================================================

export const startProjectTestsSchema = z.object({
  projectId: projectIdSchema,
  tableId: z.string().optional().describe("Table ID to run tests for a specific table. Table type can be test table or any other table. If not provided, tests for all test tables in the project will be run."),
  testRanges: z.string().optional().describe("Test ranges to run. Can be provided only if tableId is Test table. Example: '1-3,5' to run tests with numbers 1,2,3 and 5. If not provided, all tests in the test table will be run."),
  fromModule: z.string().optional().describe("Module name to run tests from (reserved for future use - not currently used)"),
  response_format: ResponseFormat.optional(),
}).strict();

export const getTestResultsSummarySchema = z.object({
  projectId: projectIdSchema,
  failures: z.number().int().positive().default(5).optional().describe("Number of failed test units to include in the summary (default: 5, min: 1)"),
  unpaged: z.boolean().default(false).optional().describe("Return all results without pagination"),
  response_format: ResponseFormat.optional(),
}).strict();

export const getTestResultsSchema = z.object({
  projectId: projectIdSchema,
  failuresOnly: z.boolean().optional().describe("Show only failed tests (default: false)"),
  failures: z.number().int().positive().default(5).optional().describe("Number of failed test units to include in the summary (default: 5, min: 1)"),
  page: z.number().int().nonnegative().optional().describe("Page number (0-based). Mutually exclusive with offset"),
  offset: z.number().int().nonnegative().optional().describe("Offset for pagination. Mutually exclusive with page"),
  size: z.number().int().positive().optional().describe("Page size (number of results per page)"),
  limit: z.number().int().positive().max(200).optional().describe("Page size (alias for size, maps to size parameter)"),
  unpaged: z.boolean().default(false).optional().describe("Return all results without pagination. Mutually exclusive with page, offset, size, and limit"),
  response_format: ResponseFormat.optional(),
}).strict().refine(
  (data) => {
    // Validate mutual exclusivity: page vs offset
    if (data.page !== undefined && data.offset !== undefined) {
      return false;
    }
    // Validate mutual exclusivity: unpaged vs page/offset/size/limit
    if (data.unpaged === true && (data.page !== undefined || data.offset !== undefined || data.size !== undefined || data.limit !== undefined)) {
      return false;
    }
    return true;
  },
  {
    message: "Invalid pagination parameters: page and offset are mutually exclusive; unpaged is mutually exclusive with page, offset, size, and limit",
  }
);

export const getTestResultsByTableSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema.describe("Table ID to filter test results for a specific table"),
  failuresOnly: z.boolean().optional().describe("Show only failed tests (default: false)"),
  failures: z.number().int().positive().default(5).optional().describe("Number of failed test units to include in the summary (default: 5, min: 1)"),
  page: z.number().int().nonnegative().optional().describe("Page number (0-based). Mutually exclusive with offset"),
  offset: z.number().int().nonnegative().optional().describe("Offset for pagination. Mutually exclusive with page"),
  size: z.number().int().positive().optional().describe("Page size (number of results per page)"),
  limit: z.number().int().positive().max(200).optional().describe("Page size (alias for size, maps to size parameter)"),
  unpaged: z.boolean().default(false).optional().describe("Return all results without pagination. Mutually exclusive with page, offset, size, and limit"),
  response_format: ResponseFormat.optional(),
}).strict().refine(
  (data) => {
    // Validate mutual exclusivity: page vs offset
    if (data.page !== undefined && data.offset !== undefined) {
      return false;
    }
    // Validate mutual exclusivity: unpaged vs page/offset/size/limit
    if (data.unpaged === true && (data.page !== undefined || data.offset !== undefined || data.size !== undefined || data.limit !== undefined)) {
      return false;
    }
    return true;
  },
  {
    message: "Invalid pagination parameters: page and offset are mutually exclusive; unpaged is mutually exclusive with page, offset, size, and limit",
  }
);

// =============================================================================
// Project Files (BETA) Schemas
// =============================================================================
// Map 1:1 onto the "Projects: Files (BETA)" REST API:
//   GET    /projects/{projectId}/files/{path}     -> openl_read_project_file
//   POST   /projects/{projectId}/files/{path}     -> openl_write_project_file
//   DELETE /projects/{projectId}/files/{path}     -> openl_delete_project_file
//   POST   /projects/{projectId}/file-search      -> openl_search_project_files
//   POST   /projects/{projectId}/file-copy        -> openl_copy_project_file
//   POST   /projects/{projectId}/file-move        -> openl_move_project_file

const filePathSchema = z
  .string()
  .min(1)
  .describe(
    "Project-relative path to the resource (e.g. 'rules/Model.xlsx'). Do NOT include the project name itself; paths are relative to the project root. A trailing slash denotes a folder."
  );

const fileBranchSchema = branchNameSchema
  .optional()
  .describe(
    "Branch the project must be on for this operation. Ignored when blank. Fails if the repository has no branches or the project is on another branch. Omit for repository 'local' and non-branch repositories."
  );

export const readProjectFileSchema = z.object({
  projectId: projectIdSchema,
  path: z
    .string()
    .default("")
    .describe(
      "Project-relative path to a file or folder (e.g. 'rules/Model.xlsx' or 'rules/'). Empty string (default) or a path ending in '/' lists the project root / that folder; a file path returns the file content."
    ),
  view: z
    .enum(["meta"])
    .optional()
    .describe(
      "For a file, set to 'meta' to return JSON metadata (name, size, extension, lastModified) instead of the file content. Omit to read content (files) or list entries (folders)."
    ),
  download: z
    .boolean()
    .optional()
    .describe(
      "For a folder, set true to download the folder and its contents as a ZIP archive (returned base64-encoded). Ignored for files."
    ),
  recursive: z
    .boolean()
    .optional()
    .describe("Folder listing only: include nested resources recursively (default false)."),
  viewMode: z
    .enum(["FLAT", "NESTED"])
    .optional()
    .describe("Folder listing only: FLAT returns a flat list, NESTED returns a tree (default FLAT)."),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Folder listing only: filter by file extensions without the dot, e.g. ['xlsx','xml']."),
  namePattern: z
    .string()
    .optional()
    .describe("Folder listing only: filter by name (case-insensitive contains match)."),
  foldersOnly: z
    .boolean()
    .optional()
    .describe("Folder listing only: if true, return only folders (default false)."),
  version: z
    .string()
    .optional()
    .describe(
      "Historical revision (commit hash) to read. Omit to read the latest revision. Applies to file content/metadata and folder listing/ZIP. An unknown revision yields 404."
    ),
  branch: fileBranchSchema,
  fields: z
    .string()
    .optional()
    .describe(
      "Comma-separated response fields to return for metadata/listing responses, including nested selection (e.g. 'id,name'). When omitted, the full response is returned."
    ),
  encoding: z
    .enum(["auto", "utf-8", "base64"])
    .default("auto")
    .describe(
      "How to return file content. 'auto' (default) returns text as UTF-8 and binary as base64; 'utf-8' forces text; 'base64' forces base64. Ignored for metadata/listing responses."
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Byte offset to start reading file content from (default 0). NOTE: the backend does not support partial transfers, so the whole file is fetched and then sliced client-side. offset/length are BYTE offsets — a range boundary that lands inside a multi-byte UTF-8 character makes that character decode to U+FFFD (�) at the seam; for exact bytes use encoding='base64'."
    ),
  length: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of bytes of file content to return starting at 'offset'. Omit for the rest of the file. Byte count, not character count (see the note on 'offset')."),
  response_format: ResponseFormat.optional(),
}).strict();

export const writeProjectFileSchema = z.object({
  projectId: projectIdSchema,
  path: filePathSchema,
  content: z
    .string()
    .describe("File content, interpreted according to 'encoding'. Use base64 for binary files (xlsx, images, zip)."),
  encoding: z
    .enum(["utf-8", "base64"])
    .default("utf-8")
    .describe("How 'content' is encoded: 'utf-8' (default) for text, 'base64' for binary."),
  createFolders: z
    .boolean()
    .default(true)
    .describe("If true (default), missing intermediate folders are created automatically; otherwise the parent folder must already exist."),
  conflictPolicy: z
    .enum(["FAIL", "OVERWRITE", "SKIP"])
    .optional()
    .describe("How to handle a target file that already exists: FAIL (default) returns an error; OVERWRITE replaces its content in place; SKIP leaves the existing file unchanged and reports it skipped. Has no effect when creating a new file."),
  message: z
    .string()
    .optional()
    .describe("Optional commit message. PRESENT → the write is committed to Git after saving the project (a new revision is created). ABSENT → the write stays in the project WORKING COPY (commit it later with openl_save_project). NOTE: committing saves ALL pending project changes (OpenL has no per-file commit), and only works for design (Git) repositories — not 'local'."),
  branch: fileBranchSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const deleteProjectFileSchema = z.object({
  projectId: projectIdSchema,
  path: filePathSchema,
  branch: fileBranchSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const searchProjectFilesSchema = z.object({
  projectId: projectIdSchema,
  pattern: z
    .string()
    .optional()
    .describe("Ant-glob path pattern, e.g. 'rules/**/*.xlsx' or '**/*.xml'."),
  content: z
    .string()
    .optional()
    .describe("Case-insensitive content substring to match inside files (full-text search)."),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Filter by file extensions without the dot, e.g. ['xlsx','xml']."),
  type: z
    .enum(["FILE", "FOLDER", "ANY"])
    .optional()
    .describe("Restrict results to files, folders, or both (ANY, default)."),
  scope: z
    .enum(["SUBTREE", "ANCESTORS"])
    .optional()
    .describe("SUBTREE (default) searches within the project; ANCESTORS walks up to the repository root."),
  recursive: z
    .boolean()
    .optional()
    .describe("Whether to descend into nested folders. IMPORTANT: defaults to false (top level only) — set true to search the whole project/subtree. A '**' glob still needs recursive:true to actually descend."),
  from: z
    .string()
    .optional()
    .describe("Project-relative path to start the search from."),
  version: z
    .string()
    .optional()
    .describe("Historical revision (commit hash) to search; SUBTREE scope only."),
  branch: fileBranchSchema,
  fields: z
    .string()
    .optional()
    .describe("Comma-separated response fields to return per result (e.g. 'path,name,type'). When omitted, the full response is returned."),
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

// Intentionally has no `response_format` or pagination: the tool returns a single
// aggregated markdown document (one AGENTS.md chain), which has no alternate format
// or pages — do not add them to match the other tools.
export const getProjectAgentsMdSchema = z.object({
  projectId: projectIdSchema,
  folder: z
    .string()
    .max(1024)
    .optional()
    .describe(
      "Optional project-relative sub-folder to start the walk-up from, e.g. 'rules' or 'rules/pricing'. Use this to get the AGENTS.md chain that applies to a file deeper inside the project ('the AGENTS.md nearest the edited file wins'). Omit to start at the project root. Do NOT include the project name; the path is relative to the project root."
    ),
  branch: fileBranchSchema,
}).strict();

const copyMovePairSchema = {
  projectId: projectIdSchema,
  sourcePath: z
    .string()
    .min(1)
    .describe("Project-relative path of the source file (e.g. 'rules/Model.xlsx')."),
  destinationPath: z
    .string()
    .min(1)
    .describe("Project-relative destination path (e.g. 'rules/Model-copy.xlsx'). Intermediate folders are created automatically."),
  branch: fileBranchSchema,
  response_format: ResponseFormat.optional(),
};

export const copyProjectFileSchema = z.object(copyMovePairSchema).strict();

export const moveProjectFileSchema = z.object(copyMovePairSchema).strict();

// =============================================================================
// Redeploy Schema
// =============================================================================

export const redeployProjectSchema = z.object({
  deploymentId: z.string().describe("Deployment ID to redeploy (from list_deployments response)"),
  projectId: projectIdSchema,
  comment: commentSchema,
  response_format: ResponseFormat.optional(),
}).strict();


