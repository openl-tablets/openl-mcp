/**
 * Single source of truth for the MCP server's resource catalog.
 *
 * MCP distinguishes two resource shapes:
 *
 * - **Static resources** — concrete URIs returned from `resources/list`. The
 *   client treats the `uri` literally; there's no parameter substitution. Use
 *   for true singletons (`openl://repositories`, `openl://projects`).
 *
 * - **Resource templates** — RFC 6570 URI templates returned from
 *   `resources/templates/list` under the field name `uriTemplate`. The client
 *   collects values for each `{var}` (via UI prompt, completion, or
 *   programmatic substitution) and then issues a normal `resources/read` /
 *   `resources/subscribe` with the resulting concrete URI. Use for anything
 *   parameterized — `openl://projects/{projectId}`, `openl://status/{projectId}`,
 *   `openl://status/{projectId}/{branch}`, etc.
 *
 * Older versions of this server listed templated URIs in `resources/list` with
 * literal `{var}` segments, which is spec-incorrect: strict clients would
 * either treat the URI as a literal (404 on read) or hide it from the picker.
 *
 * This module also implements `completion/complete` for resource templates:
 * when the client asks "what values can `projectId` take?" we hit the OpenL
 * backend (`client.listProjects()`), filter by the typed-so-far prefix, and
 * return up to 100 values per the spec cap. `{branch}` completion uses the
 * `context.arguments.projectId` the client passes alongside (per the
 * `CompleteRequestParamsSchema.context.arguments` field) to resolve the
 * project's repository and list its branches.
 */

import type { Resource, ResourceTemplate, CompleteResult } from "@modelcontextprotocol/sdk/types.js";

import type { OpenLClient } from "./client.js";
import type * as Types from "./types.js";
import { sanitizeError } from "./utils.js";

/**
 * Resources whose URI is fully concrete — no `{var}` segments. The client
 * treats these literally; they show up in the resource picker as one-click
 * attachable items.
 */
export const STATIC_RESOURCES: Resource[] = [
  {
    uri: "openl://repositories",
    name: "OpenL Repositories",
    description: "All design repositories in OpenL Studio",
    mimeType: "application/json",
  },
  {
    uri: "openl://projects",
    name: "OpenL Projects",
    description: "All projects across all repositories",
    mimeType: "application/json",
  },
  {
    uri: "openl://deployments",
    name: "OpenL Deployments",
    description: "All deployment repositories and deployed projects",
    mimeType: "application/json",
  },
];

/**
 * RFC 6570 URI templates exposed via `resources/templates/list`. Each `{var}`
 * is filled in by the client (with help from `completion/complete`) before
 * the resulting concrete URI is sent to `resources/read` or
 * `resources/subscribe`.
 */
export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: "openl://projects/{projectId}",
    name: "OpenL Project Details",
    description: "Get details for a specific project (use projectId from openl_list_projects)",
    mimeType: "application/json",
  },
  {
    uriTemplate: "openl://projects/{projectId}/tables",
    name: "Project Tables",
    description: "List all tables in a project",
    mimeType: "application/json",
  },
  {
    uriTemplate: "openl://projects/{projectId}/tables/{tableId}",
    name: "Table Details",
    description: "Get details for a specific table",
    mimeType: "application/json",
  },
  {
    uriTemplate: "openl://projects/{projectId}/history",
    name: "Project History",
    description: "Get Git commit history for a project",
    mimeType: "application/json",
  },
  {
    uriTemplate: "openl://projects/{projectId}/files/{filePath}",
    name: "Project File",
    description: "Download a file from a project",
    mimeType: "application/octet-stream",
  },
  {
    uriTemplate: "openl://status/{projectId}",
    name: "OpenL Project Status (default branch)",
    description:
      "Post-compilation project status (compile state, diagnostics, pending changes) using the project's currently opened branch. Use this variant for non-branch repositories and repository 'local'. Supports resources/subscribe — emits notifications/resources/updated when the studio publishes a status change on its STOMP topic.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "openl://status/{projectId}/{branch}",
    name: "OpenL Project Status (specific branch)",
    description:
      "Post-compilation project status for a specific branch. Branch must match a branch the project supports. Supports resources/subscribe.",
    mimeType: "application/json",
  },
];

/** MCP `completion/complete` result cap per spec — never return more than 100 values. */
const MAX_COMPLETION_VALUES = 100;

/**
 * Templates that take a `projectId` argument. Listed so we can answer
 * `completion/complete` for `projectId` from `client.listProjects()`.
 */
const PROJECT_ID_TEMPLATES = new Set<string>([
  "openl://projects/{projectId}",
  "openl://projects/{projectId}/tables",
  "openl://projects/{projectId}/tables/{tableId}",
  "openl://projects/{projectId}/history",
  "openl://projects/{projectId}/files/{filePath}",
  "openl://status/{projectId}",
  "openl://status/{projectId}/{branch}",
]);

/** Templates that take a `branch` argument (resolved against the project's repo). */
const BRANCH_TEMPLATES = new Set<string>([
  "openl://status/{projectId}/{branch}",
]);

/**
 * Coerce a `ProjectSummary.id` (string | ProjectId) into the string form
 * MCP resource URIs use. Legacy servers may return the object shape; we
 * format it as `repository/projectName` to match the addressing convention.
 */
function projectIdToString(id: string | Types.ProjectId): string {
  if (typeof id === "string") return id;
  return `${id.repository}/${id.projectName}`;
}

/**
 * Case-insensitive prefix filter that preserves the source ordering.
 * Returns at most `MAX_COMPLETION_VALUES + 1` so callers can detect overflow
 * without scanning the entire input list.
 */
function filterByPrefix(values: readonly string[], prefix: string): {
  matched: string[];
  truncated: boolean;
  totalMatches: number;
} {
  const needle = prefix.toLowerCase();
  const matched: string[] = [];
  let totalMatches = 0;
  for (const v of values) {
    if (!v.toLowerCase().startsWith(needle)) continue;
    totalMatches++;
    if (matched.length < MAX_COMPLETION_VALUES) {
      matched.push(v);
    }
  }
  return {
    matched,
    truncated: totalMatches > MAX_COMPLETION_VALUES,
    totalMatches,
  };
}

/** Empty completion result — used for unknown templates, unknown arguments, or backend failures. */
const EMPTY_COMPLETION: CompleteResult = {
  completion: { values: [], total: 0, hasMore: false },
};

/**
 * Shape of the `completion/complete` request params, narrowed to the only
 * `ref` type we serve (resource templates). Prompt completion is not yet
 * implemented — those requests fall through to the empty result.
 */
export interface CompleteRequestParams {
  ref:
    | { type: "ref/prompt"; name: string }
    | { type: "ref/resource"; uri: string };
  argument: { name: string; value: string };
  context?: { arguments?: Record<string, string> };
}

/**
 * Dispatch a `completion/complete` request against the OpenL backend.
 *
 * Pure-ish: takes the client + params, returns the result. Catches all
 * backend errors and returns the empty completion so a slow or down studio
 * doesn't make autocomplete look broken.
 */
export async function handleCompleteRequest(
  client: OpenLClient,
  params: CompleteRequestParams,
): Promise<CompleteResult> {
  // Prompt completion isn't implemented — return empty for `ref/prompt`.
  if (params.ref.type !== "ref/resource") {
    return EMPTY_COMPLETION;
  }

  const templateUri = params.ref.uri;
  const argName = params.argument.name;
  const typed = params.argument.value;

  try {
    if (argName === "projectId" && PROJECT_ID_TEMPLATES.has(templateUri)) {
      const projects = await client.listProjects();
      const ids = projects.map((p) => projectIdToString(p.id));
      return buildResult(filterByPrefix(ids, typed));
    }

    if (argName === "branch" && BRANCH_TEMPLATES.has(templateUri)) {
      const projectId = params.context?.arguments?.projectId;
      if (!projectId) {
        // Branch list depends on which project the user picked; without it
        // we can't query. Spec-compliant behavior: return empty.
        return EMPTY_COMPLETION;
      }
      const project = await client.getProject(projectId);
      const repo = project.repository;
      if (!repo) return EMPTY_COMPLETION;
      const branches = await client.listBranches(repo);
      return buildResult(filterByPrefix(branches, typed));
    }
  } catch (err) {
    // Backend errors during autocomplete should be silent — log on stderr so
    // they're visible in container logs, but never throw to the MCP client
    // (which would surface as a red error banner in the picker).
    console.error(
      `[ResourcesCatalog] completion failed for ref=${templateUri} arg=${argName}: ${sanitizeError(err)}`,
    );
  }

  return EMPTY_COMPLETION;
}

function buildResult(filtered: {
  matched: string[];
  truncated: boolean;
  totalMatches: number;
}): CompleteResult {
  return {
    completion: {
      values: filtered.matched,
      total: filtered.totalMatches,
      hasMore: filtered.truncated,
    },
  };
}
