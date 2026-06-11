/**
 * Tool Handlers for OpenL MCP Server
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
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { OpenLClient } from "./client.js";
import * as schemas from "./schemas.js";
import { formatResponse, paginateResults } from "./formatters.js";
import { validateResponseFormat, validatePagination } from "./validators.js";
import { logger } from "./logger.js";
import { isAxiosError, sanitizeError, extractApiErrorInfo, sanitizeJson, setRulesXmlProjectName } from "./utils.js";
import {
  waitForCompilation,
  executeTraceReadWithWait,
  TraceExecutionFailedError,
  TraceWaitTimeoutError,
  TraceWaitUnavailableError,
  MAX_TRACE_WAIT_TIMEOUT_MS,
} from "./stomp-waits.js";
import { getProjectTemplateZip } from "./project-templates.js";
import { RESPONSE_LIMITS } from "./constants.js";
import type * as Types from "./types.js";

/**
 * Tool response structure
 */
interface ToolResponse {
  content: Array<{ type: string; text: string }>;
}

/**
 * Per-request context the MCP SDK passes to request handlers. Carries the optional
 * `progressToken` (under `_meta`), a `sendNotification` callback bound to the calling
 * session's transport, and an `AbortSignal` that fires when the client cancels.
 */
export type ToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Tool handler function type
 */
type ToolHandler = (
  args: unknown,
  client: OpenLClient,
  extra?: ToolHandlerExtra,
) => Promise<ToolResponse>;

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
  client: OpenLClient,
  extra?: ToolHandlerExtra,
): Promise<ToolResponse> {
  const tool = toolHandlers.get(name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  try {
    return await tool.handler(args, client, extra);
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
    title: "List Design Repositories",
    version: "1.0.0",
    description:
      "List all design repositories in OpenL Studio. Returns repository information including 'id' (internal identifier) and 'name' (display name). Use the 'name' field when working with repositories in other tools. Either the 'id' or 'name' is accepted by other tools (case-insensitive). The actual values are usually short tokens like 'design' — never invent values such as 'Design Repository' or 'design-repo'.",
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
    title: "List Git Branches",
    version: "1.0.0",
    description:
      "List all Git branches in a repository. Returns branch names and metadata (current branch, commit info). Use this to see available branches before switching or comparing versions. Pass either the id or name from openl_list_repositories() — both are accepted (case-insensitive). Do not invent example values; call openl_list_repositories() first if not in context.",
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
    title: "List Projects",
    version: "1.0.0",
    description:
      "List all projects with optional filters (repository, status, tags). Returns project names, status (OPENED/CLOSED), metadata, and a convenient 'projectId' field from API to use with other tools. For local-only projects, do not pass repository filter 'local' (it may fail); list projects without that filter and filter results by repository === 'local' client-side. For such projects, open/save/close do not work; table/rule/test tools work without opening. IMPORTANT: The 'projectId' is returned exactly as provided by the API and should be used without modification. Pass either the id or name from openl_list_repositories() — both are accepted (case-insensitive). Do not invent example values; call openl_list_repositories() first if not in context. Use this to discover and filter projects.",
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
    title: "Get Project Details",
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
    name: "openl_project_status",
    title: "Get Project Status",
    version: "1.0.0",
    description:
      "Get the post-compilation status of a project: compile state, diagnostics, pending changes, and module/test summary. Read-only — does not trigger compilation. When wait=true, blocks until compileState is terminal (ok/warnings/errors) and emits MCP progress notifications. Note: compileState reflects the last compilation. The studio does not auto-compile on edit (it resets the status), but openl_update_table / openl_append_table / openl_create_project_table all trigger a recompile of the affected table, so this status reflects changes made through those tools. (Edits made by bypassing those tools — e.g. raw REST — won't refresh it until the table is read.)",
    inputSchema: schemas.z.toJSONSchema(schemas.projectStatusSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        branch?: string;
        wait?: boolean;
        timeoutMs?: number;
        severity?: ("ERROR" | "WARN" | "INFO")[];
        maxMessages?: number;
        response_format?: "json" | "markdown" | "markdown_concise" | "markdown_detailed";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      let status: Types.ProjectStatusView;
      if (typedArgs.wait) {
        const progressToken = extra?._meta?.progressToken;
        const sendNotification = extra?.sendNotification;
        const onProgress =
          progressToken !== undefined && sendNotification
            ? (snap: Types.ProjectStatusView) => {
                // Notification failures are non-fatal — the wait still resolves on the
                // next terminal STOMP frame regardless of whether the client received
                // the progress update.
                const params: {
                  progressToken: string | number;
                  progress: number;
                  total?: number;
                  message?: string;
                } = {
                  progressToken,
                  progress: snap.compilation?.modules?.compiled ?? 0,
                  message: progressMessage(snap),
                };
                const total = snap.compilation?.modules?.total;
                if (typeof total === "number" && total > 0) {
                  params.total = total;
                }
                void sendNotification({
                  method: "notifications/progress",
                  params,
                }).catch(() => { /* ignore */ });
              }
            : undefined;
        status = await waitForCompilation(client, typedArgs.projectId, typedArgs.branch, {
          onProgress,
          signal: extra?.signal,
          timeoutMs: typedArgs.timeoutMs,
        });
      } else {
        status = await client.getProjectStatus(typedArgs.projectId, typedArgs.branch);
      }

      const payload = shapeStatusResponse(status, typedArgs.severity, typedArgs.maxMessages);

      return {
        content: [{ type: "text", text: formatResponse(payload, format) }],
      };
    },
  });


  registerTool({
    name: "openl_open_project",
    title: "Open Project for Editing",
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
    title: "Save Project to Git",
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
    title: "Close Project",
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
    title: "Upload File",
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
    title: "Download File",
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
  // Project Files (BETA) Tools
  // =============================================================================

  registerTool({
    name: "openl_read_project_file",
    title: "Read Project File",
    version: "1.0.0",
    description:
      "Read any file in a project by its project-relative path — text or binary, and folder listings too. Maps to GET /projects/{projectId}/files/{path}. Behavior by path/params: " +
      "(1) a FILE path returns its content — UTF-8 text is returned verbatim, binary is returned base64-encoded with metadata (use encoding to force 'utf-8' or 'base64'; default 'auto' detects); " +
      "(2) a FILE path with view='meta' returns JSON metadata (name, size, extension, lastModified); " +
      "(3) a FOLDER path (empty string for the root, or a path ending in '/') lists its entries (use recursive, viewMode FLAT/NESTED, extensions, namePattern, foldersOnly); " +
      "(4) a FOLDER path with download=true returns a ZIP of the folder (base64). " +
      "Optional 'version' reads a historical revision; 'branch' pins the project branch. Optional byte range (offset/length) is applied client-side AFTER fetching the whole file (the backend does not support partial transfers), so the entire file is loaded into memory; for very large/binary files, bound the RETURNED size with offset/length and read in chunks (a full file's base64 can exceed MCP message limits). Use this to read AGENTS.md, README.md, schemas, manifests, or to inspect/export xlsx rule files.",
    inputSchema: schemas.z.toJSONSchema(schemas.readProjectFileSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        path?: string;
        view?: "meta";
        download?: boolean;
        recursive?: boolean;
        viewMode?: "FLAT" | "NESTED";
        extensions?: string[];
        namePattern?: string;
        foldersOnly?: boolean;
        version?: string;
        branch?: string;
        fields?: string;
        encoding?: "auto" | "utf-8" | "base64";
        offset?: number;
        length?: number;
        response_format?: "json" | "markdown" | "markdown_concise" | "markdown_detailed";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const path = typedArgs.path ?? "";

      const { data, contentType, contentDisposition } = await client.readProjectFile(
        typedArgs.projectId,
        path,
        {
          view: typedArgs.view,
          download: typedArgs.download,
          recursive: typedArgs.recursive,
          viewMode: typedArgs.viewMode,
          extensions: typedArgs.extensions,
          namePattern: typedArgs.namePattern,
          foldersOnly: typedArgs.foldersOnly,
          version: typedArgs.version,
          branch: typedArgs.branch,
          fields: typedArgs.fields,
        }
      );

      // Distinguish a file/ZIP download (attachment) from a JSON listing/metadata
      // response. A .json FILE is also served as an attachment, so check the
      // Content-Disposition first and only then fall back to the Content-Type.
      const isAttachment = /attachment/i.test(contentDisposition);
      const isJson = contentType.includes("application/json");
      if (!isAttachment && isJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString("utf-8"));
        } catch {
          parsed = data.toString("utf-8");
        }
        return { content: [{ type: "text", text: formatResponse(parsed, format) }] };
      }

      // File (or folder-ZIP) content. Apply the optional client-side byte range,
      // then encode for transport (MCP tool results are text).
      const total = data.length;
      const start = Math.min(typedArgs.offset ?? 0, total);
      const end =
        typedArgs.length !== undefined ? Math.min(start + typedArgs.length, total) : total;
      const slice = data.subarray(start, end);
      const ranged = start !== 0 || end !== total;

      const forceBinary = typedArgs.encoding === "base64" || typedArgs.download === true;
      const forceText = typedArgs.encoding === "utf-8";
      const asBase64 = forceBinary || (!forceText && looksBinary(slice));

      if (!asBase64) {
        // Text content: returned (near-)verbatim — most useful for docs/schemas/
        // manifests (response_format does not apply). The verbatim path would
        // otherwise bypass the response-size cap, so when the content exceeds the
        // 25K limit we truncate and append a continuation cursor (next byte offset)
        // so the caller can page the rest with offset/length.
        let text = slice.toString("utf-8");
        if (text.length > RESPONSE_LIMITS.MAX_CHARACTERS) {
          text = text.slice(0, RESPONSE_LIMITS.MAX_CHARACTERS);
          const nextOffset = start + Buffer.byteLength(text, "utf-8");
          text += `\n\n${RESPONSE_LIMITS.TRUNCATION_MESSAGE} Returned bytes ${start}–${nextOffset} of ${total}; continue with offset=${nextOffset}.`;
        }
        return { content: [{ type: "text", text }] };
      }

      const envelope = {
        path: path === "" ? "/" : path,
        ...(typedArgs.version ? { version: typedArgs.version } : {}),
        ...(contentType ? { contentType } : {}),
        encoding: "base64" as const,
        byteLength: total,
        returnedBytes: slice.length,
        ...(ranged ? { range: { offset: start, length: slice.length } } : {}),
        content: slice.toString("base64"),
      };
      // Binary content is ALWAYS returned as a JSON envelope with truncation
      // disabled, regardless of response_format: the markdown formats would slice
      // the base64 string at the character cap (corrupting the payload) and
      // markdown_concise would drop it entirely. Callers wanting only part of a
      // large file should page it with offset/length.
      return {
        content: [{ type: "text", text: formatResponse(envelope, "json", { skipTruncation: true }) }],
      };
    },
  });

  registerTool({
    name: "openl_write_project_file",
    title: "Write Project File",
    version: "1.0.0",
    description:
      "Create or replace a file in a project by its project-relative path. Provide 'content' as UTF-8 text (default) or base64 (set encoding='base64' for binary files such as xlsx/images). " +
      "COMMIT: pass 'message' to commit the write to Git (a new revision is created); omit 'message' and the write stays in the project WORKING COPY (commit it later with openl_save_project). Committing saves ALL pending project changes and works only for design repositories (not 'local'). " +
      "By default missing parent folders are created (createFolders=true). If the target file already EXISTS, behavior follows conflictPolicy: FAIL (default) returns an error; OVERWRITE replaces the file in place; SKIP leaves the existing file unchanged (reported skipped). Use 'branch' to pin the project's branch (omit for local/non-branch repositories). Use this to add or update docs, schemas, or manifests. (For a NEW file the tool POSTs/creates; OVERWRITE is performed via PUT/update — overwriting a module .xlsx replaces its bytes but to change a module's TABLES use openl_update_table / openl_append_table / openl_create_project_table.)",
    inputSchema: schemas.z.toJSONSchema(schemas.writeProjectFileSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        path: string;
        content: string;
        encoding?: "utf-8" | "base64";
        createFolders?: boolean;
        conflictPolicy?: "FAIL" | "OVERWRITE" | "SKIP";
        message?: string;
        branch?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.path || typedArgs.content === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, path, content"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Buffer.from(x, "base64") silently DROPS invalid characters and stops at
      // the first unparseable run, so mislabeled/truncated base64 would write a
      // corrupted or empty file with no error. Validate up front instead.
      if (typedArgs.encoding === "base64" && !isValidBase64(typedArgs.content)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "content is not valid base64. Provide a clean base64 string, or set encoding to 'utf-8' for text content."
        );
      }
      const buffer = Buffer.from(typedArgs.content, typedArgs.encoding === "base64" ? "base64" : "utf-8");
      const policy = typedArgs.conflictPolicy ?? "FAIL";

      // Create with POST. POST is create-only — an existing file yields 409, and
      // the backend does NOT honor conflictPolicy on a single-file POST. So we
      // implement conflictPolicy here: OVERWRITE replaces via PUT (updateResource,
      // in-place — no delete), SKIP leaves the existing file, FAIL surfaces 409.
      let metadata: unknown;
      let action: "created" | "overwritten" = "created";
      try {
        metadata = await client.writeProjectFile(typedArgs.projectId, typedArgs.path, buffer, {
          // Schema default is true; materialize it here since handlers receive raw
          // args (zod .default() only shapes the published JSON Schema, it is not
          // applied at call time). Pass false explicitly to require an existing parent.
          createFolders: typedArgs.createFolders ?? true,
          branch: typedArgs.branch,
        });
      } catch (error) {
        if (!(isAxiosError(error) && error.response?.status === 409)) {
          throw error;
        }
        if (policy === "OVERWRITE") {
          // Replace the existing file in place via PUT (backend updateResource).
          await client.updateProjectFile(typedArgs.projectId, typedArgs.path, buffer, {
            branch: typedArgs.branch,
          });
          action = "overwritten";
        } else if (policy === "SKIP") {
          const skipped = {
            success: true,
            path: typedArgs.path,
            written: false,
            skipped: true,
            committed: false,
            ...(typedArgs.branch ? { branch: typedArgs.branch } : {}),
            message: `'${typedArgs.path}' already exists; left unchanged (conflictPolicy SKIP).`,
          };
          return { content: [{ type: "text", text: formatResponse(skipped, format) }] };
        } else {
          // FAIL (default). The caller did not request OVERWRITE/SKIP, so this is a
          // genuine, actionable conflict (not a contradictory "set what you set").
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Cannot write '${typedArgs.path}': a file already exists there. ` +
              `Set conflictPolicy: "OVERWRITE" to replace it, "SKIP" to leave it unchanged, or write to a different path.`
          );
        }
      }

      // "message present -> commit": after writing to the working copy, commit it to
      // Git via saveProject (a PATCH that creates a revision). Saving commits ALL
      // pending project changes, not just this file (OpenL has no per-file commit).
      // Without a message the write simply stays in the working copy.
      let committed = false;
      let commitNote: string | undefined;
      if (typedArgs.message) {
        try {
          const saveResult = await client.saveProject(typedArgs.projectId, typedArgs.message);
          committed = saveResult.success !== false;
          commitNote = saveResult.message;
        } catch (error) {
          // e.g. a 'local' repository (no Git) — the file is already written to the
          // working copy, so report it couldn't be committed instead of failing.
          commitNote = sanitizeError(error);
        }
      }

      const verb = action === "overwritten" ? "Overwrote" : "Wrote";
      const prep = action === "overwritten" ? "in" : "to";
      const result = {
        success: true,
        path: typedArgs.path,
        action,
        bytesWritten: buffer.length,
        committed,
        ...(typedArgs.branch ? { branch: typedArgs.branch } : {}),
        ...(metadata && typeof metadata === "object" && Object.keys(metadata as object).length > 0
          ? { metadata }
          : {}),
        message:
          committed
            ? `${verb} ${buffer.length} byte(s) ${prep} '${typedArgs.path}' and committed the project to Git: "${typedArgs.message}".`
            : typedArgs.message
              ? `${verb} ${buffer.length} byte(s) ${prep} '${typedArgs.path}' in the working copy, but it was NOT committed${commitNote ? ` (${commitNote})` : ""}. Commit with openl_save_project (design repos only).`
              : `${verb} ${buffer.length} byte(s) ${prep} '${typedArgs.path}' in the project working copy. Changes are NOT committed — pass 'message' to commit, or use openl_save_project.`,
      };

      return { content: [{ type: "text", text: formatResponse(result, format) }] };
    },
  });

  registerTool({
    name: "openl_delete_project_file",
    title: "Delete Project File",
    version: "1.0.0",
    description:
      "Delete a file or folder from a project by its project-relative path. Maps to DELETE /projects/{projectId}/files/{path}. The backend auto-cleans dangling references to the deleted resource from the project configuration. Like writes, the deletion is staged in the working copy — commit it with openl_save_project. Use 'branch' to pin the project's branch (omit for local/non-branch repositories). Use this to remove legacy assets or deprecate docs. This is a destructive operation.",
    inputSchema: schemas.z.toJSONSchema(schemas.deleteProjectFileSchema) as Record<string, unknown>,
    annotations: {
      destructiveHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        path: string;
        branch?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.path) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, path");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      await client.deleteProjectFile(typedArgs.projectId, typedArgs.path, {
        branch: typedArgs.branch,
      });

      const result = {
        success: true,
        path: typedArgs.path,
        ...(typedArgs.branch ? { branch: typedArgs.branch } : {}),
        message:
          `Deleted '${typedArgs.path}' from the project working copy. ` +
          `Use openl_save_project to commit the deletion to Git.`,
      };

      return { content: [{ type: "text", text: formatResponse(result, format) }] };
    },
  });

  registerTool({
    name: "openl_search_project_files",
    title: "Search Project Files",
    version: "1.0.0",
    description:
      "Search a project's files and folders by ant-glob path 'pattern' (e.g. 'rules/**/*.xlsx'), file 'extensions', resource 'type' (FILE/FOLDER/ANY), and/or a case-insensitive 'content' substring (full-text). Maps to POST /projects/{projectId}/file-search. IMPORTANT: set recursive=true to search nested folders — by default (recursive omitted/false) only the project's TOP LEVEL is searched, and a '**' glob alone does NOT descend (so a project-wide search needs recursive=true, and to match files in subfolders use a '**/' pattern such as '**/*.xlsx', not '*.xlsx'). Scope SUBTREE (default) searches within the project and may target a historical 'version'; scope ANCESTORS walks up to the repository root. Returns matching nodes (path, name, type, size, ...), paginated client-side via 'limit'/'offset' (the response carries pagination metadata; the server returns the full match set). Use 'branch' to pin the project's branch. Use this for questions like \"where is portability loading mentioned?\" (content, recursive=true) or \"list every xlsx under rules\" (pattern '**/*.xlsx', recursive=true).",
    inputSchema: schemas.z.toJSONSchema(schemas.searchProjectFilesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        pattern?: string;
        content?: string;
        extensions?: string[];
        type?: "FILE" | "FOLDER" | "ANY";
        scope?: "SUBTREE" | "ANCESTORS";
        recursive?: boolean;
        from?: string;
        version?: string;
        branch?: string;
        fields?: string;
        limit?: number;
        offset?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs.limit, typedArgs.offset);

      // Undefined fields are dropped by JSON serialization, so an empty query
      // matches everything in scope.
      const query: Types.FileSearchQuery = {
        pattern: typedArgs.pattern,
        content: typedArgs.content,
        extensions: typedArgs.extensions,
        type: typedArgs.type,
        scope: typedArgs.scope,
        recursive: typedArgs.recursive,
        from: typedArgs.from,
        version: typedArgs.version,
      };

      // The backend file-search has no server-side paging (it returns the full
      // match set), so — like openl_list_deployments/openl_list_repositories — we
      // paginate the returned array client-side and report pagination metadata.
      const results = await client.searchProjectFiles(typedArgs.projectId, query, {
        branch: typedArgs.branch,
        fields: typedArgs.fields,
      });
      const paginated = paginateResults(results, limit, offset);

      return {
        content: [{
          type: "text",
          text: formatResponse(paginated.data, format, {
            pagination: { limit, offset, total: paginated.total_count },
          }),
        }],
      };
    },
  });

  registerTool({
    name: "openl_copy_project_file",
    title: "Copy Project File",
    version: "1.0.0",
    description:
      "Copy a file within a project to a new project-relative path. Maps to POST /projects/{projectId}/file-copy. Intermediate destination folders are created automatically. There is NO overwrite option — if destinationPath already exists the call fails with HTTP 409; choose a different destination or delete the existing file first. The copy is staged in the working copy — commit it with openl_save_project. Use 'branch' to pin the project's branch. Use this to scaffold a new module from an existing one or clone a test set.",
    inputSchema: schemas.z.toJSONSchema(schemas.copyProjectFileSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        sourcePath: string;
        destinationPath: string;
        branch?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.sourcePath || !typedArgs.destinationPath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, sourcePath, destinationPath"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      try {
        await client.copyProjectFile(
          typedArgs.projectId,
          { sourcePath: typedArgs.sourcePath, destinationPath: typedArgs.destinationPath },
          { branch: typedArgs.branch }
        );
      } catch (error) {
        rethrowConflictAsActionable(
          error,
          `Cannot copy to '${typedArgs.destinationPath}': a file already exists there (copy has no overwrite option). ` +
            `Choose a different destinationPath, or delete the existing file first with openl_delete_project_file.`
        );
      }

      const result = {
        success: true,
        sourcePath: typedArgs.sourcePath,
        destinationPath: typedArgs.destinationPath,
        ...(typedArgs.branch ? { branch: typedArgs.branch } : {}),
        message:
          `Copied '${typedArgs.sourcePath}' to '${typedArgs.destinationPath}' in the project working copy. ` +
          `Use openl_save_project to commit the copy to Git.`,
      };

      return { content: [{ type: "text", text: formatResponse(result, format) }] };
    },
  });

  registerTool({
    name: "openl_move_project_file",
    title: "Move or Rename Project File",
    version: "1.0.0",
    description:
      "Move or rename a file within a project. Maps to POST /projects/{projectId}/file-move. Intermediate destination folders are created automatically and the source file is deleted after the move. A destination collision fails with HTTP 409. The move is staged in the working copy — commit it with openl_save_project. Use 'branch' to pin the project's branch. Use this to rename a file or relocate it to another folder.",
    inputSchema: schemas.z.toJSONSchema(schemas.moveProjectFileSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        sourcePath: string;
        destinationPath: string;
        branch?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.sourcePath || !typedArgs.destinationPath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, sourcePath, destinationPath"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      try {
        await client.moveProjectFile(
          typedArgs.projectId,
          { sourcePath: typedArgs.sourcePath, destinationPath: typedArgs.destinationPath },
          { branch: typedArgs.branch }
        );
      } catch (error) {
        rethrowConflictAsActionable(
          error,
          `Cannot move to '${typedArgs.destinationPath}': a file already exists there. ` +
            `Choose a different destinationPath, or delete the existing file first with openl_delete_project_file.`
        );
      }

      const result = {
        success: true,
        sourcePath: typedArgs.sourcePath,
        destinationPath: typedArgs.destinationPath,
        ...(typedArgs.branch ? { branch: typedArgs.branch } : {}),
        message:
          `Moved '${typedArgs.sourcePath}' to '${typedArgs.destinationPath}' in the project working copy. ` +
          `Use openl_save_project to commit the move to Git.`,
      };

      return { content: [{ type: "text", text: formatResponse(result, format) }] };
    },
  });

  // =============================================================================
  // Rules (Tables) Tools
  // =============================================================================

  registerTool({
    name: "openl_list_tables",
    title: "List Project Tables",
    version: "1.0.0",
    description: "List all tables/rules in a project with optional filters for type, name, and file. Returns table metadata including 'tableId' (the 'id' field) which is required for calling get_table(), update_table(), append_table(), or run_project_tests(). Use the 'tableId' field from the response to reference specific tables in other API calls. IMPORTANT: table ids are volatile — every successful edit changes the edited table's id. After openl_update_table/openl_append_table, use the 'tableId' those tools return (or re-run openl_list_tables); ids from a listing taken before the edit are stale.",
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
    title: "Get Table Structure & Data",
    version: "1.0.0",
    description:
      "Get detailed information about a specific table/rule. By default returns a parsed table structure with signature, conditions, actions, dimension properties, and row data. Set raw=true to get an unparsed 2D cell matrix (RawTableView) instead — useful for unknown/custom table types or preserving exact cell layout. Note: raw output cannot be passed directly to openl_update_table (which expects the parsed form). Table ids change after every successful edit; if the given id went stale through an edit made via this server, it is resolved to the current id automatically — otherwise refresh ids with openl_list_tables().",
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
        raw?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId. Use openl_list_tables() to find valid table IDs");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const fetchTable = (id: string): Promise<Types.TableView | Types.RawTableView> =>
        typedArgs.raw
          ? client.getTable(typedArgs.projectId, id, true)
          : client.getTable(typedArgs.projectId, id);

      // EPBDS-16084: a table's id changes after every edit. If this id went
      // stale through an edit made via this server, resolve it transparently.
      let table: Types.TableView | Types.RawTableView;
      let staleIdNote: string | undefined;
      try {
        table = await fetchTable(typedArgs.tableId);
      } catch (error) {
        const aliased = isNotFoundError(error)
          ? resolveTableIdAlias(typedArgs.projectId, typedArgs.tableId)
          : undefined;
        if (aliased === undefined) {
          throw error;
        }
        table = await fetchTable(aliased);
        staleIdNote =
          `Note: the provided tableId '${typedArgs.tableId}' is stale — the table was edited after that id was issued. ` +
          `It was automatically resolved to the current id '${aliased}'. ${STALE_TABLE_ID_HINT}`;
      }

      const formattedResult = formatResponse(table, format);

      return {
        content: [
          ...(staleIdNote ? [{ type: "text", text: staleIdNote }] : []),
          { type: "text", text: formattedResult },
        ],
      };
    },
  });

  registerTool({
    name: "openl_update_table",
    title: "Replace Entire Table",
    version: "1.0.0",
    description:
      "Replace the ENTIRE table structure with a modified version. Use for MODIFYING existing rows, DELETING rows, REORDERING rows, or STRUCTURAL changes. CRITICAL: Must send the FULL table structure (not just modified fields). DO NOT use for simple additions - use append_table instead. Required workflow: 1) Call get_table() to retrieve complete structure, 2) Modify the returned object, 3) Pass the ENTIRE modified object to update_table(). IMPORTANT: a successful edit CHANGES the table's id (ids are derived from table content/position) — the response returns the table's CURRENT id as 'tableId'; use it for all subsequent calls. Note: the studio does not auto-compile after an edit (it only resets the previous compile status); this tool reads the table back after updating to trigger the recompile, so a subsequent openl_project_status reflects the change.",
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

      // Same case-sensitive tableType discriminator guard as create (see
      // normalizeEditableTableType): catches a miscased view.tableType before it
      // becomes an opaque backend 400.
      const view = normalizeEditableTableType(typedArgs.view, "view");

      const projectId = typedArgs.projectId;
      const requestedId = typedArgs.tableId;
      const notes: string[] = [];

      // EPBDS-16084: capture the table's identity (and which same-name ids exist)
      // before the edit so its new content-derived id can be found afterwards.
      const identity: TableIdentity | undefined =
        typeof view.name === "string" && view.name
          ? { name: view.name, kind: view.kind, file: view.file, pos: view.pos }
          : undefined;
      let idsBeforeEdit: Set<string> | undefined;
      if (identity) {
        const before = await listTablesByExactName(client, projectId, identity.name);
        if (before) {
          idsBeforeEdit = new Set(before.map((t) => t.id));
        }
      }

      let tableId = requestedId;
      try {
        await client.updateTable(projectId, tableId, view);
      } catch (error) {
        // A 404 writes nothing, so retrying with a known rename is safe.
        const aliased = isNotFoundError(error) ? resolveTableIdAlias(projectId, tableId) : undefined;
        if (aliased === undefined) {
          throw error;
        }
        await client.updateTable(projectId, aliased, { ...view, id: aliased });
        notes.push(
          `The provided tableId '${requestedId}' was stale (the table was edited after that id was issued) and was automatically resolved to '${aliased}'.`,
        );
        tableId = aliased;
      }

      // The edit just invalidated `tableId` too — find the table's current id so
      // the recompile read targets the right table and the caller gets a usable id.
      let currentId = tableId;
      if (identity) {
        const resolved = await resolveCurrentTableId(client, projectId, tableId, identity, idsBeforeEdit);
        if (resolved) {
          currentId = resolved;
        }
      }
      if (currentId !== tableId) {
        recordTableIdAlias(projectId, tableId, currentId);
        notes.push(
          `This edit changed the table's id from '${tableId}' to '${currentId}' (ids are derived from table content/position). Use 'tableId' from this response for subsequent calls.`,
        );
      }

      // The studio resets (does not recompile) compile status on edit; reading the
      // table back triggers its recompile so openl_project_status reflects the change.
      const recompileTriggered = await triggerTableRecompile(client, projectId, currentId);
      if (!recompileTriggered) {
        notes.push(
          `The post-edit read could not locate the table under id '${currentId}' — the update WAS applied, but the table's id likely changed. Refresh ids with openl_list_tables().`,
        );
      }

      const idChanged = currentId !== requestedId;
      const result = {
        success: true,
        message: `Successfully updated table ${requestedId}`,
        recompileTriggered,
        tableId: currentId,
        ...(idChanged ? { tableIdChanged: true, previousTableId: requestedId } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_append_table",
    title: "Append Rows/Fields to Table",
    version: "1.0.0",
    description:
      "Add new rows/fields to an existing table (additions only). Payload by type: Datatype→fields, SimpleRules/SmartRules→rules, SimpleSpreadsheet→steps, Vocabulary→values, RawSource→rows. For RawSource, each row must cover ALL columns of the table (one cell object per column; rows with a wrong cell count are rejected before anything is written). For modifying, deleting, or reordering use update_table instead. IMPORTANT: a successful edit CHANGES the table's id (ids are derived from table content/position) — the response returns the table's CURRENT id as 'tableId'; use it for all subsequent calls. Note: the studio does not auto-compile after an edit (it only resets the previous compile status); this tool reads the table back after appending to trigger the recompile, so a subsequent openl_project_status reflects the change.",
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
          rows?: Array<Array<Record<string, unknown>>>;
        };
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId || !typedArgs.appendData) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId, appendData");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert to AppendTableView format expected by client
      const appendData: Types.AppendTableView = typedArgs.appendData as any;

      const projectId = typedArgs.projectId;
      const requestedId = typedArgs.tableId;
      const notes: string[] = [];

      // Probe the table before editing. This (a) fails fast on a stale id —
      // resolving it transparently when the rename is known (EPBDS-16084),
      // (b) captures the identity needed to find the table's new id after the
      // edit, and (c) for RawSource provides the source matrix used to validate
      // row width before anything is written (EPBDS-16085).
      const needsRawProbe = appendData.tableType === "RawSource";
      let tableId = requestedId;
      let probedView: Types.TableView | Types.RawTableView | undefined;
      try {
        probedView = needsRawProbe
          ? await client.getTable(projectId, tableId, true)
          : await client.getTable(projectId, tableId);
      } catch (error) {
        if (isNotFoundError(error)) {
          const aliased = resolveTableIdAlias(projectId, tableId);
          if (aliased === undefined) {
            throw error;
          }
          probedView = needsRawProbe
            ? await client.getTable(projectId, aliased, true)
            : await client.getTable(projectId, aliased);
          notes.push(
            `The provided tableId '${requestedId}' was stale (the table was edited after that id was issued) and was automatically resolved to '${aliased}'.`,
          );
          tableId = aliased;
        }
        // Non-404 probe failures are tolerated: the append call itself decides.
      }

      if (
        needsRawProbe &&
        probedView &&
        Array.isArray((probedView as Types.RawTableView).source) &&
        Array.isArray((appendData as { rows?: unknown }).rows)
      ) {
        validateRawSourceAppendRows(
          (appendData as { rows: Array<Array<Record<string, unknown>>> }).rows,
          (probedView as Types.RawTableView).source,
          probedView.name || tableId,
        );
      }

      // EPBDS-16084: snapshot which same-name ids exist before the edit so the
      // table's new content-derived id can be found afterwards.
      const identity: TableIdentity | undefined = probedView?.name
        ? { name: probedView.name, kind: probedView.kind, file: probedView.file, pos: probedView.pos }
        : undefined;
      let idsBeforeEdit: Set<string> | undefined;
      if (identity) {
        const before = await listTablesByExactName(client, projectId, identity.name);
        if (before) {
          idsBeforeEdit = new Set(before.map((t) => t.id));
        }
      }

      await client.appendProjectTable(projectId, tableId, appendData);

      // The edit just invalidated `tableId` — find the table's current id so the
      // recompile read targets the right table and the caller gets a usable id.
      let currentId = tableId;
      if (identity) {
        const resolved = await resolveCurrentTableId(client, projectId, tableId, identity, idsBeforeEdit);
        if (resolved) {
          currentId = resolved;
        }
      }
      if (currentId !== tableId) {
        recordTableIdAlias(projectId, tableId, currentId);
        notes.push(
          `This edit changed the table's id from '${tableId}' to '${currentId}' (ids are derived from table content/position). Use 'tableId' from this response for subsequent calls.`,
        );
      }

      // The studio resets (does not recompile) compile status on edit; reading the
      // table back triggers its recompile so openl_project_status reflects the change.
      const recompileTriggered = await triggerTableRecompile(client, projectId, currentId);
      if (!recompileTriggered) {
        notes.push(
          `The post-edit read could not locate the table under id '${currentId}' — the append WAS applied, but the table's id likely changed. Refresh ids with openl_list_tables().`,
        );
      }

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
      } else if ("rows" in typedArgs.appendData && Array.isArray(typedArgs.appendData.rows)) {
        itemCount = typedArgs.appendData.rows.length;
        itemType = "row(s)";
      }

      const idChanged = currentId !== requestedId;
      const result = {
        success: true,
        message: `Successfully appended ${itemCount} ${itemType} to table ${requestedId}`,
        recompileTriggered,
        tableId: currentId,
        ...(idChanged ? { tableIdChanged: true, previousTableId: requestedId } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_create_project_table",
    title: "Create New Table",
    version: "1.0.0",
    description:
      "Create a new table/rule in an OpenL project (Create New Project Table API). This is the recommended tool for creating new OpenL tables programmatically. Use cases: Create Rules (decision tables), Spreadsheet tables, Datatype definitions, Test tables, or other table types. Requires moduleName (an EXISTING project module — modules correspond to the project's .xlsx files; a freshly created blank project has a single module named 'Main') and a complete table structure (EditableTableView). The table structure must include 'tableType' and 'name'. CRITICAL: 'tableType' is a CASE-SENSITIVE discriminator — use EXACTLY one of: Datatype, Vocabulary, Spreadsheet, SimpleSpreadsheet, SimpleRules, SmartRules, SimpleLookup, SmartLookup, Data, Test, RawSource (a lowercase value like 'datatype' is rejected by the backend). Add type-specific data: fields (Datatype), rules (SimpleRules/SmartRules), rows (Spreadsheet), steps (SimpleSpreadsheet), values (Vocabulary). For RULES/DECISION tables (SimpleRules/SmartRules) and lookups you MUST also provide: 'returnType' (e.g. \"String\"), 'args': [{name,type}] (the input parameters), and 'headers': [{title}] (the column captions — one per rule-row key, the return column is usually titled \"RET1\"); each 'rules' row is a map keyed by those header titles. There is NO 'signature' field — the method is defined by name + returnType + args. Example SimpleRules: {tableType:\"SimpleRules\", name:\"CreditCategory\", returnType:\"String\", args:[{name:\"creditScore\",type:\"Integer\"}], headers:[{title:\"creditScore\"},{title:\"RET1\"}], rules:[{creditScore:\"< 580\", RET1:\"Poor\"}, {creditScore:\">= 800\", RET1:\"Excellent\"}]}. WARNING: the backend rejects unknown/extra fields with an opaque 400 \"Failed to read request\". 'id' is optional. Use get_table() on an existing table as a reference for the structure (for a blank project with no tables, use the tableType list and the SimpleRules example above). The response contains the created table's metadata (id, signature), NOT a compilation result — call openl_project_status afterward to confirm the project still compiles. This tool uses the Create New Project Table API endpoint.",
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

      // Normalize the case-sensitive tableType discriminator up front: a wrong
      // case (e.g. "datatype") otherwise reaches the backend as an opaque
      // 400 "Failed to read request" (Jackson can't resolve the subtype).
      const table = normalizeEditableTableType(typedArgs.table, "table");

      const createdTable = await client.createProjectTable(typedArgs.projectId, {
        moduleName: typedArgs.moduleName,
        sheetName: typedArgs.sheetName,
        table,
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
    title: "List Active Deployments",
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
    title: "Deploy Project to Production",
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
    title: "Execute Rule",
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
  // Trace Tools (BETA - Execution Trace API)
  // =============================================================================

  registerTool({
    name: "openl_start_trace",
    title: "Start Rule Trace",
    version: "1.0.0",
    description:
      "Start trace execution for a table. Trace is asynchronous (returns 202 Accepted). For regular rules: provide inputJson with { params: {...}, runtimeContext?: {...} }. For test tables: use testRanges (e.g. '1-3,5'). After starting, call openl_get_trace_nodes once — while the trace is still running it subscribes to the studio's trace-status websocket and waits for completion server-side (no manual polling/retrying on 409 needed).",
    inputSchema: schemas.z.toJSONSchema(schemas.startTraceSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        testRanges?: string;
        fromModule?: string;
        inputJson?: string | Record<string, unknown>;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId || !typedArgs?.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId");
      }

      await client.startTrace({
        projectId: typedArgs.projectId,
        tableId: typedArgs.tableId,
        testRanges: typedArgs.testRanges,
        fromModule: typedArgs.fromModule,
        inputJson: typedArgs.inputJson,
      });

      // The trace-status websocket topic is per-table; remember which table this
      // trace runs for so the read tools can subscribe while waiting (EPBDS-16089).
      recordActiveTrace(typedArgs.projectId, typedArgs.tableId);

      const msg =
        "Trace execution started (202 Accepted). Call openl_get_trace_nodes(projectId) once to retrieve results — " +
        "while the trace is still running it waits for completion via the studio's trace-status websocket " +
        "(default timeout 120s; tune with waitTimeoutMs). No manual polling or retrying on 409 is needed.";

      return {
        content: [{ type: "text", text: msg }],
      };
    },
  });

  registerTool({
    name: "openl_get_trace_nodes",
    title: "Get Trace Tree Nodes",
    version: "1.0.0",
    description:
      "Get trace node children (or root nodes if nodeId omitted). Use openl_start_trace first. While the trace is still running the backend answers 409 Conflict; by DEFAULT this tool subscribes to the studio's trace-status websocket and waits (up to waitTimeoutMs, default 120s) until the trace completes — call it once after openl_start_trace, no manual polling needed. Pass 'tableId' (the id given to openl_start_trace) when the trace was started by a different server/CLI process; otherwise the table is remembered automatically. Set wait: false for the raw immediate-409 behavior.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceNodesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        nodeId?: number;
        showRealNumbers?: boolean;
        tableId?: string;
        wait?: boolean;
        waitTimeoutMs?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const nodes = await readTraceWithWait(
        client,
        () =>
          client.getTraceNodes(typedArgs.projectId, {
            nodeId: typedArgs.nodeId,
            showRealNumbers: typedArgs.showRealNumbers,
          }),
        {
          projectId: typedArgs.projectId,
          tableId: typedArgs.tableId,
          wait: typedArgs.wait !== false,
          timeoutMs: typedArgs.waitTimeoutMs,
          toolName: "openl_get_trace_nodes",
          extra,
        },
      );

      const formattedResult = formatResponse(nodes, format);
      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_trace_node_details",
    title: "Get Trace Node Details",
    version: "1.0.0",
    description:
      "Get detailed trace node including parameters, context, result, and errors. Node IDs come from openl_get_trace_nodes.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceNodeDetailsSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        nodeId: number;
        showRealNumbers?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId || typedArgs?.nodeId == null) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, nodeId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const node = await client.getTraceNodeDetails(
        typedArgs.projectId,
        typedArgs.nodeId,
        typedArgs.showRealNumbers ?? false
      );

      const formattedResult = formatResponse(node, format);
      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "openl_get_trace_parameter",
    title: "Get Trace Parameter Value",
    version: "1.0.0",
    description:
      "Get lazy-loaded parameter value. Use when a TraceParameterValue has lazy:true and parameterId set.",
    inputSchema: schemas.z.toJSONSchema(schemas.getTraceParameterSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        parameterId: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId || typedArgs?.parameterId == null) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, parameterId");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const param = await client.getTraceParameter(typedArgs.projectId, typedArgs.parameterId);

      const formattedResult = formatResponse(param, format);
      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });


  registerTool({
    name: "openl_cancel_trace",
    title: "Cancel Ongoing Trace",
    version: "1.0.0",
    description: "Cancel ongoing trace execution for a project.",
    inputSchema: schemas.z.toJSONSchema(schemas.cancelTraceSchema) as Record<string, unknown>,
    annotations: { openWorldHint: true },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as { projectId: string; response_format?: "json" | "markdown" };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      await client.cancelTrace(typedArgs.projectId);

      return {
        content: [{ type: "text", text: "Trace cancelled." }],
      };
    },
  });

  registerTool({
    name: "openl_export_trace",
    title: "Export Trace as Text",
    version: "1.0.0",
    description:
      "Export trace as plain text. Returns full trace content. Use release: true to clear trace from memory after export. While the trace is still running the backend answers 409 Conflict; by DEFAULT this tool subscribes to the studio's trace-status websocket and waits (up to waitTimeoutMs, default 120s) until the trace completes. Pass 'tableId' (the id given to openl_start_trace) when the trace was started by a different server/CLI process; otherwise the table is remembered automatically. Set wait: false for the raw immediate-409 behavior.",
    inputSchema: schemas.z.toJSONSchema(schemas.exportTraceSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client, extra): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        showRealNumbers?: boolean;
        release?: boolean;
        tableId?: string;
        wait?: boolean;
        waitTimeoutMs?: number;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs?.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId");
      }

      const text = await readTraceWithWait(
        client,
        () =>
          client.exportTrace(typedArgs.projectId, {
            showRealNumbers: typedArgs.showRealNumbers,
            release: typedArgs.release,
          }),
        {
          projectId: typedArgs.projectId,
          tableId: typedArgs.tableId,
          wait: typedArgs.wait !== false,
          timeoutMs: typedArgs.waitTimeoutMs,
          toolName: "openl_export_trace",
          extra,
        },
      );

      return {
        content: [{ type: "text", text }],
      };
    },
  });

  // =============================================================================
  // Version Control Tools
  // =============================================================================

  // TEMPORARILY DISABLED - openl_revert_version
  // Tool is not working correctly and needs implementation fixes
  /*
  registerTool({
    name: "openl_revert_version",
    title: "Revert Version",
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
    title: "Get File History",
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
    title: "Get Project History",
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
    title: "Get Repository Features",
    version: "1.0.0",
    description:
      "Get features supported by a design repository (branching, searchable, etc.). Use this to check if a repository supports specific features like branching before performing operations that depend on those features. Pass either the id or name from openl_list_repositories() — both are accepted (case-insensitive). Do not invent example values; call openl_list_repositories() first if not in context.",
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
    title: "Get Project Revision History",
    version: "1.0.0",
    description:
      "Get revision history (commit history) of a project in a design repository. Returns list of revisions with commit hashes, authors, timestamps, and commit types. Supports pagination and filtering by branch and search term. Pass either the id or name from openl_list_repositories() — both are accepted (case-insensitive). Do not invent example values; call openl_list_repositories() first if not in context.",
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
    title: "List Deployment Repositories",
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
    title: "Create Project Branch",
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
  // Project Creation Tool (blank skeleton OR clone of an existing project)
  // =============================================================================

  registerTool({
    name: "openl_create_project",
    title: "Create or Clone Project",
    version: "2.0.0",
    description:
      "Create a new OpenL project in a design repository and commit it. Two modes, selected by the `template` argument:\n" +
      "• CREATE (omit `template`): create a BLANK project from the default empty skeleton. Committed atomically on the repository's default branch; returns the commit revision.\n" +
      "• CLONE (pass `template` = an existing project name): copy the source project's FULL structure (rules, tests, settings, request/response examples) into the new project and rename it — the project name in rules.xml is updated to projectName, matching OpenL Studio's Copy Project. The clone is committed atomically through the create-from-zip endpoint, so it is indexed and appears in openl_list_projects immediately.\n" +
      "Call openl_list_repositories() / openl_list_projects() first. Returns the new project name and commit revision (hash). A name collision is rejected with 409; a missing clone source returns 404; missing permission returns 403. Note: `branch` is honored for clones but that path writes directly to Git via the files API (one commit per file, not atomic), so a BRANCH clone may not appear in openl_list_projects until OpenL re-indexes the repository — omit `branch` for the default, immediately-visible clone. Local repositories are not supported.",
    inputSchema: schemas.z.toJSONSchema(schemas.createProjectSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        repository?: string;
        projectName?: string;
        template?: string;
        branch?: string;
        comment?: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.repository || !typedArgs.projectName) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: repository, projectName"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const repositoryId = await client.getRepositoryIdByName(typedArgs.repository);

      // -----------------------------------------------------------------------
      // CLONE mode: `template` is the source project to copy from.
      // -----------------------------------------------------------------------
      if (typedArgs.template && !typedArgs.branch) {
        // EPBDS-16088: default (branch-less) clone goes through the same
        // create-from-zip endpoint as blank create: download the source project
        // folder as a ZIP (entries are project-root-relative) and re-upload it
        // under the new name. The endpoint validates the archive, renames the
        // project in rules.xml server-side (ProjectDescriptorNameAdaptor),
        // commits ONE atomic revision, and — unlike the raw git file-copy used
        // before — registers the project in OpenL's workspace index, so the
        // clone appears in openl_list_projects immediately.
        const source = typedArgs.template;

        let sourceZip: Buffer;
        try {
          sourceZip = await client.downloadRepositoryFolderZip(repositoryId, source);
        } catch (error) {
          if (isNotFoundError(error)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Cannot clone: source project '${source}' was not found in repository '${typedArgs.repository}'. ` +
                `Use openl_list_projects() to see existing project names.`
            );
          }
          throw error;
        }

        let created: Types.CreateProjectResult;
        try {
          created = await client.createProjectFromZip(repositoryId, typedArgs.projectName, sourceZip, {
            comment: typedArgs.comment,
          });
        } catch (error) {
          rethrowConflictAsActionable(
            error,
            `Cannot create project: a project named '${typedArgs.projectName}' already exists in repository '${typedArgs.repository}'. ` +
              `Choose a different projectName.`
          );
        }

        const result = {
          success: true,
          mode: "clone",
          projectId: typedArgs.projectName,
          projectName: typedArgs.projectName,
          source,
          repository: typedArgs.repository,
          branch: created.branch,
          revision: created.revision,
          message:
            `Cloned '${source}' to '${typedArgs.projectName}' in repository '${typedArgs.repository}'` +
            `${created.revision ? ` at revision ${created.revision}` : ""}. ` +
            `The project is indexed and visible in openl_list_projects immediately; ` +
            `the project name in rules.xml (if present) was updated by the server.`,
        };

        return {
          content: [{ type: "text", text: formatResponse(result, format) }],
        };
      }

      if (typedArgs.template) {
        // BRANCH clone: the create-from-zip endpoint cannot target a branch, so
        // this path still copies through the raw git files API. The clone lands
        // on the requested branch but bypasses OpenL's workspace indexing.
        const source = typedArgs.template;
        const branch = typedArgs.branch;

        // 1. Recursively copy the source project folder to the new project folder.
        try {
          await client.copyRepositoryFile(repositoryId, source, typedArgs.projectName, branch);
        } catch (error) {
          rethrowConflictAsActionable(
            error,
            `Cannot create project: a project or folder named '${typedArgs.projectName}' already exists in repository '${typedArgs.repository}'` +
              `${branch ? ` (branch '${branch}')` : ""}. Choose a different projectName.`
          );
        }

        // 2. Rename the project in rules.xml (best-effort; mirrors CopyProjectTransformer).
        //    A descriptor-less project (no rules.xml) keeps its folder name as its name.
        let renamedDescriptor = false;
        const rulesXmlPath = `${typedArgs.projectName}/rules.xml`;
        const rulesXml = await client.getRepositoryFileContent(repositoryId, rulesXmlPath, branch);
        if (rulesXml !== null) {
          const updated = setRulesXmlProjectName(rulesXml, typedArgs.projectName);
          if (updated !== rulesXml) {
            await client.updateRepositoryFileRaw(repositoryId, rulesXmlPath, updated, branch);
            renamedDescriptor = true;
          }
        }

        // 3. Read back the commit revision (best-effort — file-copy returns no hash).
        let revision: string | undefined;
        try {
          const history = await client.getProjectRevisions(repositoryId, typedArgs.projectName, {
            branch,
            size: 1,
          });
          revision = history.content?.[0]?.revisionNo;
        } catch {
          // Read-back is best-effort; the clone itself already succeeded.
        }

        const result = {
          success: true,
          mode: "clone",
          projectId: typedArgs.projectName,
          projectName: typedArgs.projectName,
          source,
          repository: typedArgs.repository,
          branch,
          revision,
          renamedDescriptor,
          message:
            `Cloned '${source}' to '${typedArgs.projectName}' in repository '${typedArgs.repository}'` +
            `${branch ? ` (branch '${branch}')` : ""}` +
            `${revision ? ` at revision ${revision}` : ""}.`,
          note:
            "Branch clone goes through the raw git files API (one commit per file, not atomic): the new project " +
            "may not appear in openl_list_projects (and its history/revision may be unavailable) until OpenL " +
            "re-indexes the repository. Commit messages are system-generated. To get an immediately-visible, " +
            "atomically-committed clone on the default branch, omit `branch`." +
            (revision ? "" : " No commit revision could be read back yet (project not indexed)."),
        };

        return {
          content: [{ type: "text", text: formatResponse(result, format) }],
        };
      }

      // -----------------------------------------------------------------------
      // CREATE mode: blank project from the bundled empty skeleton.
      // -----------------------------------------------------------------------
      if (typedArgs.branch) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "branch is only supported when cloning (with `template`). A blank project is created on the " +
            "repository's default branch — omit `branch`, or clone an existing project to target a specific branch."
        );
      }

      const templateZip = getProjectTemplateZip("empty");
      let created: Types.CreateProjectResult;
      try {
        created = await client.createProjectFromZip(repositoryId, typedArgs.projectName, templateZip, {
          comment: typedArgs.comment,
        });
      } catch (error) {
        rethrowConflictAsActionable(
          error,
          `Cannot create project: a project named '${typedArgs.projectName}' already exists in repository '${typedArgs.repository}'. ` +
            `Choose a different projectName, or use openl_list_projects() to see existing names.`
        );
      }

      const result = {
        success: true,
        mode: "create",
        projectId: typedArgs.projectName,
        projectName: typedArgs.projectName,
        repository: typedArgs.repository,
        branch: created.branch,
        revision: created.revision,
        message:
          `Created project '${typedArgs.projectName}' in repository '${typedArgs.repository}'` +
          `${created.branch ? ` (branch '${created.branch}')` : ""}` +
          `${created.revision ? ` at revision ${created.revision}` : ""}.`,
      };

      return {
        content: [{ type: "text", text: formatResponse(result, format) }],
      };
    },
  });

  // =============================================================================
  // Local Changes & Restore Tools
  // =============================================================================

  registerTool({
    name: "openl_list_project_local_changes",
    title: "List Local Change History",
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
    title: "Restore Previous Local Version",
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
    title: "Start Project Tests",
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
    title: "Get Test Results Summary",
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
    title: "Get Full Test Results",
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
    title: "Get Test Results By Table",
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
    title: "Redeploy with New Version",
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
/**
 * Severity ordering for `compilation.messages.items`. Anything not recognised
 * is sorted to the end so unknown severities can't push real ERRORs past a
 * response-format truncation point.
 */
const SEVERITY_RANK: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2 };
const UNKNOWN_SEVERITY_RANK = 99;

function severityRank(severity: string | undefined): number {
  if (!severity) return UNKNOWN_SEVERITY_RANK;
  return SEVERITY_RANK[severity] ?? UNKNOWN_SEVERITY_RANK;
}

/**
 * Apply the response-shaping rules for `openl_project_status`:
 *
 *  1. When `compileState === "ok"`, drop the noisy `items[]` list — counts and
 *     module/test totals are preserved so the caller still sees compile-summary.
 *  2. Otherwise, sort `items[]` by severity (ERROR → WARN → INFO) so the most
 *     actionable diagnostics survive the response-format character truncation
 *     (markdown does a dumb `.slice(0, 25000)` and the backend returns items in
 *     id-ascending order — without this, ERRORs end up past the cutoff when a
 *     project has many WARNs).
 *  3. Optional `severity` filter narrows items to the requested severities.
 *  4. Optional `maxMessages` caps the (already-sorted) items list.
 */
function shapeStatusResponse(
  status: Types.ProjectStatusView,
  severityFilter?: ("ERROR" | "WARN" | "INFO")[],
  maxMessages?: number,
): Types.ProjectStatusView {
  if (!status.compilation?.messages) {
    return status;
  }
  if (status.compileState === "ok") {
    return {
      ...status,
      compilation: {
        ...status.compilation,
        messages: { ...status.compilation.messages, items: [] },
      },
    };
  }
  let items = [...(status.compilation.messages.items ?? [])];
  items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  if (severityFilter && severityFilter.length > 0) {
    const allowed = new Set<string>(severityFilter);
    items = items.filter((m) => m.severity !== undefined && allowed.has(m.severity));
  }
  if (typeof maxMessages === "number" && maxMessages > 0 && items.length > maxMessages) {
    items = items.slice(0, maxMessages);
  }
  return {
    ...status,
    compilation: {
      ...status.compilation,
      messages: { ...status.compilation.messages, items },
    },
  };
}

/**
 * Build a short human-readable progress message for `notifications/progress`
 * from a status snapshot. The MCP client typically renders this next to the
 * progress bar; keep it terse.
 */
function progressMessage(status: Types.ProjectStatusView): string {
  if (status.compileState === "compiling") {
    const m = status.compilation?.modules;
    if (m && typeof m.total === "number" && m.total > 0) {
      return `Compiling — ${m.compiled} / ${m.total} modules`;
    }
    return "Compiling…";
  }
  if (status.compileState === "idle") {
    return "Waiting for compilation to start";
  }
  // Terminal states aren't normally emitted via onProgress (the wait resolves first),
  // but include sensible labels just in case.
  return `Compile state: ${status.compileState}`;
}

/**
 * Rethrow an HTTP 409 (conflict) from a mutating call as a clear, actionable
 * McpError; rethrow anything else unchanged so it reaches {@link handleToolError}.
 *
 * The default status→ErrorCode mapping turns 409 into InternalError, which reads
 * to the model as a server fault rather than a recoverable "name already taken".
 * Create/clone use this to tell the model exactly how to recover.
 *
 * @returns never — always throws.
 */
function rethrowConflictAsActionable(error: unknown, conflictMessage: string): never {
  if (isAxiosError(error) && error.response?.status === 409) {
    throw new McpError(ErrorCode.InvalidRequest, conflictMessage);
  }
  throw error;
}

/**
 * Force the studio to (re)compile a table after an edit by reading it back.
 *
 * The studio's table-edit endpoints (update / append) do NOT auto-compile — they
 * only RESET the project's previous compile status. Compilation is triggered when
 * the table is read (GET /projects/{id}/tables/{tableId}). So after an edit we
 * read the table by id, which makes a subsequent openl_project_status reflect the
 * change. Best-effort: the edit has already been committed, so a failure here is
 * swallowed (the status simply refreshes on the next table read) and reported via
 * the boolean result so callers don't claim `recompileTriggered: true` falsely.
 */
async function triggerTableRecompile(
  client: OpenLClient,
  projectId: string,
  tableId: string,
): Promise<boolean> {
  try {
    await client.getTable(projectId, tableId);
    return true;
  } catch {
    // Best-effort: the edit already applied; compile status refreshes on next read.
    return false;
  }
}

// =============================================================================
// Trace wait helpers (EPBDS-16089)
// =============================================================================

/**
 * Which table the most recent trace was started for, per project
 * (`projectId → tableId`). The studio publishes the trace lifecycle on a
 * PER-TABLE websocket topic (`/user/topic/projects/{id}/tables/{tableId}/trace/status`),
 * but the trace READ endpoints take only the projectId — so openl_start_trace
 * records the pair here and the read tools use it to subscribe while waiting
 * out the 409 window. Callers in a different process (e.g. separate CLI runs)
 * pass `tableId` explicitly instead. Bounded: oldest entries evicted first.
 * The studio itself keeps at most one trace per session, so one entry per
 * project is sufficient.
 */
const ACTIVE_TRACE_LIMIT = 500;
const activeTraceTables = new Map<string, string>();

function recordActiveTrace(projectId: string, tableId: string): void {
  activeTraceTables.delete(projectId); // re-insert to refresh eviction order
  activeTraceTables.set(projectId, tableId);
  while (activeTraceTables.size > ACTIVE_TRACE_LIMIT) {
    const oldest = activeTraceTables.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    activeTraceTables.delete(oldest);
  }
}

/**
 * Run a trace read, waiting out the "trace still running" 409 window by
 * subscribing to the studio's trace-status websocket topic (EPBDS-16089) —
 * see {@link executeTraceReadWithWait} in wait-for-trace.ts for the mechanism.
 * An LLM agent cannot sleep between calls, so the waiting happens INSIDE the
 * tool call. This wrapper supplies the tool-layer glue: resolving the tableId
 * (explicit arg, or the one recorded by openl_start_trace), MCP progress
 * notifications, and mapping the wait outcomes to actionable McpErrors.
 */
async function readTraceWithWait<T>(
  client: OpenLClient,
  read: () => Promise<T>,
  options: {
    projectId: string;
    tableId?: string;
    wait: boolean;
    timeoutMs?: number;
    toolName: string;
    extra?: ToolHandlerExtra;
  },
): Promise<T> {
  if (!options.wait) {
    return read();
  }

  const tableId = options.tableId ?? activeTraceTables.get(options.projectId);
  if (!tableId) {
    // Without the tableId there is no way to know the trace-status destination.
    // Do the plain read; if the trace is still running, say how to enable waiting.
    try {
      return await read();
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Trace is still running (409 Conflict), and the table it was started for is unknown to this server instance, ` +
            `so the studio's trace-status websocket cannot be joined to wait for completion. ` +
            `Pass 'tableId' (the same id given to openl_start_trace) to enable the server-side wait, or retry shortly.`,
        );
      }
      throw error;
    }
  }

  const progressToken = options.extra?._meta?.progressToken;
  const sendNotification = options.extra?.sendNotification;
  const startedAt = Date.now();
  const onProgress =
    progressToken !== undefined && sendNotification
      ? (status: string): void => {
          // Notification failures are non-fatal — the wait resolves on the terminal frame.
          void sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: Math.round((Date.now() - startedAt) / 1000),
              message: `Trace ${status.toLowerCase()} — waiting for completion…`,
            },
          }).catch(() => { /* ignore */ });
        }
      : undefined;

  try {
    return await executeTraceReadWithWait(client, options.projectId, tableId, read, {
      onProgress,
      signal: options.extra?.signal,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error instanceof TraceWaitTimeoutError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Trace is still running after waiting ${Math.round(error.waitedMs / 1000)}s (a cold project compile can take tens of seconds). ` +
          `The trace keeps running server-side — call ${options.toolName} again (optionally with a larger waitTimeoutMs, max ${MAX_TRACE_WAIT_TIMEOUT_MS} ms), ` +
          `or stop it with openl_cancel_trace.`,
      );
    }
    if (error instanceof TraceExecutionFailedError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Trace execution failed in the studio: ${error.message} Start a new trace with openl_start_trace.`,
      );
    }
    if (error instanceof TraceWaitUnavailableError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Trace is still running (409 Conflict), and waiting over the studio websocket is unavailable: ${error.message}. ` +
          `Retry shortly, or stop the trace with openl_cancel_trace.`,
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpError(ErrorCode.InvalidRequest, `${options.toolName}: request cancelled while waiting for the trace to complete.`);
    }
    throw error;
  }
}

// =============================================================================
// Table id volatility helpers (EPBDS-16084 / EPBDS-16085 / EPBDS-16086)
// =============================================================================

/**
 * Guidance attached wherever a stale table id may be involved. Studio table ids
 * are derived from the table's content/position, so every successful edit gives
 * the edited table a NEW id and silently invalidates the old one. Without this
 * hint an agent reads the resulting 404 as "the edit was rolled back" and gives
 * up (EPBDS-16086) — the edit is in fact applied.
 */
const STALE_TABLE_ID_HINT =
  "Table ids are derived from the table's content/position and change after every successful edit, " +
  "so an id obtained before an edit becomes stale while the edit itself remains applied " +
  "(a 404 here does NOT mean the edit was rolled back). Use the 'tableId' returned by the last " +
  "openl_update_table/openl_append_table response, or refresh ids with openl_list_tables().";

/**
 * Bounded process-wide registry of table-id renames observed by the edit tools
 * (EPBDS-16084). When an edit changes a table's id, the old→new pair is recorded
 * here so later calls that still carry the pre-edit id can be resolved
 * transparently instead of failing with a misleading 404. Keys are
 * projectId-scoped; oldest entries are evicted first.
 */
const TABLE_ID_ALIAS_LIMIT = 5000;
const tableIdAliases = new Map<string, string>();

function tableIdAliasKey(projectId: string, tableId: string): string {
  return `${projectId} ${tableId}`;
}

function recordTableIdAlias(projectId: string, oldId: string, newId: string): void {
  if (oldId === newId) {
    return;
  }
  const key = tableIdAliasKey(projectId, oldId);
  tableIdAliases.delete(key); // re-insert to refresh eviction order
  tableIdAliases.set(key, newId);
  while (tableIdAliases.size > TABLE_ID_ALIAS_LIMIT) {
    const oldest = tableIdAliases.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    tableIdAliases.delete(oldest);
  }
}

/**
 * Resolve a possibly-stale table id to the most recent id recorded for it,
 * following rename chains (id1→id2→id3) with cycle protection. Returns
 * undefined when nothing is known about the id.
 */
function resolveTableIdAlias(projectId: string, tableId: string): string | undefined {
  let current = tableId;
  let resolved: string | undefined;
  const seen = new Set<string>([tableId]);
  for (;;) {
    const next = tableIdAliases.get(tableIdAliasKey(projectId, current));
    if (next === undefined || seen.has(next)) {
      break;
    }
    seen.add(next);
    resolved = next;
    current = next;
  }
  return resolved;
}

function isNotFoundError(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}

/** The fields used to find a table again after an edit changed its id. */
interface TableIdentity {
  name: string;
  kind?: string;
  file?: string;
  pos?: string;
}

/** Start cell of a `pos` range like "A1:R10" (appends grow the end, not the start). */
function rangeStart(pos: string | undefined): string | undefined {
  const start = pos?.split(":")[0]?.trim();
  return start || undefined;
}

/**
 * List the project's tables whose name EXACTLY matches `name` (the backend's
 * `name` query param is a fragment filter). Best-effort: returns undefined on
 * any API failure so callers degrade gracefully.
 */
async function listTablesByExactName(
  client: OpenLClient,
  projectId: string,
  name: string,
): Promise<Types.TableMetadata[] | undefined> {
  try {
    const tables = await client.listTables(projectId, { name });
    return tables.filter((t) => t.name === name);
  } catch {
    return undefined;
  }
}

/**
 * Re-resolve a table's CURRENT id after an edit (EPBDS-16084).
 *
 * A successful update/append changes the table's content-derived id, so the id
 * the caller used is stale the moment the edit lands. This looks the table up
 * again by its identity captured before the edit: exact name, then kind/file
 * narrowing, then (for same-name siblings such as dimension-versioned tables)
 * the range start cell, and finally "which candidate id did not exist before
 * the edit". Returns undefined when the new id cannot be determined
 * unambiguously.
 */
async function resolveCurrentTableId(
  client: OpenLClient,
  projectId: string,
  previousId: string,
  identity: TableIdentity,
  idsBeforeEdit: Set<string> | undefined,
): Promise<string | undefined> {
  const tables = await listTablesByExactName(client, projectId, identity.name);
  if (!tables || tables.length === 0) {
    return undefined;
  }

  let candidates = tables;
  if (identity.kind) {
    const sameKind = candidates.filter((t) => t.kind === identity.kind);
    if (sameKind.length > 0) {
      candidates = sameKind;
    }
  }
  if (identity.file) {
    const sameFile = candidates.filter((t) => t.file === identity.file);
    if (sameFile.length > 0) {
      candidates = sameFile;
    }
  }

  if (candidates.some((t) => t.id === previousId)) {
    return previousId; // the id survived this edit
  }
  if (candidates.length === 1) {
    return candidates[0].id;
  }

  const start = rangeStart(identity.pos);
  if (start) {
    const samePos = candidates.filter((t) => rangeStart(t.pos) === start);
    if (samePos.length === 1) {
      return samePos[0].id;
    }
  }
  if (idsBeforeEdit) {
    const fresh = candidates.filter((t) => !idsBeforeEdit.has(t.id));
    if (fresh.length === 1) {
      return fresh[0].id;
    }
  }
  return undefined;
}

/**
 * EPBDS-16085: reject RawSource append rows whose width does not match the
 * table, BEFORE anything is posted. The backend accepts short rows and silently
 * pads the missing cells with blanks — corrupt data with success:true.
 *
 * The table width comes from the raw source matrix (which includes covered
 * placeholder cells, so every row has one entry per column). A submitted row is
 * accepted when either its entry count matches the width (placeholder style,
 * mirroring openl_get_table raw output) or the columns covered via colspan add
 * up to the width (no-placeholder style). If the matrix is ragged the width
 * cannot be trusted and validation is skipped rather than blocking valid
 * appends.
 */
function validateRawSourceAppendRows(
  rows: Array<Array<Record<string, unknown>>>,
  source: Types.RawTableCell[][],
  tableLabel: string,
): void {
  if (!Array.isArray(source) || source.length === 0 || rows.length === 0) {
    return;
  }
  const widths = new Set(source.map((row) => (Array.isArray(row) ? row.length : -1)));
  if (widths.size !== 1 || widths.has(-1)) {
    return;
  }
  const width = source[0].length;
  if (width === 0) {
    return;
  }

  const problems: string[] = [];
  rows.forEach((row, index) => {
    const entryCount = row.length;
    let coveredColumns = 0;
    for (const cell of row) {
      if (cell && cell.covered === true) {
        coveredColumns += 1;
        continue;
      }
      const colspan = Number(cell?.colspan);
      coveredColumns += Number.isFinite(colspan) && colspan >= 2 ? colspan : 1;
    }
    if (entryCount !== width && coveredColumns !== width) {
      problems.push(
        `row ${index + 1} has ${entryCount} cell(s)` +
          (coveredColumns !== entryCount ? ` covering ${coveredColumns} column(s)` : ""),
      );
    }
  });

  if (problems.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Cannot append to table '${tableLabel}': the table is ${width} column(s) wide, but ${problems.join("; ")}. ` +
        `Each appended RawSource row must cover all ${width} column(s) — provide one cell object per column ` +
        `(use { "value": "" } for intentionally blank cells). Nothing was appended. ` +
        `Call openl_get_table(raw=true) to inspect the table's exact column layout.`,
    );
  }
}

/**
 * Heuristic used by openl_read_project_file to decide whether to return file
 * content verbatim (UTF-8 text) or base64-encoded (binary). A NUL byte means
 * binary outright; otherwise we sample the head and flag binary when more than
 * 10% of bytes are control characters (excluding tab/LF/CR).
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // Printable + common whitespace (tab 9, LF 10, CR 13) are fine; the rest of
    // the C0 control range and DEL (127) are "suspicious".
    if (b < 9 || (b > 13 && b < 32) || b === 127) suspicious++;
  }
  return suspicious / n > 0.1;
}

/**
 * Strict-ish base64 validation for openl_write_project_file. Buffer.from(x,
 * "base64") silently drops invalid characters and stops decoding at the first
 * unparseable run, so without this guard a mislabeled or truncated base64 string
 * would write a corrupted/empty file with success:true. Whitespace is ignored;
 * an empty/whitespace-only string is allowed (writes an empty file).
 */
function isValidBase64(value: string): boolean {
  const s = value.replace(/\s+/g, "");
  if (s.length === 0) return true;
  if (s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

/**
 * Canonical, CASE-SENSITIVE EditableTableView `tableType` discriminator values —
 * the keys of the backend's Jackson polymorphic mapping. A wrong-cased value
 * (e.g. "datatype" instead of "Datatype") fails deserialization with an opaque
 * 400 "Failed to read request" with no hint about the real cause.
 */
const EDITABLE_TABLE_TYPES = [
  "Datatype", "Vocabulary", "Spreadsheet", "SimpleSpreadsheet", "SimpleRules",
  "SmartRules", "SmartLookup", "SimpleLookup", "Data", "Test", "RawSource",
] as const;

/**
 * Validate and case-normalize the `tableType` discriminator of an EditableTableView
 * payload before it reaches the backend. Returns the view with the canonical token
 * (e.g. "datatype" -> "Datatype"); throws a clear, actionable McpError — instead of
 * the backend's opaque 400 "Failed to read request" — when tableType is missing or
 * not a recognized type. `kind` is informational (not the discriminator) and left
 * untouched.
 */
function normalizeEditableTableType(view: Types.EditableTableView, argName: string): Types.EditableTableView {
  // The backend rejects unknown JSON properties (FAIL_ON_UNKNOWN_PROPERTIES) with
  // an opaque 400 "Failed to read request". 'signature' is a common LLM invention —
  // OpenL table views have no such field; the method is defined by name+returnType+args.
  if ((view as { signature?: unknown }).signature !== undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${argName}.signature is not a valid field — OpenL table views have no 'signature'. ` +
        `Define the method with 'name', 'returnType' (e.g. "String"), and 'args': [{ name, type }] ` +
        `(the input parameters). For rules/decision tables also supply 'headers': [{ title }] (the ` +
        `column captions) and 'rules' (rows keyed by those titles). The backend rejects unknown fields ` +
        `with a 400 "Failed to read request".`
    );
  }
  const raw = (view as { tableType?: unknown }).tableType;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${argName}.tableType is required and is a CASE-SENSITIVE discriminator. Use exactly one of: ${EDITABLE_TABLE_TYPES.join(", ")}.`
    );
  }
  const canonical = EDITABLE_TABLE_TYPES.find((t) => t.toLowerCase() === raw.trim().toLowerCase());
  if (!canonical) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${argName}.tableType "${raw}" is not a valid table type. Use exactly one of (CASE-SENSITIVE): ${EDITABLE_TABLE_TYPES.join(", ")}.`
    );
  }
  return canonical === raw ? view : { ...view, tableType: canonical };
}

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

    // EPBDS-16086: a bare "The table is not found" after an edit reads as a
    // rollback. Explain that table ids go stale on every edit and how to recover.
    if (status === 404 && typeof endpoint === "string" && /\/tables\/[^/?]+/.test(endpoint)) {
      finalMessage += ` Hint: ${STALE_TABLE_ID_HINT}`;
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
