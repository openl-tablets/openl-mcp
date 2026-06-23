/**
 * Response formatting utilities
 *
 * Handles JSON and Markdown formatting, pagination, and character limit enforcement.
 */

import { RESPONSE_LIMITS } from "./constants.js";
import { safeStringify } from "./utils.js";
import * as Types from "./types.js";

/**
 * Pagination metadata
 */
interface PaginationMetadata {
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  total_count?: number;
}

/**
 * Paginated response wrapper
 */
interface PaginatedResponse<T> {
  data: T;
  pagination?: PaginationMetadata;
  truncated?: boolean;
  truncation_message?: string;
}

/**
 * Format response options
 */
interface FormatOptions {
  /** Pagination metadata */
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
  /** Character limit (defaults to RESPONSE_LIMITS.MAX_CHARACTERS) */
  characterLimit?: number;
  /** Data type hint for markdown formatting */
  dataType?: string;
  /** Skip truncation for this response (useful for test results and other large data) */
  skipTruncation?: boolean;
}

/**
 * Format response data as JSON or Markdown (standard, concise, or detailed)
 *
 * @param data - Data to format
 * @param format - Output format: "json" (structured), "markdown" (default full format),
 *                 "markdown_concise" (1-2 paragraph summary), "markdown_detailed" (full + context)
 * @param options - Formatting options
 * @returns Formatted response string
 */
export function formatResponse<T>(
  data: T,
  format: "json" | "markdown" | "markdown_concise" | "markdown_detailed" = "markdown",
  options?: FormatOptions
): string {
  // Create paginated response structure
  const response: PaginatedResponse<T> = {
    data,
  };

  // Add pagination metadata if provided
  if (options && options.pagination) {
    const { limit, offset, total } = options.pagination;
    const has_more = offset + limit < total;
    response.pagination = {
      limit,
      offset,
      has_more,
      next_offset: has_more ? offset + limit : undefined,
      total_count: total,
    };
  }

  // Convert to string
  let formattedString: string;
  if (format === "json") {
    formattedString = safeStringify(response, 2);
  } else if (format === "markdown_concise") {
    formattedString = toMarkdownConcise(response, options && options.dataType);
  } else if (format === "markdown_detailed") {
    formattedString = toMarkdownDetailed(response, options && options.dataType);
  } else {
    // Default markdown
    formattedString = toMarkdown(response, options && options.dataType);
  }

  // Check character limit (skip if skipTruncation is true)
  if (options && options.skipTruncation) {
    return formattedString;
  }

  const charLimit = (options && options.characterLimit) || RESPONSE_LIMITS.MAX_CHARACTERS;
  if (formattedString.length > charLimit) {
    if (format === "json") {
      try {
        const parsedResponse = JSON.parse(formattedString) as PaginatedResponse<T>;
        if (Array.isArray(parsedResponse.data) && parsedResponse.data.length > 0) {
          const ratio = charLimit / formattedString.length;
          let itemCount = Math.max(1, Math.floor(parsedResponse.data.length * ratio * 0.9));
          let result: string;
          do {
            const truncatedWrapper = {
              data: parsedResponse.data.slice(0, itemCount),
              ...(parsedResponse.pagination ? { pagination: parsedResponse.pagination } : {}),
              truncated: true,
              truncation_message: RESPONSE_LIMITS.TRUNCATION_MESSAGE,
            };
            result = safeStringify(truncatedWrapper, 2);
            if (result.length <= charLimit) break;
            itemCount = Math.max(1, Math.floor(itemCount * 0.8));
          } while (itemCount > 1);
          return result;
        }
        const truncatedWrapper: PaginatedResponse<T> = {
          ...parsedResponse,
          truncated: true,
          truncation_message: RESPONSE_LIMITS.TRUNCATION_MESSAGE,
        };
        return safeStringify(truncatedWrapper, 2);
      } catch {
        return safeStringify({
          truncated: true,
          truncation_message: RESPONSE_LIMITS.TRUNCATION_MESSAGE,
          error: "Response too large and could not be truncated properly",
        }, 2);
      }
    } else {
      // For non-JSON formats, use existing behavior (plain text truncation)
      const truncated = formattedString.slice(0, charLimit);
      const truncationNote = `\n\n${RESPONSE_LIMITS.TRUNCATION_MESSAGE}`;
      return truncated + truncationNote;
    }
  }

  return formattedString;
}

/**
 * Convert data to markdown format
 *
 * @param response - Response data with pagination
 * @param dataType - Hint about the data type
 * @returns Markdown-formatted string
 */
export function toMarkdown<T>(
  response: PaginatedResponse<T>,
  dataType?: string
): string {
  const parts: string[] = [];

  // Format the main data
  const data = response.data;

  // Try to detect data type if not provided
  if (!dataType && Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "object" && first !== null) {
      if ("repository" in first && "type" in first) {
        dataType = "repositories";
      } else if ("projectId" in first || "projectName" in first) {
        dataType = "projects";
      } else if ("tableId" in first || ("name" in first && "tableType" in first)) {
        dataType = "tables";
      } else if ("deploymentName" in first) {
        dataType = "deployments";
      } else if ("commitHash" in first || "hash" in first) {
        dataType = "history";
      }
    }
  }

  // Format based on data type
  switch (dataType) {
    case "repositories":
      parts.push(formatRepositories(data as any));
      break;
    case "projects":
      parts.push(formatProjects(data as any));
      break;
    case "tables":
      parts.push(formatTables(data as any));
      break;
    case "deployments":
      parts.push(formatDeployments(data as any));
      break;
    case "history":
      parts.push(formatHistory(data as any));
      break;
    case "test_results":
      parts.push(formatTestResults(data as any));
      break;
    case "test_results_summary":
      parts.push(formatTestResultsSummary(data as any));
      break;
    default:
      // Generic object/array formatting
      parts.push(formatGeneric(data));
  }

  // Add pagination info if present
  if (response.pagination) {
    parts.push(formatPagination(response.pagination));
  }

  return parts.join("\n\n");
}

/**
 * Convert data to concise markdown format (1-2 paragraph summary)
 *
 * @param response - Response data with pagination
 * @param dataType - Hint about the data type
 * @returns Concise markdown-formatted string
 */
export function toMarkdownConcise<T>(
  response: PaginatedResponse<T>,
  dataType?: string
): string {
  const data = response.data;
  const parts: string[] = [];

  // Detect data type if not provided
  if (!dataType && Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "object" && first !== null) {
      if ("repository" in first && "type" in first) dataType = "repositories";
      else if ("projectId" in first || "projectName" in first) dataType = "projects";
      else if ("tableId" in first || ("name" in first && "tableType" in first)) dataType = "tables";
      else if ("deploymentName" in first) dataType = "deployments";
      else if ("commitHash" in first || "hash" in first) dataType = "history";
    }
  }

  // Generate concise summary based on data type
  if (Array.isArray(data)) {
    const count = data.length;
    const total = (response.pagination && response.pagination.total_count) || count;

    switch (dataType) {
      case "repositories":
        parts.push(`Found ${total} ${total === 1 ? 'repository' : 'repositories'}${count < total ? ` (showing ${count})` : ''}.`);
        if (count > 0) {
          const names = data.slice(0, 3).map((r: any) => r.repository || r.name).join(", ");
          parts.push(`Repositories: ${names}${count > 3 ? `, and ${count - 3} more` : ''}.`);
        }
        break;
      case "projects":
        parts.push(`Found ${total} ${total === 1 ? 'project' : 'projects'}${count < total ? ` (showing ${count})` : ''}.`);
        if (count > 0) {
          const opened = data.filter((p: any) => p.status === "OPENED").length;
          const names = data.slice(0, 3).map((p: any) => p.projectName || p.projectId).join(", ");
          parts.push(`${opened} opened. Projects: ${names}${count > 3 ? `, and ${count - 3} more` : ''}.`);
        }
        break;
      case "tables":
        parts.push(`Found ${total} ${total === 1 ? 'table' : 'tables'}${count < total ? ` (showing ${count})` : ''}.`);
        if (count > 0) {
          const types = [...new Set(data.map((t: any) => t.tableType))].join(", ");
          parts.push(`Table types: ${types}.`);
        }
        break;
      case "deployments":
        parts.push(`Found ${total} ${total === 1 ? 'deployment' : 'deployments'}${count < total ? ` (showing ${count})` : ''}.`);
        if (count > 0) {
          const names = data.slice(0, 3).map((d: any) => d.deploymentName).join(", ");
          parts.push(`Deployments: ${names}${count > 3 ? `, and ${count - 3} more` : ''}.`);
        }
        break;
      case "history":
        parts.push(`Found ${total} ${total === 1 ? 'commit' : 'commits'}${count < total ? ` (showing ${count})` : ''}.`);
        if (count > 0) {
          const latest = data[0] as any;
          parts.push(`Latest: ${latest.comment || latest.message || 'No message'} by ${latest.author || 'Unknown'}.`);
        }
        break;
      default:
        parts.push(`Found ${total} ${total === 1 ? 'item' : 'items'}${count < total ? ` (showing ${count})` : ''}.`);
    }
  } else {
    // Single object summary
    parts.push("Retrieved details successfully.");
  }

  // Add pagination note if applicable
  if (response.pagination && response.pagination.has_more) {
    parts.push(`Use offset=${response.pagination.next_offset} to retrieve more results.`);
  }

  return parts.join(" ");
}

/**
 * Convert data to detailed markdown format (all fields + rich context)
 *
 * @param response - Response data with pagination
 * @param dataType - Hint about the data type
 * @returns Detailed markdown-formatted string
 */
export function toMarkdownDetailed<T>(
  response: PaginatedResponse<T>,
  dataType?: string
): string {
  const parts: string[] = [];
  const data = response.data;

  // Detect data type if not provided
  if (!dataType && Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "object" && first !== null) {
      if ("repository" in first && "type" in first) dataType = "repositories";
      else if ("projectId" in first || "projectName" in first) dataType = "projects";
      else if ("tableId" in first || ("name" in first && "tableType" in first)) dataType = "tables";
      else if ("deploymentName" in first) dataType = "deployments";
      else if ("commitHash" in first || "hash" in first) dataType = "history";
    }
  }

  // Add contextual header with metadata
  if (Array.isArray(data)) {
    const count = data.length;
    const total = (response.pagination && response.pagination.total_count) || count;
    parts.push(`# ${dataType ? dataType.charAt(0).toUpperCase() + dataType.slice(1) : 'Results'}`);
    parts.push(`\n**Summary:** ${total} total ${total === 1 ? 'item' : 'items'}${count < total ? ` (showing ${count} on this page)` : ''}`);

    // Add timestamp
    parts.push(`**Retrieved:** ${new Date().toISOString()}`);
  }

  // Use standard markdown formatting (calls existing formatters)
  const standardMarkdown = toMarkdown(response, dataType);
  parts.push(standardMarkdown);

  // Add additional context based on data type
  if (Array.isArray(data) && data.length > 0) {
    switch (dataType) {
      case "projects": {
        const opened = data.filter((p: any) => p.status === "OPENED").length;
        const closed = data.filter((p: any) => p.status === "CLOSED").length;
        parts.push(`\n---\n**Status Breakdown:** ${opened} opened, ${closed} closed`);
        break;
      }
      case "tables": {
        const typeCount: Record<string, number> = {};
        data.forEach((t: any) => {
          typeCount[t.tableType] = (typeCount[t.tableType] || 0) + 1;
        });
        const breakdown = Object.entries(typeCount).map(([type, count]) => `${type}: ${count}`).join(", ");
        parts.push(`\n---\n**Type Breakdown:** ${breakdown}`);
        break;
      }
    }
  }

  return parts.join("\n");
}

/**
 * Format repositories as markdown table
 */
function formatRepositories(repos: any[]): string {
  if (!Array.isArray(repos) || repos.length === 0) {
    return "No repositories found.";
  }

  const lines = [
    "# Repositories",
    "",
    "| Name | Type | Status |",
    "|------|------|--------|",
  ];

  for (const repo of repos) {
    const name = repo.name || repo.repository || "N/A";
    const type = repo.type || "N/A";
    const status = repo.status || "N/A";
    lines.push(`| ${name} | ${type} | ${status} |`);
  }

  return lines.join("\n");
}

/**
 * Format projects as markdown list
 */
function formatProjects(projects: any[]): string {
  if (!Array.isArray(projects) || projects.length === 0) {
    return "No projects found.";
  }

  const lines = ["# Projects", ""];

  for (const project of projects) {
    const projectId = project.projectId || "N/A";
    const name = project.projectName || project.name || "N/A";
    const status = project.status || "N/A";
    const repository = project.repository || "N/A";

    lines.push(`## ${name}`);
    lines.push(`- **Project ID**: ${projectId}`);
    lines.push(`- **Repository**: ${repository}`);
    lines.push(`- **Status**: ${status}`);

    if (project.branch) {
      lines.push(`- **Branch**: ${project.branch}`);
    }
    if (project.tag) {
      lines.push(`- **Tag**: ${project.tag}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Escape markdown table cell content to prevent breaking table structure
 */
function escapeTableCell(value: string): string {
  if (!value) return "N/A";
  // Replace pipe characters and newlines that would break markdown tables
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/**
 * Truncate long strings with ellipsis
 */
function truncate(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) return value || "N/A";
  return value.substring(0, maxLength - 3) + "...";
}

/**
 * Format properties object as a readable string
 */
function formatProperties(properties: any): string {
  if (!properties || typeof properties !== "object") return "N/A";
  const keys = Object.keys(properties);
  if (keys.length === 0) return "N/A";
  // Show property keys, limit to 3 for readability
  const displayKeys = keys.slice(0, 3);
  const result = displayKeys.join(", ");
  return keys.length > 3 ? `${result} (+${keys.length - 3} more)` : result;
}

/**
 * Format tables as markdown table
 */
function formatTables(tables: any[]): string {
  if (!Array.isArray(tables) || tables.length === 0) {
    return "No tables found.";
  }

  const lines = [
    "# Tables",
    "",
    "| Name | Type | Kind | Table ID | Signature | Return Type | File | Properties |",
    "|------|------|------|----------|-----------|-------------|------|------------|",
  ];

  for (const table of tables) {
    const name = escapeTableCell(table.name || "N/A");
    const type = escapeTableCell(table.tableType || table.type || "N/A");
    const kind = escapeTableCell(table.kind || "N/A");
    const tableId = escapeTableCell(table.id || table.tableId || "N/A");
    // Truncate signature to 50 chars to prevent table breaking
    const signature = escapeTableCell(truncate(table.signature || "N/A", 50));
    const returnType = escapeTableCell(table.returnType || "N/A");
    const file = escapeTableCell(table.file || "N/A");
    const properties = escapeTableCell(formatProperties(table.properties));
    lines.push(`| ${name} | ${type} | ${kind} | ${tableId} | ${signature} | ${returnType} | ${file} | ${properties} |`);
  }

  return lines.join("\n");
}

/**
 * Format deployments as markdown list
 */
function formatDeployments(deployments: any[]): string {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return "No deployments found.";
  }

  const lines = ["# Deployments", ""];

  for (const deploy of deployments) {
    const name = deploy.deploymentName || deploy.name || "N/A";
    const repository = deploy.repository || "N/A";
    const version = deploy.version || "N/A";
    const status = deploy.status || "N/A";

    lines.push(`## ${name}`);
    lines.push(`- **Repository**: ${repository}`);
    lines.push(`- **Version**: ${version}`);
    lines.push(`- **Status**: ${status}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format history/commits as markdown list
 */
function formatHistory(commits: any[]): string {
  if (!Array.isArray(commits) || commits.length === 0) {
    return "No history found.";
  }

  const lines = ["# History", ""];

  for (const commit of commits) {
    const hash = commit.commitHash || commit.hash || "N/A";
    const author = commit.author || "N/A";
    const date = commit.date || commit.timestamp || "N/A";
    const message = commit.message || commit.comment || "N/A";

    lines.push(`## ${hash.substring(0, 8)}`);
    lines.push(`- **Author**: ${author}`);
    lines.push(`- **Date**: ${date}`);
    lines.push(`- **Message**: ${message}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format test results summary (without testCases) as markdown
 */
function formatTestResultsSummary(summary: Types.TestResultsSummary): string {
  if (!summary || typeof summary !== "object") {
    return "No test results summary found.";
  }

  const totalTests = summary.numberOfTests || 0;
  const totalFailures = summary.numberOfFailures || 0;
  const numberOfPassed = summary.numberOfPassed || (totalTests - totalFailures);
  const executionTime = typeof summary.executionTimeMs === 'number' && isFinite(summary.executionTimeMs)
    ? summary.executionTimeMs
    : 0;

  const lines = ["# Test Results Summary", ""];
  lines.push("## Summary");
  lines.push(`- **Total Tests**: ${totalTests}`);
  lines.push(`- **Passed**: ${numberOfPassed}`);
  lines.push(`- **Failed**: ${totalFailures}`);
  lines.push(`- **Execution Time**: ${executionTime.toFixed(2)} ms`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Format test results as markdown table
 */
function formatTestResults(summary: Types.TestsExecutionSummary & { totalTestsInAllTables?: number }): string {
  if (!summary || typeof summary !== "object") {
    return "No test results found.";
  }

  const testCases = summary.testCases || [];
  const totalTests = summary.numberOfTests || 0;
  const totalFailures = summary.numberOfFailures || 0;
  const executionTime = typeof summary.executionTimeMs === 'number' && isFinite(summary.executionTimeMs)
    ? summary.executionTimeMs
    : 0;

  const lines = ["# Test Results", ""];

  // Summary section
  // Use totalTestsInAllTables if available (counts all tests from all test tables)
  // Otherwise, calculate total: if numberOfTests is 0 but there are failures,
  // it means validation/compilation errors, so total = failures
  // Otherwise, total = numberOfTests (which already includes passed + failed)
  let totalTestsCount: number;
  if (summary.totalTestsInAllTables !== undefined) {
    // Use the total count from all test tables
    totalTestsCount = summary.totalTestsInAllTables;
  } else {
    totalTestsCount = totalTests === 0 && totalFailures > 0 
      ? totalFailures 
      : totalTests;
  }
  const passedCount = totalTestsCount - totalFailures;

  lines.push("## Summary");
  lines.push(`- **Total Tests**: ${totalTestsCount}`);
  lines.push(`- **Passed**: ${passedCount}`);
  lines.push(`- **Failed**: ${totalFailures}`);
  lines.push(`- **Execution Time**: ${executionTime.toFixed(2)} ms`);
  lines.push("");

  // Test cases table
  if (testCases.length > 0) {
    lines.push("## Test Cases");
    lines.push("");
    lines.push("| Table Name | Total Tests | Passed | Failed | Status | Execution Time (ms) |");
    lines.push("|------------|-------------|--------|--------|--------|---------------------|");

    for (const testCase of testCases) {
      const name = escapeTableCell(testCase.name || "N/A");
      const numberOfTests = testCase.numberOfTests || 0;
      const numberOfFailures = testCase.numberOfFailures || 0;
      
      // Calculate total tests: if numberOfTests is 0 but there are failures,
      // it means validation/compilation errors, so total = failures
      // Otherwise, total = numberOfTests (which already includes passed + failed)
      const totalTestsForCase = numberOfTests === 0 && numberOfFailures > 0 
        ? numberOfFailures 
        : numberOfTests;
      
      const passed = totalTestsForCase - numberOfFailures;
      const status = numberOfFailures === 0 ? "✅ PASSED" : "❌ FAILED";
      const execTime = (typeof testCase.executionTimeMs === 'number' && isFinite(testCase.executionTimeMs)
        ? testCase.executionTimeMs
        : 0).toFixed(2);

      lines.push(`| ${name} | ${totalTestsForCase} | ${passed} | ${numberOfFailures} | ${status} | ${execTime} |`);
    }
  } else {
    lines.push("No test cases found.");
  }

  return lines.join("\n");
}

/**
 * Format generic data as markdown
 */
function formatGeneric(data: any): string {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "No items found.";
    }
    return "```json\n" + safeStringify(data, 2) + "\n```";
  }

  if (typeof data === "object" && data !== null) {
    return "```json\n" + safeStringify(data, 2) + "\n```";
  }

  return String(data);
}

/**
 * Format pagination metadata as markdown
 */
function formatPagination(pagination: PaginationMetadata): string {
  const lines = [
    "---",
    "**Pagination**",
  ];

  // Handle empty results or undefined total_count
  const totalCount = pagination.total_count ?? 0;
  if (totalCount === 0) {
    lines.push("- Showing items 0-0 (No items)");
  } else {
    // Calculate start and end positions
    const start = pagination.offset + 1;
    const end = Math.min(pagination.offset + pagination.limit, totalCount);
    lines.push(`- Showing items ${start}-${end}`);
  }

  if (pagination.total_count !== undefined) {
    lines.push(`- Total: ${pagination.total_count}`);
  }

  if (pagination.has_more) {
    lines.push(`- More results available (next offset: ${pagination.next_offset})`);
  }

  return lines.join("\n");
}

/**
 * Helper function for client-side pagination
 *
 * @param results - Array of results to paginate
 * @param limit - Maximum items per page
 * @param offset - Starting position
 * @returns Paginated results with metadata
 */
export function paginateResults<T>(
  results: T[],
  limit: number,
  offset: number
): {
  data: T[];
  has_more: boolean;
  next_offset?: number | null;
  total_count: number;
} {
  const total_count = results.length;
  const data = results.slice(offset, offset + limit);
  const has_more = offset + limit < total_count;
  const next_offset = has_more ? offset + limit : null;

  return { data, has_more, next_offset, total_count };
}

/**
 * Fixed preamble for the aggregated AGENTS.md document. Explains the ordering and
 * the nearest-wins precedence so a consuming agent can apply the guidance correctly
 * from the document alone.
 */
export const AGENTS_DOCUMENT_NOTE =
  "*Important note about this document*\n" +
  "This is the aggregated content of all AGENTS.md files, ordered from the root folder to the project folder.\n" +
  "In case of conflicting instructions, each later AGENTS.md file takes precedence over the earlier ones. The root file has the lowest priority.";

/**
 * Render a project's applicable AGENTS.md files as a single markdown document.
 *
 * The input is the chain as returned by {@link OpenLClient.getProjectAgentsMd},
 * which is ordered nearest-first (project folder first). The document is emitted
 * root-first — repository root at the top (lowest priority), project folder at the
 * bottom (highest priority) — so a reader applies later sections over earlier ones.
 *
 * @param files - The applicable AGENTS.md files, nearest-first.
 * @returns A markdown document, or a short note when the project has none.
 */
export function formatAgentsDocument(files: Types.AgentsFile[]): string {
  if (files.length === 0) {
    return "No AGENTS.md files apply to this project.";
  }
  const rootFirst = [...files].reverse();
  const sections = rootFirst.map((file) => {
    const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
    // trimEnd so a file ending in newlines doesn't widen the gap before the next section.
    return `-----\n## ${path}\n\n${file.content.trimEnd()}`;
  });
  const document = `${AGENTS_DOCUMENT_NOTE}\n\n${sections.join("\n\n")}\n`;

  // Cap the aggregated document like every other response so a large monorepo
  // chain can't blow the client's token budget / response limits.
  const limit = RESPONSE_LIMITS.MAX_CHARACTERS;
  if (document.length > limit) {
    return `${document.slice(0, limit)}\n\n${RESPONSE_LIMITS.TRUNCATION_MESSAGE}`;
  }
  return document;
}
