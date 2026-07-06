/**
 * Local-change tool handlers — list a project's uncommitted local changes and
 * restore (revert) an individual change.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import { formatResponse } from "../formatters.js";
import { validateResponseFormat } from "../validators.js";
import { registerTool, type ToolResponse } from "./common.js";


export function registerLocalChangeHandlers(): void {
  registerTool({
    name: "list_project_local_changes",
    category: "Project",
    title: "List Local Change History",
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
    name: "restore_project_local_change",
    category: "Project",
    title: "Restore Previous Local Version",
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
}
