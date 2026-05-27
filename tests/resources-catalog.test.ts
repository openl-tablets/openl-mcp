/**
 * Unit tests for the resource catalog + completion dispatcher.
 *
 * Verifies the spec-correct split between static `resources/list` entries
 * (concrete URIs only) and parameterized `resources/templates/list` entries
 * (`uriTemplate` with `{var}` placeholders), and that `completion/complete`
 * resolves `projectId` and `branch` arguments against the OpenL backend with
 * the correct prefix-filter + 100-cap semantics.
 */

import { describe, it, expect, jest } from "@jest/globals";

import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
  handleCompleteRequest,
  type CompleteRequestParams,
} from "../src/resources-catalog.js";
import type { OpenLClient } from "../src/client.js";
import type * as Types from "../src/types.js";

describe("STATIC_RESOURCES", () => {
  it("contains no `{var}` placeholders — those belong in templates", () => {
    for (const r of STATIC_RESOURCES) {
      expect(r.uri).not.toMatch(/\{[^}]+\}/);
    }
  });
  it("lists the three known singletons", () => {
    const uris = STATIC_RESOURCES.map((r) => r.uri).sort();
    expect(uris).toEqual([
      "openl://deployments",
      "openl://projects",
      "openl://repositories",
    ]);
  });
});

describe("RESOURCE_TEMPLATES", () => {
  it("uses `uriTemplate`, not `uri` (spec field name for templates)", () => {
    for (const t of RESOURCE_TEMPLATES) {
      expect(t).toHaveProperty("uriTemplate");
      expect(t).not.toHaveProperty("uri");
    }
  });
  it("every template contains at least one `{var}` placeholder", () => {
    for (const t of RESOURCE_TEMPLATES) {
      expect(t.uriTemplate).toMatch(/\{[^}]+\}/);
    }
  });
  it("exposes both status variants — default-branch and explicit-branch", () => {
    const uris = RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
    expect(uris).toContain("openl://status/{projectId}");
    expect(uris).toContain("openl://status/{projectId}/{branch}");
  });
});

function makeProject(id: string, branch?: string, repo = "design-repo"): Types.ProjectSummary {
  return {
    id,
    name: id,
    repository: repo,
    branch,
    path: `/${id}`,
    status: "OPENED" as Types.ProjectStatus,
    modifiedBy: "test",
    modifiedAt: "2026-01-01",
  };
}

interface FakeClient {
  listProjects: jest.Mock<() => Promise<Types.ProjectSummary[]>>;
  getProject: jest.Mock<(id: string) => Promise<Types.ComprehensiveProject>>;
  listBranches: jest.Mock<(repo: string) => Promise<string[]>>;
}

function makeClient(opts: {
  projects?: Types.ProjectSummary[];
  branches?: string[];
  getProjectError?: Error;
  listProjectsError?: Error;
  listBranchesError?: Error;
}): { client: OpenLClient; fakes: FakeClient } {
  const fakes: FakeClient = {
    listProjects: jest.fn<() => Promise<Types.ProjectSummary[]>>().mockImplementation(async () => {
      if (opts.listProjectsError) throw opts.listProjectsError;
      return opts.projects ?? [];
    }),
    getProject: jest
      .fn<(id: string) => Promise<Types.ComprehensiveProject>>()
      .mockImplementation(async (id: string) => {
        if (opts.getProjectError) throw opts.getProjectError;
        const p = (opts.projects ?? []).find((x) => x.id === id);
        if (!p) throw new Error(`unknown project ${id}`);
        return p as Types.ComprehensiveProject;
      }),
    listBranches: jest
      .fn<(repo: string) => Promise<string[]>>()
      .mockImplementation(async () => {
        if (opts.listBranchesError) throw opts.listBranchesError;
        return opts.branches ?? [];
      }),
  };
  return { client: fakes as unknown as OpenLClient, fakes };
}

describe("handleCompleteRequest — projectId", () => {
  const ref: CompleteRequestParams["ref"] = {
    type: "ref/resource",
    uri: "openl://status/{projectId}",
  };

  it("returns all projects when the typed value is empty", async () => {
    const { client } = makeClient({ projects: [makeProject("alpha"), makeProject("beta")] });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "projectId", value: "" },
    });
    expect(res.completion.values).toEqual(["alpha", "beta"]);
    expect(res.completion.total).toBe(2);
    expect(res.completion.hasMore).toBe(false);
  });

  it("filters by case-insensitive prefix", async () => {
    const { client } = makeClient({
      projects: [makeProject("Alpha"), makeProject("Apricot"), makeProject("Beta")],
    });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "projectId", value: "ap" },
    });
    expect(res.completion.values).toEqual(["Apricot"]);
    expect(res.completion.total).toBe(1);
  });

  it("caps values at 100 and sets hasMore=true past the cap", async () => {
    const projects = Array.from({ length: 150 }, (_, i) =>
      makeProject(`proj-${i.toString().padStart(3, "0")}`),
    );
    const { client } = makeClient({ projects });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "projectId", value: "proj-" },
    });
    expect(res.completion.values).toHaveLength(100);
    expect(res.completion.total).toBe(150);
    expect(res.completion.hasMore).toBe(true);
  });

  it("formats legacy object IDs as `repository/projectName`", async () => {
    const projects: Types.ProjectSummary[] = [
      {
        ...makeProject("ignored"),
        id: { repository: "design-repo", projectName: "Legacy Project" },
      },
    ];
    const { client } = makeClient({ projects });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "projectId", value: "" },
    });
    expect(res.completion.values).toEqual(["design-repo/Legacy Project"]);
  });

  it("returns empty for unknown template URIs (don't leak project list)", async () => {
    const { client, fakes } = makeClient({ projects: [makeProject("alpha")] });
    const res = await handleCompleteRequest(client, {
      ref: { type: "ref/resource", uri: "openl://other/{foo}" },
      argument: { name: "projectId", value: "" },
    });
    expect(res.completion.values).toEqual([]);
    expect(fakes.listProjects).not.toHaveBeenCalled();
  });

  it("returns empty when the backend throws (autocomplete must never surface red errors)", async () => {
    const { client } = makeClient({ listProjectsError: new Error("studio is down") });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "projectId", value: "" },
    });
    expect(res.completion.values).toEqual([]);
    expect(res.completion.total).toBe(0);
  });
});

describe("handleCompleteRequest — branch", () => {
  const ref: CompleteRequestParams["ref"] = {
    type: "ref/resource",
    uri: "openl://status/{projectId}/{branch}",
  };

  it("returns branches for the project in context.arguments.projectId", async () => {
    const { client, fakes } = makeClient({
      projects: [makeProject("alpha", "main", "design-repo")],
      branches: ["main", "develop", "feature/x"],
    });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "branch", value: "" },
      context: { arguments: { projectId: "alpha" } },
    });
    expect(res.completion.values).toEqual(["main", "develop", "feature/x"]);
    expect(fakes.getProject).toHaveBeenCalledWith("alpha");
    expect(fakes.listBranches).toHaveBeenCalledWith("design-repo");
  });

  it("filters branches by prefix", async () => {
    const { client } = makeClient({
      projects: [makeProject("alpha", "main", "design-repo")],
      branches: ["main", "master", "develop"],
    });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "branch", value: "ma" },
      context: { arguments: { projectId: "alpha" } },
    });
    expect(res.completion.values).toEqual(["main", "master"]);
  });

  it("returns empty when context.arguments.projectId is missing", async () => {
    const { client, fakes } = makeClient({ branches: ["main"] });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "branch", value: "" },
    });
    expect(res.completion.values).toEqual([]);
    expect(fakes.getProject).not.toHaveBeenCalled();
    expect(fakes.listBranches).not.toHaveBeenCalled();
  });

  it("returns empty when getProject throws (e.g., projectId is junk)", async () => {
    const { client } = makeClient({ getProjectError: new Error("404") });
    const res = await handleCompleteRequest(client, {
      ref,
      argument: { name: "branch", value: "" },
      context: { arguments: { projectId: "ghost" } },
    });
    expect(res.completion.values).toEqual([]);
  });

  it("returns empty for the default-branch status template (no {branch} to complete)", async () => {
    const { client, fakes } = makeClient({
      projects: [makeProject("alpha", "main", "design-repo")],
      branches: ["main"],
    });
    const res = await handleCompleteRequest(client, {
      ref: { type: "ref/resource", uri: "openl://status/{projectId}" },
      argument: { name: "branch", value: "" },
      context: { arguments: { projectId: "alpha" } },
    });
    expect(res.completion.values).toEqual([]);
    expect(fakes.listBranches).not.toHaveBeenCalled();
  });
});

describe("handleCompleteRequest — unsupported refs", () => {
  it("returns empty for prompt refs (not implemented)", async () => {
    const { client, fakes } = makeClient({ projects: [makeProject("alpha")] });
    const res = await handleCompleteRequest(client, {
      ref: { type: "ref/prompt", name: "any" },
      argument: { name: "projectId", value: "" },
    });
    expect(res.completion.values).toEqual([]);
    expect(fakes.listProjects).not.toHaveBeenCalled();
  });

  it("returns empty for unknown argument names on a known template", async () => {
    const { client, fakes } = makeClient({ projects: [makeProject("alpha")] });
    const res = await handleCompleteRequest(client, {
      ref: { type: "ref/resource", uri: "openl://status/{projectId}" },
      argument: { name: "tableId", value: "" },
    });
    expect(res.completion.values).toEqual([]);
    expect(fakes.listProjects).not.toHaveBeenCalled();
  });
});
