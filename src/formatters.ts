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
  [key: string]: unknown;
  data: T;
  pagination?: PaginationMetadata;
  truncated?: boolean;
  truncation_message?: string;
}

const RESPONSE_WRAPPER_FIELDS = new Set([
  "data", "pagination", "truncated", "truncation_message",
]);

/**
 * Format response options
 */
interface FormatOptions {
  /** Pagination metadata */
  pagination?: {
    limit: number;
    offset: number;
    total?: number;
    hasMore?: boolean;
  };
  /** Backend fields returned alongside a collection page (for example list expansions). */
  responseMetadata?: Record<string, unknown>;
  /** Character limit (defaults to RESPONSE_LIMITS.MAX_CHARACTERS) */
  characterLimit?: number;
  /** Data type hint for markdown formatting */
  dataType?: string;
  /** Tool-specific context shown only in Markdown responses. */
  markdownContext?: Record<string, unknown>;
  /** Skip truncation for this response (useful for test results and other large data) */
  skipTruncation?: boolean;
}

/** Return the number of elements represented by one formatted page. */
function pageItemCount(data: unknown): number {
  if (Array.isArray(data)) {
    return data.length;
  }
  if (data && typeof data === "object") {
    const envelope = data as Record<string, unknown>;
    if (typeof envelope.numberOfElements === "number" && Number.isFinite(envelope.numberOfElements)) {
      return Math.max(0, envelope.numberOfElements);
    }
    if (Array.isArray(envelope.content)) {
      return envelope.content.length;
    }
  }
  return 1;
}

/** Keep backend metadata from overriding formatter-owned response fields. */
function withoutWrapperFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !RESPONSE_WRAPPER_FIELDS.has(key)),
  );
}

/** Extract non-wrapper fields that should remain visible in Markdown responses. */
function getResponseMetadata<T>(response: PaginatedResponse<T>): Record<string, unknown> {
  return withoutWrapperFields(response);
}

/** Build a bounded, valid-JSON preview when one response value cannot be sliced structurally. */
function truncateJsonPreview(response: PaginatedResponse<unknown>, charLimit: number): string {
  const serializedData = safeStringify(response.data, 2);
  const metadata: Record<string, unknown> = { ...response };
  delete metadata.data;
  delete metadata.truncated;
  delete metadata.truncation_message;
  const build = (previewLength: number, includeMetadata: boolean): string => safeStringify({
    ...(includeMetadata ? metadata : {}),
    data: {
      preview_format: "json",
      truncated_json_preview: serializedData.slice(0, previewLength),
    },
    truncated: true,
    truncation_message: RESPONSE_LIMITS.TRUNCATION_MESSAGE,
  }, 2);

  // Preserve small pagination/expansion metadata when it fits; otherwise the
  // bounded preview and truncation notice are more important than that metadata.
  const includeMetadata = build(0, true).length <= charLimit;
  let low = 0;
  let high = serializedData.length;
  let best = build(0, includeMetadata);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(middle, includeMetadata);
    if (candidate.length <= charLimit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (best.length <= charLimit) return best;
  const minimal = safeStringify({ truncated: true }, 2);
  return minimal.length <= charLimit ? minimal : "null";
}

/**
 * Format response data as JSON or Markdown (standard, concise, or detailed)
 *
 * @param data - Data to format
 * @param format - Output format: "json" (default structured format), "markdown" (human-readable full format),
 *                 "markdown_concise" (1-2 paragraph summary), "markdown_detailed" (full + context)
 * @param options - Formatting options
 * @returns Formatted response string
 */
export function formatResponse<T>(
  data: T,
  format: "json" | "markdown" | "markdown_concise" | "markdown_detailed" = "json",
  options?: FormatOptions
): string {
  // Create paginated response structure
  const response: PaginatedResponse<T> = {
    ...withoutWrapperFields(options?.responseMetadata ?? {}),
    data,
  };

  // Add pagination metadata if provided
  if (options && options.pagination) {
    const { limit, offset, total } = options.pagination;
    const count = pageItemCount(data);
    const has_more = options.pagination.hasMore ?? (total !== undefined && offset + count < total);
    response.pagination = {
      limit,
      offset,
      has_more,
      next_offset: has_more ? offset + limit : undefined,
      ...(total !== undefined ? { total_count: total } : {}),
    };
  }

  // Convert to string
  let formattedString: string;
  if (format === "json") {
    formattedString = safeStringify(response, 2);
  } else if (format === "markdown_concise") {
    formattedString = toMarkdownConcise(response, options?.dataType, options?.markdownContext);
  } else if (format === "markdown_detailed") {
    formattedString = toMarkdownDetailed(response, options?.dataType, options?.markdownContext);
  } else {
    // Standard markdown
    formattedString = toMarkdown(response, options?.dataType, options?.markdownContext);
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
              ...parsedResponse,
              data: parsedResponse.data.slice(0, itemCount),
              truncated: true,
              truncation_message: RESPONSE_LIMITS.TRUNCATION_MESSAGE,
            };
            result = safeStringify(truncatedWrapper, 2);
            if (result.length <= charLimit) break;
            itemCount = Math.max(1, Math.floor(itemCount * 0.8));
          } while (itemCount > 1);
          return result.length <= charLimit
            ? result
            : truncateJsonPreview(parsedResponse, charLimit);
        }
        return truncateJsonPreview(parsedResponse, charLimit);
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
  dataType?: string,
  markdownContext?: Record<string, unknown>,
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
    case "table_dependencies":
      parts.push(formatTableDependencies(data as Types.TableNodeView[], markdownContext));
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
    parts.push(formatPagination(response.pagination, pageItemCount(data)));
  }

  const metadata = getResponseMetadata(response);
  if (Object.keys(metadata).length > 0) {
    parts.push(`## Response Metadata\n\n${formatGeneric(metadata)}`);
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
  dataType?: string,
  markdownContext?: Record<string, unknown>,
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
    const total = response.pagination ? response.pagination.total_count : count;

    if (total === undefined) {
      parts.push(`Showing ${count} ${count === 1 ? 'item' : 'items'} on this page; the total count is unavailable.`);
      if (response.pagination && response.pagination.has_more) {
        parts.push(`Use offset=${response.pagination.next_offset} to retrieve more results.`);
      }
      const metadata = getResponseMetadata(response);
      if (Object.keys(metadata).length > 0) {
        parts.push(`Response metadata: ${safeStringify(metadata)}.`);
      }
      return parts.join(" ");
    }

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
      case "table_dependencies": {
        const nodes = data as Types.TableNodeView[];
        const edges = nodes.reduce((sum, node) => sum + (node.dependencies?.length ?? 0), 0);
        parts.push(`Dependency graph contains ${total} ${total === 1 ? "table" : "tables"} and ${edges} ${edges === 1 ? "dependency link" : "dependency links"}.`);
        const connectedNodes = nodes.filter(
          (node) => (node.dependencies?.length ?? 0) + (node.dependents?.length ?? 0) > 0,
        );
        const connected = connectedNodes
          .slice(0, 3)
          .map((node) => `${node.name ?? node.id ?? "unnamed"}: ${node.dependencies?.length ?? 0} dependencies, ${node.dependents?.length ?? 0} dependents`);
        if (connected.length > 0) {
          parts.push(`Connected tables: ${connected.join("; ")}${connectedNodes.length > connected.length ? "; …" : ""}.`);
        }
        const query = formatDependencyQuery(markdownContext, true);
        if (query) parts.push(query);
        break;
      }
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

  const metadata = getResponseMetadata(response);
  if (Object.keys(metadata).length > 0) {
    parts.push(`Response metadata: ${safeStringify(metadata)}.`);
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
  dataType?: string,
  markdownContext?: Record<string, unknown>,
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
    const total = response.pagination ? response.pagination.total_count : count;
    const title = dataType === "table_dependencies"
      ? "Table Dependency Graph"
      : dataType ? dataType.charAt(0).toUpperCase() + dataType.slice(1) : "Results";
    parts.push(`# ${title}`);
    parts.push(total === undefined
      ? `\n**Summary:** showing ${count} ${count === 1 ? 'item' : 'items'} on this page; total count unavailable`
      : `\n**Summary:** ${total} total ${total === 1 ? 'item' : 'items'}${count < total ? ` (showing ${count} on this page)` : ''}`);

    // Add timestamp
    parts.push(`**Retrieved:** ${new Date().toISOString()}`);
  }

  // Use standard markdown formatting (calls existing formatters)
  const standardMarkdown = toMarkdown(response, dataType, markdownContext);
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

function dependencyLabel(id: string, nodesById: ReadonlyMap<string, Types.TableNodeView>): string {
  const name = nodesById.get(id)?.name;
  return name ? `${String(name).replace(/\n/g, " ")} (\`${id}\`)` : `\`${id}\``;
}

function formatDependencyQuery(
  context: Record<string, unknown> | undefined,
  inline: boolean = false,
): string {
  if (!context) return "";
  const values: string[] = [];
  if (context.scope) values.push(`scope ${String(context.scope)}`);
  if (context.tableId) values.push(`root table \`${String(context.tableId)}\``);
  if (context.module) values.push(`module \`${String(context.module)}\``);
  if (context.direction) values.push(`direction ${String(context.direction)}`);
  if (context.depth !== undefined) values.push(`depth ${String(context.depth)}`);
  if (values.length === 0) return "";
  return inline ? `Query: ${values.join(", ")}.` : `**Query:** ${values.join(", ")}`;
}

/** Render graph edges explicitly instead of losing them in the flat table-list template. */
function formatTableDependencies(
  nodes: Types.TableNodeView[],
  context?: Record<string, unknown>,
): string {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return "# Table Dependency Graph\n\nNo tables found.";
  }

  const nodesById = new Map(
    nodes.flatMap((node) => node.id ? [[node.id, node] as const] : []),
  );
  const lines = ["# Table Dependency Graph"];
  const query = formatDependencyQuery(context);
  if (query) lines.push("", query);

  for (const node of nodes) {
    const name = String(node.name ?? node.id ?? "Unnamed table").replace(/\n/g, " ");
    const dependencies = node.dependencies?.map((id) => dependencyLabel(id, nodesById)).join(", ") || "None";
    const dependents = node.dependents?.map((id) => dependencyLabel(id, nodesById)).join(", ") || "None";
    lines.push("", `## ${name}`);
    if (node.id) lines.push(`- **Table ID:** \`${node.id}\``);
    if (node.tableType || node.kind) {
      lines.push(`- **Type:** ${node.tableType ?? "N/A"}${node.kind ? ` (${node.kind})` : ""}`);
    }
    if (node.project) lines.push(`- **Project:** ${node.project}`);
    if (node.file || node.pos) lines.push(`- **Location:** ${node.file ?? "N/A"}${node.pos ? ` at ${node.pos}` : ""}`);
    if (node.signature) lines.push(`- **Signature:** \`${node.signature}\``);
    if (node.returnType) lines.push(`- **Return type:** \`${node.returnType}\``);
    lines.push(`- **Depends on:** ${dependencies}`);
    lines.push(`- **Used by:** ${dependents}`);
    if (node.dimensionProperties && Object.keys(node.dimensionProperties).length > 0) {
      lines.push(`- **Dimension properties:** \`${safeStringify(node.dimensionProperties)}\``);
    }
    if (node.properties && Object.keys(node.properties).length > 0) {
      lines.push(`- **Properties:** \`${safeStringify(node.properties)}\``);
    }
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
function formatPagination(pagination: PaginationMetadata, pageCount: number): string {
  const lines = [
    "---",
    "**Pagination**",
  ];

  // Handle empty results or undefined total_count
  if (pageCount === 0) {
    lines.push("- Showing items 0-0 (No items)");
  } else {
    // Calculate start and end positions
    const start = pagination.offset + 1;
    const end = pagination.offset + pageCount;
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
 * Resolve pagination once for either a backend-paginated collection or a
 * legacy bare array. Backend pages are passed through untouched; bare arrays
 * are sliced locally for compatibility with older Studio versions.
 */
export function paginateCollection<T>(
  page: Types.CollectionPage<T>,
  limit: number,
  offset: number,
): {
  data: T[];
  pagination: { limit: number; offset: number; total?: number; hasMore: boolean };
} {
  if (!page.serverPaginated) {
    const paginated = paginateResults(page.items, limit, offset);
    return {
      data: paginated.data,
      pagination: {
        limit,
        offset,
        total: paginated.total_count,
        hasMore: paginated.has_more,
      },
    };
  }

  const pageLimit = page.pageSize ?? limit;
  // Current Studio collection endpoints accept a true item offset. Their
  // PageResponse may still expose a derived pageNumber (floor(offset / size)),
  // which cannot reconstruct a non-aligned requested offset. Preserve the
  // request value instead of replacing it with pageNumber * pageSize.
  const pageOffset = offset;
  const hasMore = page.total !== undefined
    ? pageOffset + page.items.length < page.total
    : page.totalPages !== undefined && page.pageNumber !== undefined
      ? page.pageNumber + 1 < page.totalPages
      : page.items.length === pageLimit;

  return {
    data: page.items,
    pagination: {
      limit: pageLimit,
      offset: pageOffset,
      total: page.total,
      hasMore,
    },
  };
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
 * The input is the chain as returned by {@link OpenLClient.getProjectAgentContext},
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
