/**
 * MCP Tool Definitions
 *
 * This module defines all available tools for the OpenL Studio MCP server.
 * Each tool includes:
 * - Name and description
 * - Input schema (Zod-based validation)
 * - Metadata (_meta) for categorization and versioning
 *
 * To add a new tool:
 * 1. Add a Zod schema in schemas.ts
 * 2. Add the tool definition here
 * 3. Add the tool handler in the server implementation
 */

import * as schemas from "./schemas.js";
import { TOOL_CATEGORIES } from "./constants.js";

/**
 * Tool metadata interface
 */
export interface ToolMetadata {
  /** Semantic version of the tool */
  version: string;
  /** Category for logical grouping */
  category: string;
  /** Whether the tool requires authentication */
  requiresAuth: boolean;
  /** Whether the tool modifies server state */
  modifiesState?: boolean;
}

/**
 * Tool definition interface
 */
export interface ToolDefinition {
  /** Unique tool name */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for input validation */
  inputSchema: Record<string, unknown>;
  /** Tool metadata */
  _meta: ToolMetadata;
}

/**
 * All available MCP tools for OpenL Studio
 *
 * Tools are organized by category:
 * - System: Health checks and diagnostics
 * - Repository: Repository and branch management
 * - Project: Project lifecycle management
 * - Rules: Table/rules viewing and editing
 * - Version Control: Branching and history
 * - Deployment: Production deployment
 */
export const TOOLS: ToolDefinition[] = [
  // =============================================================================
  // Repository Tools
  // =============================================================================
  {
    name: "openl_list_repositories",
    description: "List all design repositories in OpenL Studio. Returns repository information including 'id' (internal identifier) and 'name' (display name). Use the 'name' field when working with repositories in other tools. Example: if response contains {id: 'design-repo', name: 'Design Repository'}, use 'Design Repository' (the name) in other tools like list_projects(repository: 'Design Repository').",
    inputSchema: schemas.z.toJSONSchema(schemas.z.object({
      response_format: schemas.ResponseFormat.optional(),
      limit: schemas.z.number().int().positive().max(200).default(50).optional(),
      offset: schemas.z.number().int().nonnegative().default(0).optional(),
    }).strict()) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.REPOSITORY,
      requiresAuth: true,
    },
  },
  {
    name: "openl_list_branches",
    description: "List all Git branches in a repository. Returns branch names and metadata (current branch, commit info). Use this to see available branches before switching or comparing versions. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'.",
    inputSchema: schemas.z.toJSONSchema(schemas.listBranchesSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.REPOSITORY,
      requiresAuth: true,
    },
  },
  {
    name: "openl_list_repository_features",
    description: "Get features supported by a design repository (branching, searchable, etc.). Use this to check if a repository supports specific features like branching before performing operations that depend on those features. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'.",
    inputSchema: schemas.z.toJSONSchema(schemas.getRepositoryFeaturesSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.REPOSITORY,
      requiresAuth: true,
    },
  },
  {
    name: "openl_repository_project_revisions",
    description: "Get revision history (commit history) of a project in a design repository. Returns list of revisions with commit hashes, authors, timestamps, and commit types. Supports pagination and filtering by branch and search term. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'.",
    inputSchema: schemas.z.toJSONSchema(schemas.getProjectRevisionsSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.REPOSITORY,
      requiresAuth: true,
    },
  },
  {
    name: "openl_list_deploy_repositories",
    description: "List all deployment repositories in OpenL Studio. Returns repository names, their types, and status information. Use this to discover all available deployment repositories before deploying projects.",
    inputSchema: schemas.z.toJSONSchema(schemas.listDeployRepositoriesSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.DEPLOYMENT,
      requiresAuth: true,
    },
  },

  // =============================================================================
  // Project Tools
  // =============================================================================
  {
    name: "openl_list_projects",
    description:
      "List all projects with optional filters (repository, status, tags). Returns project names, status (OPENED/CLOSED), metadata, and a convenient 'projectId' field from API to use with other tools. For local-only projects, do not pass repository filter 'local' (it may fail); list projects without that filter and filter results by repository === 'local' client-side. For such projects, open/save/close do not work; table/rule/test tools work without opening. IMPORTANT: The 'projectId' is returned exactly as provided by the API and should be used without modification. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'. Use this to discover and filter projects.",
    inputSchema: schemas.z.toJSONSchema(schemas.listProjectsSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_get_project",
    description: "Get comprehensive project information including details, modules, dependencies, and metadata. Returns full project structure, configuration, and status. Supports projects with repository 'local' (local-only projects; for them branches/revisions are not applicable). Use this to understand project organization before making changes.",
    inputSchema: schemas.z.toJSONSchema(schemas.getProjectSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_open_project",
    description: "Open a project for editing. Supports opening on specific branches or viewing specific Git revisions. Use this before making changes to project tables or rules. For branch switching, specify the branch parameter. For viewing a historical version, specify the revision parameter. Does not work for projects with repository 'local' (local-only, not connected to remote Git).",
    inputSchema: schemas.z.toJSONSchema(schemas.openProjectSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_save_project",
    description: "Save project changes to Git. Works only when project status is EDITING (after opening and making changes). Requires comment (used as revision/commit message). Creates a new revision and transitions project to OPENED. Optional closeAfterSave: true saves and closes in one request (sends status CLOSED). Use after update_table, append_table, or other edits. Does not work for repository 'local'. Validates project before saving if validation endpoint is available.",
    inputSchema: schemas.z.toJSONSchema(schemas.saveProjectSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_close_project",
    description: "Close a project. If the project has unsaved changes (status EDITING), either save (saveChanges: true with comment) or discard (discardChanges: true). When discarding, ask the user for confirmation first, then call again with confirmDiscard: true. Does not work for repository 'local'.",
    inputSchema: schemas.z.toJSONSchema(schemas.closeProjectSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_create_project_branch",
    description: "Create a new branch in a project's repository from a specified revision. Allows branching from specific revisions, tags, or other branches. If no revision is specified, the HEAD revision will be used. Use this to manage project versions and isolate development work.",
    inputSchema: schemas.z.toJSONSchema(schemas.createBranchSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_list_project_local_changes",
    description: "List local change history for a project. Returns list of workspace history items with versions, authors, timestamps, and comments. NOTE: Requires the project to be opened (openl_open_project first); not available for repository 'local' (local projects cannot be opened). Uses session-based project context; no projectId parameter.",
    inputSchema: schemas.z.toJSONSchema(schemas.listProjectLocalChangesSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_restore_project_local_change",
    description: "Restore a project to a specified version from its local history. Use the historyId from openl_list_project_local_changes response. NOTE: Requires the project to be opened first; not available for repository 'local'. Uses session-based project context; no projectId parameter.",
    inputSchema: schemas.z.toJSONSchema(schemas.restoreProjectLocalChangeSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
      modifiesState: true,
    },
  },

  // =============================================================================
  // File Management Tools
  // =============================================================================
  {
    name: "openl_upload_file",
    description: "Upload an Excel file (.xlsx or .xls) containing rules to a project. The file is uploaded to OpenL Studio workspace but NOT committed to Git yet - changes remain in-memory until you save the project using openl_save_project. Returns file metadata and upload confirmation. Use this to add or replace Excel rule files. IMPORTANT: The fileName parameter can be a simple name (e.g., 'Rules.xlsx'), subdirectory path (e.g., 'rules/Premium.xlsx'), or full path (e.g., 'Example 1 - Bank Rating/Bank Rating.xlsx'). To replace an existing file, use the exact 'file' field from list_tables().",
    inputSchema: schemas.z.toJSONSchema(schemas.uploadFileSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_download_file",
    description: "Download an Excel file from OpenL project. Can download latest version (HEAD) or specific historical version using Git commit hash. Saves binary content to local path provided in outputFilePath and returns file metadata. IMPORTANT: Use the exact 'file' field from list_tables() response as the fileName parameter (e.g., 'Example 2 - Corporate Rating/Corporate Rating.xlsx' or 'rules/Premium.xlsx').",
    inputSchema: schemas.z.toJSONSchema(schemas.downloadFileSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },

  // =============================================================================
  // Rules (Tables) Tools
  // =============================================================================
  {
    name: "openl_list_tables",
    description: "List all tables/rules in a project with optional filters for type, name, and file. Returns table metadata including 'tableId' (the 'id' field) which is required for calling get_table(), update_table(), append_table(), or run_project_tests(). Use the 'tableId' field from the response to reference specific tables in other API calls.",
    inputSchema: schemas.z.toJSONSchema(schemas.listTablesSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.RULES,
      requiresAuth: true,
    },
  },
  {
    name: "openl_get_table",
    description: "Get detailed information about a specific table/rule. Returns table structure, signature, conditions, actions, dimension properties, and all row data. Use this to understand existing rules before modifying them.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTableSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.RULES,
      requiresAuth: true,
    },
  },
  {
    name: "openl_update_table",
    description: "Replace the ENTIRE table structure with a modified version. Use for MODIFYING existing rows, DELETING rows, REORDERING rows, or STRUCTURAL changes. CRITICAL: Must send the FULL table structure (not just modified fields). DO NOT use for simple additions - use append_table instead. Required workflow: 1) Call get_table() to retrieve complete structure, 2) Modify the returned object (e.g., update rules array, change fields, delete rows), 3) Pass the ENTIRE modified object to update_table(). Required fields: id, tableType, kind, name, plus type-specific fields (rules for SimpleRules, rows for Spreadsheet, fields for Datatype). Modifies table in memory (requires save_project to persist changes).",
    inputSchema: schemas.z.toJSONSchema(schemas.updateTableSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.RULES,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_append_table",
    description: "Append new rows/fields to an existing table WITHOUT replacing the entire structure. Use for ADDING rows/fields ONLY - does not modify existing data. Examples: Adding 1 row → use append_table. Adding multiple rows → use append_table. Adding fields to Datatype → use append_table. More efficient than update_table for simple additions. Only requires the NEW data to append, not the full table structure. For modifications, deletions, or reordering → use update_table instead. Workflow: 1) Call get_table() to understand current structure, 2) Prepare only the new data to add, 3) Call append_table() with appendData. Modifies table in memory (requires save_project to persist changes).",
    inputSchema: schemas.z.toJSONSchema(schemas.appendTableSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.RULES,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_create_project_table",
    description: "Create a new table/rule in OpenL project using BETA API (Create New Project Table). This is the recommended tool for creating new OpenL tables programmatically. Use cases: Create Rules (decision tables), Spreadsheet tables, Datatype definitions, Test tables, or other table types. Requires moduleName (existing project module name) and complete table structure (EditableTableView). The table structure must include at least tableType, kind, name, plus type-specific data (rules/headers for Rules tables, rows for Spreadsheet, fields for Datatype). id is optional for create requests. Use get_table() on an existing table as a reference for the structure. This tool uses the Create New Project Table (BETA) API endpoint.",
    inputSchema: schemas.z.toJSONSchema(schemas.createProjectTableSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.RULES,
      requiresAuth: true,
      modifiesState: true,
    },
  },

  // =============================================================================
  // Deployment Tools
  // =============================================================================
  {
    name: "openl_list_deployments",
    description: "List all active deployments across production environments. Returns deployment names, repositories, versions, and status information. Use this to see what's currently deployed before making deployment decisions.",
    inputSchema: schemas.z.toJSONSchema(schemas.z.object({
      response_format: schemas.ResponseFormat.optional(),
      limit: schemas.z.number().int().positive().max(200).default(50).optional(),
      offset: schemas.z.number().int().nonnegative().default(0).optional(),
    }).strict()) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.DEPLOYMENT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_deploy_project",
    description: "Deploy a project to production environment. Publishes rules to a deployment repository for runtime execution. Returns deployment status and confirmation. Requires validated project with no errors. Use production repository name (not ID) - e.g., 'Production Deployment' instead of 'production-deploy'.",
    inputSchema: schemas.z.toJSONSchema(schemas.deployProjectSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.DEPLOYMENT,
      requiresAuth: true,
      modifiesState: true,
    },
  },
  {
    name: "openl_redeploy_project",
    description: "Redeploy an existing deployment with a new project version. Use this to update a deployment with a newer version of the project or rollback to a previous version.",
    inputSchema: schemas.z.toJSONSchema(schemas.redeployProjectSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.DEPLOYMENT,
      requiresAuth: true,
      modifiesState: true,
    },
  },

  // =============================================================================
  // Testing & Validation Tools
  // =============================================================================
  {
    name: "openl_start_project_tests",
    description: "Start project test execution. For design repositories the project is automatically opened if closed; for repository 'local' the project is not opened (tests run directly). Returns execution status and metadata. Test results can be retrieved using openl_get_test_results_summary, openl_get_test_results, or openl_get_test_results_by_table.",
    inputSchema: schemas.z.toJSONSchema(schemas.startProjectTestsSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_get_test_results_summary",
    description: "Get brief test execution summary without detailed test cases. Returns aggregated statistics (execution time, total tests, passed, failed) without the testCases array. Use openl_start_project_tests() first to start test execution.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTestResultsSummarySchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_get_test_results",
    description: "Get full test execution results with pagination support. Returns complete test execution summary including testCases array grouped by table. IMPORTANT: Pagination applies to test tables (not individual test cases). Each page returns test results aggregated by table (e.g., 'TestTable1' with 7 tests, 'TestTable2' with 8 tests). Supports filtering failures and pagination (page/offset/size). Use openl_start_project_tests() first to start test execution.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTestResultsSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  {
    name: "openl_get_test_results_by_table",
    description: "Get test execution results filtered by specific table ID. Returns filtered test execution summary with only test cases for the specified table. Supports pagination (page/offset/size) for efficient data retrieval. Use openl_start_project_tests() first to start test execution.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTestResultsByTableSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.PROJECT,
      requiresAuth: true,
    },
  },
  // Note: The following tools are temporarily disabled until client.ts gets proper support:
  // - validate_project: Validate entire project for compilation errors
  // - get_project_errors: Get comprehensive project error analysis
  // - compare_versions: Compare two Git commit versions
  // Use execute_rule to manually test individual rules with input data instead.

  // TEMPORARILY DISABLED - Pending client.ts support
  // {
  //   name: "validate_project",
  //   description: "Validate entire project for compilation errors, type errors, and warnings. Returns validation status and detailed error list if issues found. Required before deployment; use this to catch issues early.",
  //   inputSchema: schemas.z.toJSONSchema(schemas.validateProjectSchema) as Record<string, unknown>,
  //   _meta: {
  //     version: "1.0.0",
  //     category: TOOL_CATEGORIES.PROJECT,
  //     requiresAuth: true,
  //   },
  // },
  // {
  //   name: "get_project_errors",
  //   description: "Get comprehensive project error analysis with detailed categorization (type errors, syntax errors, reference errors) and auto-fix suggestions. Returns error severity, locations, and actionable guidance. Use this to understand and fix validation failures.",
  //   inputSchema: schemas.z.toJSONSchema(schemas.getProjectErrorsSchema) as Record<string, unknown>,
  //   _meta: {
  //     version: "1.0.0",
  //     category: TOOL_CATEGORIES.PROJECT,
  //     requiresAuth: true,
  //   },
  // },
  // {
  //   name: "test_project",
  //   description: "Run project tests in OpenL Studio. Can run specific tests by name or all tests in the project. Returns test execution results with pass/fail status, assertions, and coverage information. Use this to verify rule behavior and catch regressions before deployment.",
  //   inputSchema: schemas.z.toJSONSchema(schemas.testProjectSchema) as Record<string, unknown>,
  //   _meta: {
  //     version: "1.0.0",
  //     category: TOOL_CATEGORIES.PROJECT,
  //     requiresAuth: true,
  //   },
  // },

  // =============================================================================
  // Phase 3: Versioning & Execution Tools
  // =============================================================================
  {
    name: "openl_execute_rule",
    description: "Execute a rule with input data to test its behavior and validate changes. Runs the rule with provided parameters and returns calculated result. Use this to verify rule logic before deploying changes.",
    inputSchema: schemas.z.toJSONSchema(schemas.executeRuleSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.RULES,
      requiresAuth: true,
    },
  },
  // TEMPORARILY DISABLED - Pending client.ts support
  // {
  //   name: "compare_versions",
  //   description: "Compare two Git commit versions of a project using commit hashes. Returns detailed diff showing added, modified, and removed tables/files with specific changes. Use this to review what changed between versions before reverting or deploying.",
  //   inputSchema: schemas.z.toJSONSchema(schemas.compareVersionsSchema) as Record<string, unknown>,
  //   _meta: {
  //     version: "2.0.0",
  //     category: TOOL_CATEGORIES.VERSION_CONTROL,
  //     requiresAuth: true,
  //   },
  // },

  // =============================================================================
  // Phase 4: Advanced Features
  // =============================================================================
  {
    name: "openl_revert_version",
    description: "Revert project to a previous Git commit using commit hash. Creates a new commit that restores old content while preserving full history. Returns new commit hash. Use this to roll back problematic changes while maintaining audit trail.",
    inputSchema: schemas.z.toJSONSchema(schemas.revertVersionSchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.VERSION_CONTROL,
      requiresAuth: true,
      modifiesState: true,
    },
  },

  // =============================================================================
  // Phase 2: Git Version History Tools
  // =============================================================================
  {
    name: "openl_get_file_history",
    description: "Get Git commit history for a specific file. Returns list of commits with hashes, authors, timestamps, and commit types. Use this to see all versions of a file over time.",
    inputSchema: schemas.z.toJSONSchema(schemas.getFileHistorySchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.VERSION_CONTROL,
      requiresAuth: true,
    },
  },
  {
    name: "openl_get_project_history",
    description: "Get Git commit history for entire project. Returns chronological list of all commits with metadata about files and tables changed. Supports pagination and branch filtering.",
    inputSchema: schemas.z.toJSONSchema(schemas.getProjectHistorySchema) as Record<string, unknown>,
    _meta: {
      version: "1.0.0",
      category: TOOL_CATEGORIES.VERSION_CONTROL,
      requiresAuth: true,
    },
  },

];

/**
 * Get a tool definition by name
 *
 * @param name - Tool name
 * @returns Tool definition or undefined if not found
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * Get all tools in a specific category
 *
 * @param category - Tool category
 * @returns Array of tool definitions in that category
 */
export function getToolsByCategory(category: string): ToolDefinition[] {
  return TOOLS.filter((tool) => tool._meta.category === category);
}

/**
 * Get all tool names
 *
 * @returns Array of all tool names
 */
export function getAllToolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}
