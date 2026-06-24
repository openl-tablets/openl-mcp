/**
 * Project tool handlers — list/get projects, project status, open/save/close,
 * create projects and project branches.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import type * as Types from "../types.js";
import { formatResponse, paginateResults } from "../formatters.js";
import { validateResponseFormat, validatePagination } from "../validators.js";
import { isNotFoundError, setRulesXmlProjectName } from "../utils.js";
import { waitForCompilation } from "../stomp-waits.js";
import { getProjectTemplateZip } from "../project-templates.js";
import { registerTool, rethrowConflictAsActionable, type ToolResponse } from "./common.js";

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

export function registerProjectHandlers(): void {
  registerTool({
    name: "list_projects",
    category: "Project",
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
    name: "get_project",
    category: "Project",
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
    name: "project_status",
    category: "Project",
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
    name: "open_project",
    category: "Project",
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
    name: "save_project",
    category: "Project",
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
    name: "close_project",
    category: "Project",
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

  registerTool({
    name: "create_project_branch",
    category: "Project",
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

  registerTool({
    name: "create_project",
    category: "Project",
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
}
