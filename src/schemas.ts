/**
 * Zod Schemas for MCP Tool Input Validation
 *
 * This module defines all input schemas for OpenL Studio MCP tools using Zod.
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
  limit: z.number().int().positive().max(200).optional().default(50),
  offset: z.number().int().nonnegative().optional().default(0),
});

// Project ID: opaque backend identifier from openl_list_projects() response
export const projectIdSchema = z.string().describe("Project ID returned by backend. Use the exact 'projectId' value from openl_list_projects() response without modification or reformatting.");

export const repositoryNameSchema = z.string().describe("Repository name (display name, not ID). Use the 'name' field from openl_list_repositories() response (e.g., if list_repositories returns {id: 'design-repo', name: 'Design Repository'}, use 'Design Repository' here, NOT 'design-repo').");

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
  response_format: ResponseFormat.optional(),
}).strict();

export const updateTableSchema = z.object({
  projectId: projectIdSchema,
  tableId: tableIdSchema,
  view: z.record(z.string(), z.any()).describe("FULL table structure from get_table() with your modifications applied. MUST include: id, tableType, kind, name, plus type-specific data (rules for SimpleRules, rows for Spreadsheet, fields for Datatype). Do NOT send only the changed fields - send the complete structure. Workflow: 1) currentTable = get_table(), 2) currentTable.rules[0]['Column'] = newValue, 3) update_table(view=currentTable)"),
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

export const createProjectTableSchema = z.object({
  projectId: projectIdSchema,
  moduleName: z.string().min(1).describe("Name of an existing project module where the table will be created (for example, 'Rules')."),
  sheetName: z.string().optional().describe("Name of the sheet where the table will be created within the Excel file. If not provided, the table name will be used as the sheet name."),
  table: z.record(z.string(), z.any()).describe("Complete table structure (EditableTableView). Must include at least tableType, kind, and name, plus type-specific data (for example rules/headers for Rules tables, rows for Spreadsheet, fields for Datatype). id is optional for create requests."),
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
  failures: z.number().int().positive().optional().default(5).describe("Number of failed test units to include in the summary (default: 5, min: 1)"),
  unpaged: z.boolean().optional().default(false).describe("Return all results without pagination"),
  response_format: ResponseFormat.optional(),
}).strict();

export const getTestResultsSchema = z.object({
  projectId: projectIdSchema,
  failuresOnly: z.boolean().optional().describe("Show only failed tests (default: false)"),
  failures: z.number().int().positive().optional().default(5).describe("Number of failed test units to include in the summary (default: 5, min: 1)"),
  page: z.number().int().nonnegative().optional().describe("Page number (0-based). Mutually exclusive with offset"),
  offset: z.number().int().nonnegative().optional().describe("Offset for pagination. Mutually exclusive with page"),
  size: z.number().int().positive().optional().describe("Page size (number of results per page)"),
  limit: z.number().int().positive().max(200).optional().describe("Page size (alias for size, maps to size parameter)"),
  unpaged: z.boolean().optional().default(false).describe("Return all results without pagination. Mutually exclusive with page, offset, size, and limit"),
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
  failures: z.number().int().positive().optional().default(5).describe("Number of failed test units to include in the summary (default: 5, min: 1)"),
  page: z.number().int().nonnegative().optional().describe("Page number (0-based). Mutually exclusive with offset"),
  offset: z.number().int().nonnegative().optional().describe("Offset for pagination. Mutually exclusive with page"),
  size: z.number().int().positive().optional().describe("Page size (number of results per page)"),
  limit: z.number().int().positive().max(200).optional().describe("Page size (alias for size, maps to size parameter)"),
  unpaged: z.boolean().optional().default(false).describe("Return all results without pagination. Mutually exclusive with page, offset, size, and limit"),
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
// Redeploy Schema
// =============================================================================

export const redeployProjectSchema = z.object({
  deploymentId: z.string().describe("Deployment ID to redeploy (from list_deployments response)"),
  projectId: projectIdSchema,
  comment: commentSchema,
  response_format: ResponseFormat.optional(),
}).strict();


