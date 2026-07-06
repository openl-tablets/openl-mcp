/**
 * Test-execution tool handlers — start project tests and read their results
 * (summary, full, and by-table views).
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import * as schemas from "../schemas.js";
import { formatResponse } from "../formatters.js";
import { validateResponseFormat } from "../validators.js";
import { registerTool, type ToolResponse } from "./common.js";


export function registerTestingHandlers(): void {
  registerTool({
    name: "start_project_tests",
    category: "Project",
    title: "Start Project Tests",
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
    name: "get_test_results_summary",
    category: "Project",
    title: "Get Test Results Summary",
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
    name: "get_test_results",
    category: "Project",
    title: "Get Full Test Results",
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
    name: "get_test_results_by_table",
    category: "Project",
    title: "Get Test Results By Table",
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
}
