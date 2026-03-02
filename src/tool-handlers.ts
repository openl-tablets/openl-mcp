/**
 * Tool Handlers for OpenL Studio MCP Server
 *
 * This module implements the registerTool pattern to replace the switch statement
 * in index.ts. Each tool is registered individually with its own handler function.
 *
 * Benefits:
 * - Cleaner separation of concerns
 * - Easier to test individual tools
 * - Better type safety with dedicated handlers
 * - Proper MCP annotations for each tool
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { OpenLClient } from "./client.js";
import * as schemas from "./schemas.js";
import { formatResponse, paginateResults } from "./formatters.js";
import { validateResponseFormat, validatePagination } from "./validators.js";
import { logger } from "./logger.js";
import { isAxiosError, sanitizeError, extractApiErrorInfo, sanitizeJson } from "./utils.js";
import type * as Types from "./types.js";

/**
 * Tool response structure
 */
interface ToolResponse {
  content: Array<{ type: string; text: string }>;
}

/**
 * Tool handler function type
 */
type ToolHandler = (args: unknown, client: OpenLClient) => Promise<ToolResponse>;

/**
 * Tool definition with MCP metadata
 */
interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  version: string; // Semantic version (e.g., "2.0.0")
  annotations?: {
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
  };
  handler: ToolHandler;
}

/**
 * Registry of all tool handlers
 */
const toolHandlers = new Map<string, ToolDefinition>();

/**
 * Register a single tool with the registry
 *
 * @param tool - Tool definition with handler
 */
function registerTool(tool: ToolDefinition): void {
  toolHandlers.set(tool.name, tool);
}

/**
 * Get a tool definition by name
 *
 * @param name - Tool name
 * @returns Tool definition or undefined
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolHandlers.get(name);
}

/**
 * Get all registered tools (for ListTools handler)
 *
 * @returns Array of tool definitions without handlers
 */
export function getAllTools(): Array<Omit<ToolDefinition, "handler">> {
  return Array.from(toolHandlers.values()).map(({ handler: _handler, ...tool }) => tool);
}

/**
 * Execute a tool by name
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @param client - OpenL client instance
 * @returns Tool execution result
 */
export async function executeTool(
  name: string,
  args: unknown,
  client: OpenLClient
): Promise<ToolResponse> {
  const tool = toolHandlers.get(name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  try {
    return await tool.handler(args, client);
  } catch (error: unknown) {
    throw handleToolError(error, name, args);
  }
}

/**
 * Register all OpenL Studio tools
 *
 * This function registers all tools with their handlers, replacing the
 * switch statement pattern with a more modular registry-based approach.
 *
 * @param server - MCP Server instance (for future use)
 * @param client - OpenL Studio API client (for future use)
 */
export function registerAllTools(_server: Server, _client: OpenLClient): void {
  // =============================================================================
  // Repository Tools
  // =============================================================================

  registerTool({
    name: "openl_list_repositories",
    title: "openl List Repositories",
    version: "1.0.0",
    description:
      "List all design repositories in OpenL Studio. Returns repository information including 'id' (internal identifier) and 'name' (display name). Use the 'name' field when working with repositories in other tools. Example: if response contains {id: 'design-repo', name: 'Design Repository'}, use 'Design Repository' (the name) in other tools like list_projects(repository: 'Design Repository').",
    inputSchema: schemas.z.toJSONSchema(
      schemas.z
        .object({
          response_format: schemas.ResponseFormat.optional(),
          limit: schemas.z.number().int().positive().max(200).default(50).optional(),
          offset: schemas.z.number().int().nonnegative().default(0).optional(),
        })
        .strict()
    ) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      } | undefined;

      const format = validateResponseFormat(typedArgs && typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs && typedArgs.limit, typedArgs && typedArgs.offset);

      const repositories = await client.listRepositories();

      // Apply pagination
      const paginated = paginateResults(repositories, limit, offset);

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit,
          offset,
          total: paginated.total_count,
        },
        dataType: "repositories",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_list_branches",
    title: "openl List Branches",
    version: "1.0.0",
    description:
      "List all Git branches in a repository. Returns branch names and metadata (current branch, commit info). Use this to see available branches before switching or comparing versions. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'.",
    inputSchema: schemas.z.toJSONSchema(schemas.listBranchesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        repository: string;
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      };

      if (!typedArgs || !typedArgs.repository) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: repository. To find valid repositories, use: openl_list_repositories()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs.limit, typedArgs.offset);

      // Convert repository name to ID for API call
      const repositoryId = await client.getRepositoryIdByName(typedArgs.repository);
      const branches = await client.listBranches(repositoryId);

      // Apply pagination
      const paginated = paginateResults(branches, limit, offset);

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit,
          offset,
          total: paginated.total_count,
        },
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Project Tools
  // =============================================================================

  registerTool({
    name: "openl_list_projects",
    title: "openl List Projects",
    version: "1.0.0",
    description:
      "List all projects with optional filters (repository, status, tags). Returns project names, status (OPENED/CLOSED), metadata, and a convenient 'projectId' field from API to use with other tools. For local-only projects, do not pass repository filter 'local' (it may fail); list projects without that filter and filter results by repository === 'local' client-side. For such projects, open/save/close do not work; table/rule/test tools work without opening. IMPORTANT: The 'projectId' is returned exactly as provided by the API and should be used without modification. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'. Use this to discover and filter projects.",
    inputSchema: schemas.z.toJSONSchema(schemas.listProjectsSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = (args as {
        repository?: string;
        status?: "LOCAL" | "ARCHIVED" | "OPENED" | "VIEWING_VERSION" | "EDITING" | "CLOSED";
        tags?: Record<string, string>;
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      }) || {};

      const format = validateResponseFormat(typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs.limit, typedArgs.offset);

      // Extract filters (only those supported by ProjectFilters type)
      const filters: Types.ProjectFilters = {};
      // Convert repository name to ID for API call
      if (typedArgs.repository) {
        filters.repository = await client.getRepositoryIdByName(typedArgs.repository);
      }
      if (typedArgs.status) filters.status = typedArgs.status;
      if (typedArgs.tags) filters.tags = typedArgs.tags;
      
      // Add pagination parameters (convert offset/limit to page/size for API)
      if (offset !== undefined && limit !== undefined) {
        filters.offset = offset;
        filters.limit = limit;
      }

      const projectsResponse = await client.listProjects(filters);

      // Handle case when API returns object instead of array
      // Some API versions return { content: [...], pageNumber, pageSize, numberOfElements } (paginated)
      // or { data: [...] } (wrapped) or direct array
      let projects: Types.ProjectSummary[];
      let totalCount: number | undefined;
      let apiPageNumber: number | undefined;
      let apiPageSize: number | undefined;

      if (Array.isArray(projectsResponse)) {
        // Direct array response (no pagination metadata)
        projects = projectsResponse;
        totalCount = projects.length;
      } else if (projectsResponse && typeof projectsResponse === 'object') {
        if ('content' in projectsResponse && Array.isArray((projectsResponse as any).content)) {
          // Paginated response: { content: [...], pageNumber, pageSize, numberOfElements, total }
          projects = (projectsResponse as any).content;
          apiPageNumber = (projectsResponse as any).pageNumber;
          apiPageSize = (projectsResponse as any).pageSize;
          // Use total if available (OpenL API), otherwise totalElements
          // Do NOT use numberOfElements as it's the current page size, not the global total
          const total = (projectsResponse as any).total;
          const totalElements = (projectsResponse as any).totalElements;
          if (total !== undefined && total !== null) {
            totalCount = total;
          } else if (totalElements !== undefined && totalElements !== null) {
            totalCount = totalElements;
          } else {
            // Total count unknown - let has_more logic rely on page cursor/size
            totalCount = undefined;
          }
        } else if ('data' in projectsResponse && Array.isArray((projectsResponse as any).data)) {
          // Wrapped response: { data: [...] }
          projects = (projectsResponse as any).data;
          totalCount = projects.length;
        } else {
          // Fallback: try to convert to array or use empty array
          projects = [];
          totalCount = 0;
        }
      } else {
        projects = [];
        totalCount = 0;
      }

      // Transform projects to include a flat projectId field for easier use.
      // projectId is an opaque backend value and must be passed through unchanged.
      const transformedProjects = projects.map((project) => {
        if (typeof project.id !== "string" || project.id.length === 0) {
          throw new McpError(
            ErrorCode.InternalError,
            "Invalid project ID returned by backend: expected non-empty string."
          );
        }

        return {
          ...project,
          projectId: project.id,
        };
      });

      // If API already paginated, use its pagination metadata
      // Otherwise apply client-side pagination
      let paginated;
      if (apiPageNumber !== undefined && apiPageSize !== undefined && totalCount !== undefined) {
        // API already paginated - use its metadata
        paginated = {
          data: transformedProjects,
          has_more: (apiPageNumber + 1) * apiPageSize < totalCount,
          next_offset: (apiPageNumber + 1) * apiPageSize < totalCount ? (apiPageNumber + 1) * apiPageSize : null,
          total_count: totalCount,
        };
      } else {
        // Apply client-side pagination
        paginated = paginateResults(transformedProjects, limit, offset);
      }

      // Use API pagination metadata if available, otherwise use client-side pagination values
      const paginationOffset = apiPageNumber !== undefined && apiPageSize !== undefined
        ? apiPageNumber * apiPageSize
        : offset;
      const paginationLimit = apiPageSize !== undefined
        ? apiPageSize
        : limit;

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit: paginationLimit,
          offset: paginationOffset,
          total: paginated.total_count,
        },
        dataType: "projects",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_project",
    title: "openl Get Project",
    version: "1.0.0",
    description:
      "Get comprehensive project information including details, modules, dependencies, and metadata. Returns full project structure, configuration, and status.",
    inputSchema: schemas.z.toJSONSchema(schemas.getProjectSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const project = await client.getProject(typedArgs.projectId);

      const formattedResult = formatResponse(project, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });


  registerTool({
    name: "openl_open_project",
    title: "openl Open Project",
    version: "1.0.0",
    description:
      "Open a project for editing. Supports opening on specific branches or viewing specific Git revisions. Use this before making changes to project tables or rules.",
    inputSchema: schemas.z.toJSONSchema(schemas.openProjectSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        branch?: string;
        revision?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      let action: "opened" | "switched_branch" = "opened";

      // If branch is specified, check whether the project is already opened.
      // If so, use switchBranch (PATCH without status) to avoid 409 Conflict.
      if (typedArgs.branch) {
        try {
          const project = await client.getProject(typedArgs.projectId);
          if (project.status === "OPENED" || project.status === "EDITING") {
            await client.switchBranch(typedArgs.projectId, typedArgs.branch);
            action = "switched_branch";
          } else {
            await client.openProject(typedArgs.projectId, {
              branch: typedArgs.branch,
              revision: typedArgs.revision,
            });
          }
        } catch {
          // If getProject fails, fall through to the default open logic
          await client.openProject(typedArgs.projectId, {
            branch: typedArgs.branch,
            revision: typedArgs.revision,
          });
        }
      } else {
        await client.openProject(typedArgs.projectId, {
          revision: typedArgs.revision,
        });
      }

      const message = action === "switched_branch"
        ? `Branch switched to '${typedArgs.branch}' successfully`
        : `Project opened successfully${typedArgs.branch ? ` on branch '${typedArgs.branch}'` : ""}${typedArgs.revision ? ` at revision '${typedArgs.revision}'` : ""}`;

      const result = {
        success: true,
        message,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_save_project",
    title: "openl Save Project",
    version: "1.0.0",
    description:
      "Save project changes to Git. Works only when project status is EDITING (after opening and making changes). Requires comment (used as revision/commit message). Creates a new revision and transitions project to OPENED. Optional closeAfterSave: true saves and closes in one request. Use after update_table, append_table, or other edits. Does not work for repository 'local'. Validates project before saving if validation endpoint is available.",
    inputSchema: schemas.z.toJSONSchema(schemas.saveProjectSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        comment: string;
        closeAfterSave?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }
      if (!typedArgs.comment?.trim()) {
        throw new McpError(ErrorCode.InvalidParams, "comment is required for save; it is used as the revision (commit) message.");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const result = await client.saveProject(typedArgs.projectId, typedArgs.comment, {
        closeAfterSave: typedArgs.closeAfterSave,
      });

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_close_project",
    title: "openl Close Project",
    version: "1.0.0",
    description:
      "Close a project. If the project has unsaved changes (status EDITING), you must either save (saveChanges: true with comment) or discard (discardChanges: true). When discarding, ask the user for confirmation and then call again with confirmDiscard: true. Prevents accidental data loss.",
    inputSchema: schemas.z.toJSONSchema(schemas.closeProjectSchema) as Record<string, unknown>,
    annotations: {
      destructiveHint: true, // Can discard changes if requested
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        saveChanges?: boolean;
        comment?: string;
        discardChanges?: boolean;
        confirmDiscard?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Check current project status to see if there are unsaved changes
      const currentProject = await client.getProject(typedArgs.projectId);
      const hasUnsavedChanges = currentProject.status === "EDITING";

      // Validate that both saveChanges and discardChanges are not set to true
      if (typedArgs.saveChanges === true && typedArgs.discardChanges === true) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Cannot set both saveChanges and discardChanges to true. Choose one option:\n" +
          "1. Set saveChanges: true (with comment) to save changes before closing\n" +
          "2. Set discardChanges: true to explicitly discard unsaved changes (destructive operation)"
        );
      }

      if (hasUnsavedChanges) {
        if (typedArgs.saveChanges === true) {
          // Save changes before closing
          if (!typedArgs.comment) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "comment is required when saveChanges is true. Provide a commit message describing the changes."
            );
          }
          const saveResult = await client.saveProject(typedArgs.projectId, typedArgs.comment);
          if (!saveResult.success) {
            const formattedResult = formatResponse(saveResult, format);
            return {
              content: [{ type: "text", text: formattedResult }],
            };
          }
          await client.closeProject(typedArgs.projectId);
          const result = {
            success: true,
            message: `Project saved and closed successfully with comment: "${typedArgs.comment}"`,
          };
          const formattedResult = formatResponse(result, format);
          return {
            content: [{ type: "text", text: formattedResult }],
          };
        } else if (typedArgs.discardChanges === true) {
          // Only proceed when confirmDiscard is explicitly true (false or undefined require confirmation)
          if (typedArgs.confirmDiscard === true) {
            await client.closeProject(typedArgs.projectId);
            const result = {
              success: true,
              message: "Project closed (unsaved changes discarded)",
            };
            const formattedResult = formatResponse(result, format);
            return {
              content: [{ type: "text", text: formattedResult }],
            };
          }
          // confirmDiscard not set to true: require explicit user confirmation
          const result = {
            success: false,
            confirmationRequired: true,
            message: "The project has unsaved changes. Closing without saving will discard all changes permanently. Ask the user: 'Do you really want to close without saving? All unsaved changes will be lost.' If the user confirms, call openl_close_project again with the same projectId, discardChanges: true, and confirmDiscard: true (confirmDiscard must be set to true explicitly, not just provided).",
          };
          const formattedResult = formatResponse(result, format);
          return {
            content: [{ type: "text", text: formattedResult }],
          };
        } else {
          // Error: must choose to save or discard
          throw new McpError(
            ErrorCode.InvalidParams,
            "Project has unsaved changes. You must either:\n" +
            "1. Set saveChanges: true (with comment) to save and close\n" +
            "2. Set discardChanges: true to close without saving (then ask user to confirm and call again with confirmDiscard: true)"
          );
        }
      } else {
        // No unsaved changes, safe to close
        await client.closeProject(typedArgs.projectId);
        const result = {
          success: true,
          message: "Project closed successfully",
        };
        const formattedResult = formatResponse(result, format);
        return {
          content: [{ type: "text", text: formattedResult }],
        };
      }
    },
  });

  // =============================================================================
  // File Management Tools
  // =============================================================================

  // TEMPORARILY DISABLED - openl_upload_file
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_upload_file",
    title: "openl Upload File",
    version: "1.0.0",
    description:
      "Upload an Excel file (.xlsx or .xls) containing rules to a project. The file is uploaded to OpenL Studio workspace but NOT committed to Git yet.",
    inputSchema: schemas.z.toJSONSchema(schemas.uploadFileSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        fileName: string;
        localFilePath: string;
        comment?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.fileName || !typedArgs.localFilePath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, fileName, localFilePath"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const sourceFilePath = resolve(typedArgs.localFilePath);
      const buffer = await readFile(sourceFilePath);

      const result = await client.uploadFile(typedArgs.projectId, typedArgs.fileName, buffer, typedArgs.comment);

      const formattedResult = formatResponse({
        ...result,
        sourceFilePath,
        mode: "binary-file-path",
      }, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
  */

  // TEMPORARILY DISABLED - openl_download_file
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_download_file",
    title: "openl Download File",
    version: "1.0.0",
    description:
      "Download an Excel file from OpenL project. Can download latest version (HEAD) or specific historical version using Git commit hash.",
    inputSchema: schemas.z.toJSONSchema(schemas.downloadFileSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        fileName: string;
        version?: string;
        outputFilePath: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.fileName || !typedArgs.outputFilePath) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, fileName, outputFilePath");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const fileBuffer = await client.downloadFile(typedArgs.projectId, typedArgs.fileName, typedArgs.version);
      const outputFilePath = resolve(typedArgs.outputFilePath);
      await writeFile(outputFilePath, fileBuffer);

      const result = {
        fileName: typedArgs.fileName,
        outputFilePath,
        size: fileBuffer.length,
        version: typedArgs.version || "HEAD",
        mode: "binary-file-path",
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
  */

  // =============================================================================
  // Rules (Tables) Tools
  // =============================================================================

  registerTool({
    name: "openl_list_tables",
    title: "openl List Tables",
    version: "1.0.0",
    description: "List all tables/rules in a project with optional filters for type, name, and file. Returns table metadata including 'tableId' (the 'id' field) which is required for calling get_table(), update_table(), append_table(), or run_project_tests(). Use the 'tableId' field from the response to reference specific tables in other API calls.",
    inputSchema: schemas.z.toJSONSchema(schemas.listTablesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        kind?: string[];
        name?: string;
        properties?: Record<string, string>;
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs.limit, typedArgs.offset);

      const filters: Types.TableFilters = {};
      if (typedArgs.kind && typedArgs.kind.length > 0) {
        filters.kind = typedArgs.kind;
      }
      if (typedArgs.name) filters.name = typedArgs.name;
      if (typedArgs.properties) filters.properties = typedArgs.properties;
      
      // Add pagination parameters (convert offset/limit to page/size for API)
      if (offset !== undefined && limit !== undefined) {
        filters.offset = offset;
        filters.limit = limit;
      }

      const tablesResponse = await client.listTables(typedArgs.projectId, filters);

      // Handle case when API returns PageResponse instead of array
      // API now returns { content: [...], pageNumber, pageSize, numberOfElements, total }
      let tables: Types.TableMetadata[];
      let totalCount: number | undefined;
      let apiPageNumber: number | undefined;
      let apiPageSize: number | undefined;

      if (Array.isArray(tablesResponse)) {
        // Direct array response (backward compatibility, no pagination metadata)
        tables = tablesResponse;
        totalCount = tables.length;
      } else if (tablesResponse && typeof tablesResponse === 'object' && 'content' in tablesResponse && Array.isArray((tablesResponse as any).content)) {
        // PageResponse format: { content: [...], pageNumber, pageSize, numberOfElements, total }
        tables = (tablesResponse as any).content;
        apiPageNumber = (tablesResponse as any).pageNumber;
        apiPageSize = (tablesResponse as any).pageSize;
        // Use total if available (OpenL API), otherwise totalElements
        // Do NOT use numberOfElements as it's the current page size, not the global total
        const total = (tablesResponse as any).total;
        const totalElements = (tablesResponse as any).totalElements;
        if (total !== undefined && total !== null) {
          totalCount = total;
        } else if (totalElements !== undefined && totalElements !== null) {
          totalCount = totalElements;
        } else {
          // Total count unknown - let has_more logic rely on page cursor/size
          totalCount = undefined;
        }
      } else {
        // Fallback: empty array
        tables = [];
        totalCount = 0;
      }

      // If API already paginated, use its pagination metadata
      // Otherwise apply client-side pagination
      let paginated;
      if (apiPageNumber !== undefined && apiPageSize !== undefined && totalCount !== undefined) {
        // API already paginated - use its metadata
        paginated = {
          data: tables,
          has_more: (apiPageNumber + 1) * apiPageSize < totalCount,
          next_offset: (apiPageNumber + 1) * apiPageSize < totalCount ? (apiPageNumber + 1) * apiPageSize : null,
          total_count: totalCount,
        };
      } else {
        // Apply client-side pagination
        paginated = paginateResults(tables, limit, offset);
      }

      // Use API pagination metadata if available, otherwise use client-side pagination values
      const paginationOffset = apiPageNumber !== undefined && apiPageSize !== undefined
        ? apiPageNumber * apiPageSize
        : offset;
      const paginationLimit = apiPageSize !== undefined
        ? apiPageSize
        : limit;

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit: paginationLimit,
          offset: paginationOffset,
          total: paginated.total_count,
        },
        dataType: "tables",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_table",
    title: "openl Get Table",
    version: "1.0.0",
    description:
      "Get detailed information about a specific table/rule. Returns table structure, signature, conditions, actions, dimension properties, and all row data.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTableSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId. Use openl_list_tables() to find valid table IDs");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const table = await client.getTable(typedArgs.projectId, typedArgs.tableId);

      const formattedResult = formatResponse(table, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_update_table",
    title: "openl Update Table",
    version: "1.0.0",
    description:
      "Replace the ENTIRE table structure with a modified version. Use for MODIFYING existing rows, DELETING rows, REORDERING rows, or STRUCTURAL changes. CRITICAL: Must send the FULL table structure (not just modified fields). DO NOT use for simple additions - use append_table instead. Required workflow: 1) Call get_table() to retrieve complete structure, 2) Modify the returned object, 3) Pass the ENTIRE modified object to update_table().",
    inputSchema: schemas.z.toJSONSchema(schemas.updateTableSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        view: Types.EditableTableView;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId || !typedArgs.view) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId, view");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      await client.updateTable(typedArgs.projectId, typedArgs.tableId, typedArgs.view);

      const result = {
        success: true,
        message: `Successfully updated table ${typedArgs.tableId}`,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_append_table",
    title: "openl Append Table",
    version: "1.0.0",
    description:
      "Append new rows/fields to an existing table WITHOUT replacing the entire structure. Use for ADDING rows/fields ONLY - does not modify existing data. Examples: Adding 1 row → use append_table. Adding multiple rows → use append_table. More efficient than update_table for simple additions. Only requires the NEW data to append, not the full table structure. For modifications, deletions, or reordering → use update_table instead.",
    inputSchema: schemas.z.toJSONSchema(schemas.appendTableSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        appendData: {
          tableType: string;
          fields?: Array<{ name: string; type: string; required?: boolean; defaultValue?: any }>;
          rules?: Array<Record<string, any>>;
          steps?: Array<any>;
          values?: Array<any>;
        };
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId || !typedArgs.appendData) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId, appendData");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert to AppendTableView format expected by client
      const appendData: Types.AppendTableView = typedArgs.appendData as any;

      await client.appendProjectTable(typedArgs.projectId, typedArgs.tableId, appendData);

      // Generate appropriate success message based on table type
      let itemCount = 0;
      let itemType = "items";
      if (typedArgs.appendData.fields) {
        itemCount = typedArgs.appendData.fields.length;
        itemType = "field(s)";
      } else if (typedArgs.appendData.rules) {
        itemCount = typedArgs.appendData.rules.length;
        itemType = "rule(s)";
      } else if (typedArgs.appendData.steps) {
        itemCount = typedArgs.appendData.steps.length;
        itemType = "step(s)";
      } else if (typedArgs.appendData.values) {
        itemCount = typedArgs.appendData.values.length;
        itemType = "value(s)";
      }

      const result = {
        success: true,
        message: `Successfully appended ${itemCount} ${itemType} to table ${typedArgs.tableId}`,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_create_project_table",
    title: "openl Create Project Table",
    version: "1.0.0",
    description:
      "Create a new table/rule in OpenL project using BETA API (Create New Project Table). This is the recommended tool for creating new OpenL tables programmatically. Use cases: Create Rules (decision tables), Spreadsheet tables, Datatype definitions, Test tables, or other table types. Requires moduleName (existing project module name) and complete table structure (EditableTableView). The table structure must include at least tableType, kind, name, plus type-specific data (rules/headers for Rules tables, rows for Spreadsheet, fields for Datatype). id is optional for create requests. Use get_table() on an existing table as a reference for the structure. This tool uses the Create New Project Table (BETA) API endpoint.",
    inputSchema: schemas.z.toJSONSchema(schemas.createProjectTableSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        moduleName: string;
        sheetName?: string;
        table: Types.EditableTableView;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.moduleName || !typedArgs.table) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, moduleName, table"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const createdTable = await client.createProjectTable(typedArgs.projectId, {
        moduleName: typedArgs.moduleName,
        sheetName: typedArgs.sheetName,
        table: typedArgs.table,
      });

      const result = {
        success: true,
        tableId: createdTable.id,
        tableName: createdTable.name,
        tableType: createdTable.tableType,
        file: createdTable.file,
        message: `Successfully created ${createdTable.tableType} table '${createdTable.name}' in module '${typedArgs.moduleName}'`,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Deployment Tools
  // =============================================================================

  registerTool({
    name: "openl_list_deployments",
    title: "openl List Deployments",
    version: "1.0.0",
    description:
      "List all active deployments across production environments. Returns deployment names, repositories, versions, and status information.",
    inputSchema: schemas.z.toJSONSchema(
      schemas.z
        .object({
          response_format: schemas.ResponseFormat.optional(),
          limit: schemas.z.number().int().positive().max(200).default(50).optional(),
          offset: schemas.z.number().int().nonnegative().default(0).optional(),
        })
        .strict()
    ) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      } | undefined;

      const format = validateResponseFormat(typedArgs && typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs && typedArgs.limit, typedArgs && typedArgs.offset);

      const deployments = await client.listDeployments();

      // Apply pagination
      const paginated = paginateResults(deployments, limit, offset);

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit,
          offset,
          total: paginated.total_count,
        },
        dataType: "deployments",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_deploy_project",
    title: "openl Deploy Project",
    version: "1.0.0",
    description:
      "Deploy a project to production environment. Publishes rules to a deployment repository for runtime execution. Use production repository name (not ID) - e.g., 'Production Deployment' instead of 'production-deploy'.",
    inputSchema: schemas.z.toJSONSchema(schemas.deployProjectSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        deploymentName: string;
        productionRepositoryId: string;
        comment?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.deploymentName || !typedArgs.productionRepositoryId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, deploymentName, productionRepositoryId"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert production repository name to ID for API call
      const productionRepositoryId = await client.getProductionRepositoryIdByName(typedArgs.productionRepositoryId);

      await client.deployProject({
        projectId: typedArgs.projectId,
        deploymentName: typedArgs.deploymentName,
        productionRepositoryId: productionRepositoryId,
        comment: typedArgs.comment,
      });

      const result = {
        success: true,
        message: `Successfully deployed ${typedArgs.deploymentName} to ${typedArgs.productionRepositoryId}`,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Execution Tools
  // =============================================================================

  // TEMPORARILY DISABLED - openl_execute_rule
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_execute_rule",
    title: "openl Execute Rule",
    version: "1.0.0",
    description:
      "Execute a rule with input data to test its behavior and validate changes. Runs the rule with provided parameters and returns calculated result.",
    inputSchema: schemas.z.toJSONSchema(schemas.executeRuleSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        ruleName: string;
        inputData: Record<string, unknown>;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.ruleName || !typedArgs.inputData) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, ruleName, inputData");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const result = await client.executeRule({
        projectId: typedArgs.projectId,
        ruleName: typedArgs.ruleName,
        inputData: typedArgs.inputData,
      });

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
  */

  // =============================================================================
  // Version Control Tools
  // =============================================================================

  // TEMPORARILY DISABLED - openl_revert_version
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_revert_version",
    title: "openl Revert Version",
    version: "1.0.0",
    description:
      "Revert project to a previous Git commit using commit hash. Creates a new commit that restores old content while preserving full history.",
    inputSchema: schemas.z.toJSONSchema(schemas.revertVersionSchema) as Record<string, unknown>,
    annotations: {
      destructiveHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        targetVersion: string;
        comment?: string;
        confirm?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.targetVersion) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, targetVersion");
      }

      // Destructive operation: require confirmation
      if (typedArgs.confirm !== true) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `This operation will revert project "${typedArgs.projectId}" to version "${typedArgs.targetVersion}", ` +
          `which is a destructive action that creates a new commit with the old state. ` +
          `To proceed, set confirm: true in your request. ` +
          `To review the target version first, use: openl_get_project_history(projectId: "${typedArgs.projectId}")`
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const result = await client.revertVersion({
        projectId: typedArgs.projectId,
        targetVersion: typedArgs.targetVersion,
        comment: typedArgs.comment,
      });

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
  */

  // TEMPORARILY DISABLED - openl_get_file_history
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_get_file_history",
    title: "openl get file history",
    version: "1.0.0",
    description:
      "Get Git commit history for a specific file. Returns list of commits with hashes, authors, timestamps, and commit types.",
    inputSchema: schemas.z.toJSONSchema(schemas.getFileHistorySchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        filePath: string;
        limit?: number;
        offset?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.filePath) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, filePath");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const result = await client.getFileHistory({
        projectId: typedArgs.projectId,
        filePath: typedArgs.filePath,
        limit: typedArgs.limit,
        offset: typedArgs.offset,
      });

      const formattedResult = formatResponse(result, format, {
        dataType: "history",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
  */

  // TEMPORARILY DISABLED - openl_get_project_history
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_get_project_history",
    title: "openl get project history",
    version: "1.0.0",
    description:
      "Get Git commit history for entire project. Returns chronological list of all commits with metadata about files and tables changed.",
    inputSchema: schemas.z.toJSONSchema(schemas.getProjectHistorySchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        limit?: number;
        offset?: number;
        branch?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert limit/offset to page/size for API compatibility
      const page = typedArgs.offset ? Math.floor(typedArgs.offset / (typedArgs.limit || 50)) : undefined;
      const size = typedArgs.limit;

      const result = await client.getProjectHistory({
        projectId: typedArgs.projectId,
        page,
        size,
        branch: typedArgs.branch,
      });

      const formattedResult = formatResponse(result, format, {
        dataType: "history",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
  */

  // =============================================================================
  // Repository Features & Revisions Tools
  // =============================================================================

  registerTool({
    name: "openl_list_repository_features",
    title: "openl List Design Repository Features",
    version: "1.0.0",
    description:
      "Get features supported by a design repository (branching, searchable, etc.). Use this to check if a repository supports specific features like branching before performing operations that depend on those features. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'.",
    inputSchema: schemas.z.toJSONSchema(schemas.getRepositoryFeaturesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        repository: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.repository) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: repository. To find valid repositories, use: openl_list_repositories()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert repository name to ID for API call
      const repositoryId = await client.getRepositoryIdByName(typedArgs.repository);
      const features = await client.getRepositoryFeatures(repositoryId);

      const formattedResult = formatResponse(features, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_repository_project_revisions",
    title: "Openl List Design Repository Project Revisions",
    version: "1.0.0",
    description:
      "Get revision history (commit history) of a project in a design repository. Returns list of revisions with commit hashes, authors, timestamps, and commit types. Supports pagination and filtering by branch and search term. Use repository name (not ID) - e.g., 'Design Repository' instead of 'design-repo'.",
    inputSchema: schemas.z.toJSONSchema(schemas.getProjectRevisionsSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        repository: string;
        projectName: string;
        branch?: string;
        search?: string;
        techRevs?: boolean;
        page?: number;
        size?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.repository || !typedArgs.projectName) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: repository, projectName"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert repository name to ID for API call
      const repositoryId = await client.getRepositoryIdByName(typedArgs.repository);
      const revisions = await client.getProjectRevisions(repositoryId, typedArgs.projectName, {
        branch: typedArgs.branch,
        search: typedArgs.search,
        techRevs: typedArgs.techRevs,
        page: typedArgs.page,
        size: typedArgs.size,
      });

      const formattedResult = formatResponse(revisions, format, {
        pagination: {
          limit: revisions.pageSize,
          offset: revisions.pageNumber * revisions.pageSize,
          total: revisions.totalElements || revisions.numberOfElements,
        },
        dataType: "revisions",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_list_deploy_repositories",
    title: "openl List Deploy Repositories",
    version: "1.0.0",
    description:
      "List all deployment repositories in OpenL Studio. Returns repository names, their types, and status information. Use this to discover all available deployment repositories before deploying projects.",
    inputSchema: schemas.z.toJSONSchema(schemas.listDeployRepositoriesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      } | undefined;

      const format = validateResponseFormat(typedArgs && typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs && typedArgs.limit, typedArgs && typedArgs.offset);

      const repositories = await client.listDeployRepositories();

      // Apply pagination
      const paginated = paginateResults(repositories, limit, offset);

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit,
          offset,
          total: paginated.total_count,
        },
        dataType: "deploy_repositories",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Branch Creation Tool
  // =============================================================================

  registerTool({
    name: "openl_create_project_branch",
    title: "openl Create Project Branch",
    version: "1.0.0",
    description:
      "Create a new branch in a project's repository from a specified revision. Allows branching from specific revisions, tags, or other branches. If no revision is specified, the HEAD revision will be used.",
    inputSchema: schemas.z.toJSONSchema(schemas.createBranchSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        branchName: string;
        revision?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.branchName) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, branchName"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      await client.createBranch(typedArgs.projectId, typedArgs.branchName, typedArgs.revision);

      const result = {
        success: true,
        message: `Successfully created branch '${typedArgs.branchName}'${typedArgs.revision ? ` from revision ${typedArgs.revision}` : ""}`,
        branchName: typedArgs.branchName,
        revision: typedArgs.revision,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Local Changes & Restore Tools
  // =============================================================================

  registerTool({
    name: "openl_list_project_local_changes",
    title: "openl List Project Local Changes",
    version: "1.0.0",
    description:
      "List local change history for a project. Returns list of workspace history items with versions, authors, timestamps, and comments. NOTE: Requires the project to be opened (openl_open_project first); not available for repository 'local' (local projects cannot be opened). Uses session-based project context; no projectId parameter.",
    inputSchema: schemas.z.toJSONSchema(schemas.listProjectLocalChangesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        response_format?: "json" | "markdown";
      };

      const format = validateResponseFormat(typedArgs?.response_format);

      // Note: This endpoint requires project to be loaded in OpenL Studio session.
      // The endpoint `/history/project` uses session-based project context.
      const changes = await client.getProjectLocalChanges();

      const formattedResult = formatResponse(changes, format, {
        dataType: "local_changes",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_restore_project_local_change",
    title: "openl Restore Project Local Change",
    version: "1.0.0",
    description:
      "Restore a project to a specified version from its local history. Use the historyId from openl_list_project_local_changes response. NOTE: Requires the project to be opened first; not available for repository 'local'. Uses session-based project context; no projectId parameter.",
    inputSchema: schemas.z.toJSONSchema(schemas.restoreProjectLocalChangeSchema) as Record<string, unknown>,
    annotations: {
      destructiveHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        historyId: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.historyId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: historyId. Use openl_list_project_local_changes() to find valid history IDs."
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Note: This endpoint requires project to be loaded in OpenL Studio session.
      // The endpoint `/history/restore` uses session-based project context.
      await client.restoreProjectLocalChange(typedArgs.historyId);

      const result = {
        success: true,
        message: `Successfully restored project to history version '${typedArgs.historyId}'`,
        historyId: typedArgs.historyId,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Test Execution Tools
  // =============================================================================

  registerTool({
    name: "openl_start_project_tests",
    title: "openl Start Project Tests",
    version: "1.0.0",
    description:
      "Start project test execution. For design repositories the project is automatically opened if closed; for repository 'local' the project is not opened (tests run directly). Returns execution status and metadata. Test results can be retrieved using openl_get_test_results_summary, openl_get_test_results, or openl_get_test_results_by_table.",
    inputSchema: schemas.z.toJSONSchema(schemas.startProjectTestsSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId?: string;
        testRanges?: string;
        fromModule?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const result = await client.startProjectTests(typedArgs.projectId, {
        tableId: typedArgs.tableId,
        testRanges: typedArgs.testRanges,
        fromModule: typedArgs.fromModule, // Reserved for future use
      });

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_test_results_summary",
    title: "openl Get Test Results Summary",
    version: "1.0.0",
    description:
      "Get brief test execution summary without detailed test cases. Returns aggregated statistics (execution time, total tests, passed, failed) without the testCases array. Use openl_start_project_tests() first to start test execution.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTestResultsSummarySchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        failures?: number;
        unpaged?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const summary = await client.getTestResultsSummary(typedArgs.projectId, {
        failures: typedArgs.failures,
        unpaged: typedArgs.unpaged,
      });

      const formattedResult = formatResponse(summary, format, {
        dataType: "test_results_summary",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_test_results",
    title: "openl Get Test Results",
    version: "1.0.0",
    description:
      "Get full test execution results with pagination support. Returns complete test execution summary including testCases array grouped by table. IMPORTANT: Pagination applies to test tables (not individual test cases). Each page returns test results aggregated by table (e.g., 'TestTable1' with 7 tests, 'TestTable2' with 8 tests). Supports filtering failures and pagination (page/offset/size). Use openl_start_project_tests() first to start test execution.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTestResultsSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        failuresOnly?: boolean;
        failures?: number;
        page?: number;
        offset?: number;
        size?: number;
        limit?: number;
        unpaged?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const results = await client.getTestResults(typedArgs.projectId, {
        failuresOnly: typedArgs.failuresOnly,
        failures: typedArgs.failures,
        page: typedArgs.page,
        offset: typedArgs.offset,
        size: typedArgs.size,
        limit: typedArgs.limit,
        unpaged: typedArgs.unpaged,
      });

      const pageSize = results.pageSize || typedArgs.size || typedArgs.limit || 50;
      const formattedResult = formatResponse(results, format, {
        pagination: {
          limit: pageSize,
          offset: (results.pageNumber || 0) * pageSize,
          total: results.numberOfTests,
        },
        dataType: "test_results",
        skipTruncation: true,
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_test_results_by_table",
    title: "openl Get Test Results By Table",
    version: "1.0.0",
    description:
      "Get test execution results filtered by specific table ID. Returns filtered test execution summary with only test cases for the specified table. Supports pagination (page/offset/size) for efficient data retrieval. Use openl_start_project_tests() first to start test execution.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTestResultsByTableSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        failuresOnly?: boolean;
        failures?: number;
        page?: number;
        offset?: number;
        size?: number;
        limit?: number;
        unpaged?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, tableId. To find valid project IDs, use: openl_list_projects(). To find valid table IDs, use: openl_list_tables()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const results = await client.getTestResultsByTable(typedArgs.projectId, typedArgs.tableId, {
        failuresOnly: typedArgs.failuresOnly,
        failures: typedArgs.failures,
        page: typedArgs.page,
        offset: typedArgs.offset,
        size: typedArgs.size,
        limit: typedArgs.limit,
        unpaged: typedArgs.unpaged,
      });

      const formattedResult = formatResponse(results, format, {
        dataType: "test_results",
        skipTruncation: true,
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  // =============================================================================
  // Redeploy Tool
  // =============================================================================

  registerTool({
    name: "openl_redeploy_project",
    title: "openl Redeploy Project",
    version: "1.0.0",
    description:
      "Redeploy an existing deployment with a new project version. Use this to update a deployment with a newer version of the project or rollback to a previous version.",
    inputSchema: schemas.z.toJSONSchema(schemas.redeployProjectSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        deploymentId: string;
        projectId: string;
        comment?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.deploymentId || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: deploymentId, projectId. Use openl_list_deployments() to find valid deployment IDs."
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      await client.redeployProject(typedArgs.deploymentId, {
        projectId: typedArgs.projectId,
        comment: typedArgs.comment,
      });

      const result = {
        success: true,
        message: `Successfully redeployed ${typedArgs.deploymentId} with project ${typedArgs.projectId}`,
        deploymentId: typedArgs.deploymentId,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
}

/**
 * Handle tool execution errors with enhanced context
 *
 * @param error - Error to handle
 * @param toolName - Name of the tool that failed
 * @param toolArgs - Tool arguments that were passed (will be sanitized)
 * @returns McpError with enhanced context
 */
function handleToolError(error: unknown, toolName: string, toolArgs?: unknown): McpError {
  // Enhanced error handling with context
  if (isAxiosError(error)) {
    const status = error.response?.status;
    const responseData = error.response?.data;
    const endpoint = error.config?.url;
    const method = error.config?.method ? error.config.method.toUpperCase() : undefined;
    const requestParams = error.config?.params; // Query parameters for GET requests
    const requestData = error.config?.data; // Request body for POST/PUT requests
    const axiosCode = error.code; // e.g. ECONNREFUSED, ETIMEDOUT, ENOTFOUND (network errors when no response)

    // Extract structured error information from API response
    const apiErrorInfo = extractApiErrorInfo(responseData, status);

    // Build error message with priority:
    // 1. API error message (if available)
    // 2. Field errors (for 400)
    // 3. Generic errors array (for 400)
    // 4. For network errors (no response): use code + message so we don't get just "Error"
    // 5. Fallback to sanitized axios error message
    let errorMessage = "";
    const errorDetails: Record<string, unknown> = {
      status,
      endpoint,
      method,
      tool: toolName,
    };
    if (axiosCode) {
      errorDetails.code = axiosCode;
    }

    // Add tool arguments (sanitized to prevent sensitive data exposure)
    if (toolArgs !== undefined) {
      errorDetails.toolArgs = sanitizeJson(toolArgs);
    }

    // Add request parameters (query params for GET requests)
    if (requestParams !== undefined && Object.keys(requestParams).length > 0) {
      errorDetails.requestParams = sanitizeJson(requestParams);
    }

    // Add request data (body for POST/PUT requests, sanitized)
    if (requestData !== undefined) {
      // Try to parse JSON if it's a string
      let parsedData = requestData;
      if (typeof requestData === "string") {
        try {
          parsedData = JSON.parse(requestData);
        } catch {
          // If parsing fails, use original string (will be sanitized as string)
          parsedData = requestData;
        }
      }
      errorDetails.requestData = sanitizeJson(parsedData);
    }

    // Add structured error information to details
    if (apiErrorInfo.code) {
      errorDetails.apiErrorCode = apiErrorInfo.code;
    }
    if (apiErrorInfo.message) {
      errorMessage = apiErrorInfo.message;
    }
    if (apiErrorInfo.errors && apiErrorInfo.errors.length > 0) {
      errorDetails.errors = apiErrorInfo.errors;
      if (!errorMessage && apiErrorInfo.errors[0]?.message) {
        errorMessage = apiErrorInfo.errors[0].message;
      }
    }
    if (apiErrorInfo.fields && apiErrorInfo.fields.length > 0) {
      errorDetails.fields = apiErrorInfo.fields;
      // Build field error message if no main message
      if (!errorMessage && apiErrorInfo.fields.length > 0) {
        const fieldMessages = apiErrorInfo.fields
          .map((f) => f.field && f.message ? `${f.field}: ${f.message}` : f.message)
          .filter(Boolean);
        if (fieldMessages.length > 0) {
          errorMessage = fieldMessages.join("; ");
        }
      }
    }
    if (apiErrorInfo.rawResponse && !apiErrorInfo.code && !apiErrorInfo.message) {
      // Unknown format - include raw response in details
      errorDetails.rawResponse = apiErrorInfo.rawResponse;
    }

    // Fallback to sanitized axios error message if no API message
    if (!errorMessage) {
      const sanitized = sanitizeError(error);
      // For network errors (axiosCode set, no response), always include code so the cause is visible
      errorMessage = axiosCode ? `${axiosCode}: ${sanitized}` : sanitized;
    }

    // Build final error message
    let finalMessage = `OpenL Studio API error`;
    if (status) {
      finalMessage += ` (${status})`;
    }
    finalMessage += `: ${errorMessage}`;
    if (method && endpoint) {
      finalMessage += ` [${method} ${endpoint}]`;
    }

    // Log one-line summary first (status or network code + message) so it's visible at a glance in VS Code/Copilot output
    const summary =
      status != null
        ? `${toolName} (${status}) ${errorMessage}`
        : axiosCode
          ? `${toolName} [${axiosCode}] ${errorMessage}`
          : `${toolName} ${errorMessage}`;
    logger.error(`Tool error: ${summary}`, errorDetails);

    // Use appropriate error code based on status
    let errorCode = ErrorCode.InternalError;
    if (status === 400) {
      errorCode = ErrorCode.InvalidParams;
    } else if (status === 401 || status === 403) {
      errorCode = ErrorCode.InvalidRequest; // MCP doesn't have specific auth error code
    } else if (status === 404) {
      errorCode = ErrorCode.InvalidParams;
    } else if (status === 405) {
      errorCode = ErrorCode.MethodNotFound;
    }

    throw new McpError(
      errorCode,
      finalMessage,
      errorDetails
    );
  }

  // Re-throw McpErrors as-is
  if (error instanceof McpError) {
    throw error;
  }

  // Wrap other errors with sanitization
  const sanitizedMessage = sanitizeError(error);
  const errorDetails: Record<string, unknown> = {
    tool: toolName,
    error: sanitizedMessage,
  };

  // Add tool arguments (sanitized to prevent sensitive data exposure)
  if (toolArgs !== undefined) {
    errorDetails.toolArgs = sanitizeJson(toolArgs);
  }

  logger.error(`Tool error: ${toolName} ${sanitizedMessage}`, errorDetails);

  throw new McpError(
    ErrorCode.InternalError,
    `Error executing ${toolName}: ${sanitizedMessage}`,
    errorDetails
  );
}
