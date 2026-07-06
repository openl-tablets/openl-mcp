/**
 * Deployment tool handlers — list deployments and deploy/redeploy projects.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import { formatResponse, paginateResults } from "../formatters.js";
import { validateResponseFormat, validatePagination } from "../validators.js";
import { registerTool, type ToolResponse } from "./common.js";


export function registerDeploymentHandlers(): void {
  registerTool({
    name: "list_deployments",
    category: "Deployment",
    title: "List Active Deployments",
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
    name: "deploy_project",
    category: "Deployment",
    title: "Deploy Project to Production",
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

  registerTool({
    name: "redeploy_project",
    category: "Deployment",
    title: "Redeploy with New Version",
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
