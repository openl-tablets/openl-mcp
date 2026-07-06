/**
 * Repository tool handlers — list design repositories, branches, repository
 * features, project revisions, and deploy repositories.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import { formatResponse, paginateResults } from "../formatters.js";
import { validateResponseFormat, validatePagination } from "../validators.js";
import { registerTool, type ToolResponse } from "./common.js";


export function registerRepositoryHandlers(): void {
  registerTool({
    name: "list_repositories",
    category: "Repository",
    title: "List Design Repositories",
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
    name: "list_branches",
    category: "Repository",
    title: "List Git Branches",
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

  registerTool({
    name: "list_repository_features",
    category: "Repository",
    title: "Get Repository Features",
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
    name: "repository_project_revisions",
    category: "Repository",
    title: "Get Project Revision History",
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
    name: "list_deploy_repositories",
    category: "Repository",
    title: "List Deployment Repositories",
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
}
