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

export const tableIdSchema = z.string().describe("Table identifier - unique ID assigned by OpenL Studio when table is created (e.g., 'calculatePremium_1234')");

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

export const getProjectInfoSchema = z.object({
  repository: repositoryNameSchema,
  projectName: projectNameSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const projectActionSchema = z.object({
  projectId: projectIdSchema,
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
        required: z.boolean().optional().describe("Whether field is required"),
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
      steps: z.array(z.unknown()).describe("Array of spreadsheet step objects to append"),
    }),
    // SmartRulesAppend
    z.object({
      tableType: z.literal("SmartRules"),
      rules: z.array(z.record(z.string(), z.unknown())).describe("Array of rule objects to append. Each rule is a map with condition and action columns."),
    }),
    // VocabularyAppend
    z.object({
      tableType: z.literal("Vocabulary"),
      values: z.array(z.unknown()).describe("Array of vocabulary value objects to append"),
    }),
    // RawSourceAppend
    z.object({
      tableType: z.literal("RawSource"),
      rows: z.array(z.array(z.record(z.string(), z.unknown()))).describe("Array of rows to append; each row is an array of cell objects (e.g. { value: string, colspan?: number } or { covered?: boolean })"),
    }),
  ]).describe("Data structure to append to the table. Structure depends on tableType: Datatype uses 'fields', SimpleRules/SmartRules use 'rules', SimpleSpreadsheet uses 'steps', Vocabulary uses 'values', RawSource uses 'rows' (array of rows)"),
  response_format: ResponseFormat.optional(),
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
// Testing & Validation (Critical Missing Tools)
// =============================================================================
// Note: The following schemas are placeholders for tools that are temporarily disabled
// pending client.ts support for the OpenL Studio REST API endpoints.

export const validateProjectSchema = z.object({
  projectId: projectIdSchema,
  response_format: ResponseFormat.optional(),
}).strict();

export const testProjectSchema = z.object({
  projectId: projectIdSchema,
  testName: z.string().optional().describe("Specific test name to run (e.g., 'testPremiumCalculation'). Omit to run all tests in the project."),
  allTests: z.boolean().optional().describe("Set to true to explicitly run all tests in the project (default: false). When false and testName is omitted, runs all tests."),
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

export const uploadFileSchema = z.object({
  projectId: projectIdSchema,
  fileName: z.string().describe("Path where the file should be uploaded in the project (.xlsx or .xls). Can be a simple filename (e.g., 'Rules.xlsx'), subdirectory path (e.g., 'rules/Premium.xlsx'), or full path (e.g., 'Example 1 - Bank Rating/Bank Rating.xlsx'). To replace an existing file, use the exact 'file' field value from list_tables()."),
  localFilePath: z.string().describe("Absolute or workspace-relative path to local binary file to upload (.xlsx or .xls)."),
  comment: z.string().optional().describe("Optional comment for when the file is eventually saved/committed to Git (e.g., 'Updated CA premium rates'). The upload itself does NOT create a commit - use openl_save_project to save changes."),
  response_format: ResponseFormat.optional(),
}).strict();

export const downloadFileSchema = z.object({
  projectId: projectIdSchema,
  fileName: z.string().describe("Name of the Excel file to download. MUST use the exact 'file' field value from list_tables() response (e.g., 'Rules.xlsx', 'rules/Insurance.xlsx'). Do NOT construct paths manually or guess file names - always get the path from list_tables() first."),
  version: z.string().optional().describe("Git commit hash to download specific version (e.g., '7a3f2b1c...'). Omit for latest version (HEAD)"),
  outputFilePath: z.string().describe("Absolute or workspace-relative path where downloaded binary file should be written."),
  response_format: ResponseFormat.optional(),
}).strict();

export const createRuleSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().min(1).describe("Table name (must be valid Java identifier, e.g., 'calculatePremium')"),
  tableType: z.enum([
    // Decision Tables (most common)
    "Rules", "SimpleRules", "SmartRules", "SimpleLookup", "SmartLookup",
    // Spreadsheet (most common)
    "Spreadsheet",
    // Other types (rarely used)
    "Method", "TBasic", "Data", "Datatype", "Test", "Run", "Properties", "Configuration"
  ]).describe("Type of table to create. Most common: Rules/SimpleRules/SmartRules/SimpleLookup/SmartLookup (decision tables) or Spreadsheet (calculations)"),
  returnType: z.string().optional().describe("Return type (e.g., 'int', 'String', 'SpreadsheetResult', or custom type like 'Policy')"),
  parameters: z.array(z.object({
    type: z.string().describe("Parameter type (e.g., 'String', 'int', 'double', 'Policy')"),
    name: z.string().describe("Parameter name (e.g., 'driverType', 'age', 'policy')")
  })).optional().describe("Method parameters for the table signature"),
  file: z.string().optional().describe("Target Excel file (e.g., 'rules/Insurance.xlsx'). If not specified, uses default file."),
  properties: z.record(z.string(), z.any()).optional().describe("Dimension properties (e.g., { state: 'CA', lob: 'Auto', effectiveDate: '01/01/2025' })"),
  comment: commentSchema,
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

const editableTableViewSchema = z.discriminatedUnion("tableType", [
  // Datatype — a data structure definition.
  z.object({
    tableType: z.literal("Datatype"),
    ...commonTableFields,
    extends: z.string().optional().describe("Parent datatype to extend, if any."),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      defaultValue: z.any().optional(),
    })).optional().describe("Field definitions: [{ name, type }]."),
  }),
  // Vocabulary — an enumeration of values.
  z.object({
    tableType: z.literal("Vocabulary"),
    ...commonTableFields,
    type: z.string().optional().describe("Vocabulary element type."),
    values: z.array(z.any()).optional().describe("Vocabulary values."),
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
    headers: z.array(z.record(z.string(), z.any())).optional(),
    rules: z.array(z.record(z.string(), z.any())).optional().describe("Rows as maps keyed by the header captions."),
  }),
  // SimpleLookup / SmartLookup — lookup tables (LookupView): rows is an array of maps.
  z.object({
    tableType: z.literal("SimpleLookup"),
    ...commonTableFields,
    ...executableFields,
    collect: z.boolean().optional(),
    headers: z.array(z.record(z.string(), z.any())).optional(),
    rows: z.array(z.record(z.string(), z.any())).optional(),
  }),
  z.object({
    tableType: z.literal("SmartLookup"),
    ...commonTableFields,
    ...executableFields,
    collect: z.boolean().optional(),
    headers: z.array(z.record(z.string(), z.any())).optional(),
    rows: z.array(z.record(z.string(), z.any())).optional(),
  }),
  // SimpleSpreadsheet — steps.
  z.object({
    tableType: z.literal("SimpleSpreadsheet"),
    ...commonTableFields,
    ...executableFields,
    steps: z.array(z.record(z.string(), z.any())).optional().describe("Spreadsheet steps."),
  }),
  // Spreadsheet — rows/columns/cells.
  z.object({
    tableType: z.literal("Spreadsheet"),
    ...commonTableFields,
    ...executableFields,
    rows: z.array(z.record(z.string(), z.any())).optional(),
    columns: z.array(z.record(z.string(), z.any())).optional(),
    cells: z.array(z.array(z.any())).optional().describe("2D matrix of spreadsheet cells."),
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
    source: z.array(z.array(z.any())).optional().describe("2D matrix of raw cells."),
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

// =============================================================================
// Phase 2: Testing & Validation Schemas
// =============================================================================
// Note: runTestSchema removed - endpoint doesn't exist in API

export const getProjectErrorsSchema = z.object({
  projectId: projectIdSchema,
  includeWarnings: z.boolean().optional().describe("Include warnings along with errors (default: true). Set to false to show only critical errors that block deployment."),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Phase 3: Versioning & Execution Schemas
// =============================================================================

export const executeRuleSchema = z.object({
  projectId: projectIdSchema,
  ruleName: z.string().describe("Name of the rule/method to execute (e.g., 'calculatePremium', 'validatePolicy'). Must match exact table name."),
  inputData: z.record(z.string(), z.any()).describe("Input data for rule execution as JSON object with parameter names as keys (e.g., { \"driverType\": \"SAFE\", \"age\": 30, \"vehicleValue\": 25000 })"),
  response_format: ResponseFormat.optional(),
}).strict();

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

export const getTraceNodesSchema = z.object({
  projectId: projectIdSchema,
  nodeId: z.number().int().nonnegative().optional().describe("Parent node ID. Omit for root nodes."),
  showRealNumbers: z.boolean().optional().describe("Show exact numbers instead of formatted (default: false)."),
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
  response_format: ResponseFormat.optional(),
}).strict();

export const compareVersionsSchema = z.object({
  projectId: projectIdSchema,
  baseCommitHash: z.string().describe("Base Git commit hash to compare from (e.g., '7a3f2b1c...')"),
  targetCommitHash: z.string().describe("Target Git commit hash to compare to (e.g., '9e5d8a2f...')"),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Phase 4: Advanced Features
// =============================================================================

export const revertVersionSchema = z.object({
  projectId: projectIdSchema,
  targetVersion: z.string().describe("Git commit hash to revert to (e.g., '7a3f2b1c...')"),
  comment: commentSchema,
  confirm: z.boolean().describe("Must be true to proceed with this destructive operation"),
  response_format: ResponseFormat.optional(),
}).strict();

// =============================================================================
// Phase 2: Git Version History Schemas
// =============================================================================

export const getFileHistorySchema = z.object({
  projectId: projectIdSchema,
  filePath: z.string().min(1).describe("File path within project (e.g., 'rules/Insurance.xlsx')"),
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

export const getProjectHistorySchema = z.object({
  projectId: projectIdSchema,
  branch: z.string().optional().describe("Git branch name (default: current branch)"),
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict();

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


