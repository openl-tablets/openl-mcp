/**
 * Integration tests for MCP tool handlers.
 * Verifies tools through executeTool() with mocked OpenL client HTTP calls.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { OpenLClient } from "../src/client.js";
import { executeTool, registerAllTools } from "../src/tool-handlers.js";
import type { OpenLConfig, RepositoryInfo, ProjectViewModel, SummaryTableView, ProjectStatusView } from "../src/types.js";
import {
  mockRepositories,
  mockProjects,
  mockDecisionTable,
  mockTables,
  mockDeployments,
  mockBranches,
} from "./mocks/openl-api-mocks.js";

const projectId = "design:insurance-rules:hash123";
const encodeProjectPath = (id: string): string => encodeURIComponent(id);

describe("MCP Server Tools", () => {
  let client: OpenLClient;
  let mockAxios: MockAdapter;
  let server: Server;

  beforeAll(() => {
    const config: OpenLConfig = {
      baseUrl: "http://localhost:8080",
      username: "admin",
      password: "admin",
    };

    client = new OpenLClient(config);
    // @ts-ignore Access private axios instance for mocking in integration tests
    mockAxios = new MockAdapter(client.axiosInstance);

    server = new Server({ name: "test-server", version: "1.0.0" }, { capabilities: {} });
    registerAllTools(server, client);
  });

  beforeEach(() => {
    mockAxios.reset();
  });

  afterAll(() => {
    mockAxios.restore();
  });

  it("should execute openl_list_repositories", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);

    const result = await executeTool("openl_list_repositories", { response_format: "json" }, client);
    expect(result.content[0].text).toContain("Design Repository");
  });

  it("should execute openl_list_projects", async () => {
    const repos: RepositoryInfo[] = [{ id: "design", name: "Design Repository", aclId: "acl-design" }];
    mockAxios.onGet("/repos").reply(200, repos);
    const projectsWithStringIds = (mockProjects as ProjectViewModel[]).map((project) => ({
      ...project,
      id: projectId,
    }));
    mockAxios.onGet("/projects", { params: { repository: "design", page: 0, size: 50 } }).reply(200, projectsWithStringIds);

    const result = await executeTool(
      "openl_list_projects",
      { repository: "Design Repository", response_format: "json" },
      client
    );
    expect(result.content[0].text).toContain("insurance-rules");
  });

  it("should execute openl_get_project", async () => {
    const encoded = encodeProjectPath(projectId);
    const project = mockProjects[0] as ProjectViewModel;
    mockAxios.onGet(`/projects/${encoded}`).reply(200, project);

    const result = await executeTool("openl_get_project", { projectId }, client);
    expect(result.content[0].text).toContain("insurance-rules");
  });

  it("should execute openl_project_status and surface diagnostics on errors", async () => {
    const encoded = encodeProjectPath(projectId);
    const fixture: ProjectStatusView = {
      projectId: { repository: "design", projectName: "insurance-rules" },
      branch: "main",
      compileState: "errors",
      compilation: {
        messages: {
          items: [
            { id: 1, summary: "Datatype 'Driver' not found", severity: "ERROR" },
          ],
          total: 1,
          errors: 1,
          warnings: 0,
        },
        modules: { total: 1, compiled: 0 },
        tests: { total: 0 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, response_format: "json" },
      client
    );
    expect(result.content[0].text).toContain("\"errors\"");
    expect(result.content[0].text).toContain("Datatype 'Driver' not found");
  });

  it("should trim messages.items when compileState is ok", async () => {
    const encoded = encodeProjectPath(projectId);
    // Backend may return INFO items even when compilation succeeds; the handler should
    // strip the items[] list while preserving the counts.
    const fixture: ProjectStatusView = {
      projectId: { repository: "design", projectName: "insurance-rules" },
      branch: "main",
      compileState: "ok",
      compilation: {
        messages: {
          items: [
            { id: 1, summary: "INFO_ITEM_SHOULD_BE_TRIMMED", severity: "INFO" },
          ],
          total: 1,
          errors: 0,
          warnings: 0,
        },
        modules: { total: 2, compiled: 2, compiledModules: ["A", "B"] },
        tests: { total: 7 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, response_format: "json" },
      client
    );
    expect(result.content[0].text).toContain("\"ok\"");
    expect(result.content[0].text).not.toContain("INFO_ITEM_SHOULD_BE_TRIMMED");
    // Counts and module info are preserved
    expect(result.content[0].text).toContain("\"compiled\": 2");
    expect(result.content[0].text).toContain("\"total\": 7");
  });

  it("should pass branch through to the status endpoint", async () => {
    const encoded = encodeProjectPath(projectId);
    mockAxios.onGet(`/projects/${encoded}/status`).reply((config) => {
      if (config.params?.branch === "develop") {
        return [200, {
          projectId,
          branch: "develop",
          compileState: "ok",
          compilation: {
            messages: { items: [], total: 0, errors: 0, warnings: 0 },
            modules: { total: 1, compiled: 1 },
            tests: { total: 0 },
          },
        } as ProjectStatusView];
      }
      return [409, { message: "branch.mismatch" }];
    });

    const result = await executeTool(
      "openl_project_status",
      { projectId, branch: "develop", response_format: "json" },
      client
    );
    expect(result.content[0].text).toContain("\"ok\"");
  });

  it("should validate projectId for openl_project_status", async () => {
    await expect(executeTool("openl_project_status", {}, client)).rejects.toThrow(/projectId/);
  });

  it("should sort compilation.messages.items by severity (ERROR → WARN → INFO)", async () => {
    const encoded = encodeProjectPath(projectId);
    // Backend returns items in id-ascending order — WARNs first, then ERRORs.
    const fixture: ProjectStatusView = {
      projectId,
      branch: "master",
      compileState: "errors",
      compilation: {
        messages: {
          items: [
            { id: 1, summary: "WARN_FIRST", severity: "WARN" },
            { id: 2, summary: "INFO_SECOND", severity: "INFO" },
            { id: 3, summary: "ERROR_THIRD", severity: "ERROR" },
            { id: 4, summary: "WARN_FOURTH", severity: "WARN" },
            { id: 5, summary: "ERROR_FIFTH", severity: "ERROR" },
          ],
          total: 5, errors: 2, warnings: 2,
        },
        modules: { total: 1, compiled: 0 },
        tests: { total: 0 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, response_format: "json" },
      client,
    );
    const text = result.content[0].text;
    // ERRORs should appear before WARNs/INFO in the serialized output.
    const errorThirdAt = text.indexOf("ERROR_THIRD");
    const errorFifthAt = text.indexOf("ERROR_FIFTH");
    const warnFirstAt = text.indexOf("WARN_FIRST");
    const infoSecondAt = text.indexOf("INFO_SECOND");
    expect(errorThirdAt).toBeGreaterThan(-1);
    expect(errorFifthAt).toBeGreaterThan(-1);
    expect(errorThirdAt).toBeLessThan(warnFirstAt);
    expect(errorFifthAt).toBeLessThan(warnFirstAt);
    expect(warnFirstAt).toBeLessThan(infoSecondAt);
  });

  it("should filter compilation.messages.items by severity when 'severity' is passed", async () => {
    const encoded = encodeProjectPath(projectId);
    const fixture: ProjectStatusView = {
      projectId,
      branch: "master",
      compileState: "errors",
      compilation: {
        messages: {
          items: [
            { id: 1, summary: "WARN_X", severity: "WARN" },
            { id: 2, summary: "ERROR_X", severity: "ERROR" },
            { id: 3, summary: "INFO_X", severity: "INFO" },
          ],
          total: 3, errors: 1, warnings: 1,
        },
        modules: { total: 1, compiled: 0 },
        tests: { total: 0 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, severity: ["ERROR"], response_format: "json" },
      client,
    );
    const text = result.content[0].text;
    expect(text).toContain("ERROR_X");
    expect(text).not.toContain("WARN_X");
    expect(text).not.toContain("INFO_X");
  });

  it("should cap items with maxMessages after sorting", async () => {
    const encoded = encodeProjectPath(projectId);
    const fixture: ProjectStatusView = {
      projectId,
      branch: "master",
      compileState: "errors",
      compilation: {
        messages: {
          items: [
            { id: 1, summary: "WARN_A", severity: "WARN" },
            { id: 2, summary: "ERROR_B", severity: "ERROR" },
            { id: 3, summary: "WARN_C", severity: "WARN" },
            { id: 4, summary: "ERROR_D", severity: "ERROR" },
          ],
          total: 4, errors: 2, warnings: 2,
        },
        modules: { total: 1, compiled: 0 },
        tests: { total: 0 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, maxMessages: 2, response_format: "json" },
      client,
    );
    const text = result.content[0].text;
    // After sort: [ERROR_B, ERROR_D, WARN_A, WARN_C]. maxMessages=2 keeps the first two.
    expect(text).toContain("ERROR_B");
    expect(text).toContain("ERROR_D");
    expect(text).not.toContain("WARN_A");
    expect(text).not.toContain("WARN_C");
  });

  it("should short-circuit openl_project_status wait=true when the initial state is already terminal", async () => {
    // When the very first HTTP fetch returns a terminal compileState, waitForCompilation
    // returns immediately without ever opening a STOMP subscription.
    const encoded = encodeProjectPath(projectId);
    const fixture: ProjectStatusView = {
      projectId: { repository: "design", projectName: "insurance-rules" },
      branch: "main",
      compileState: "errors",
      compilation: {
        messages: {
          items: [{ id: 7, summary: "Datatype 'Foo' not found", severity: "ERROR" }],
          total: 1,
          errors: 1,
          warnings: 0,
        },
        modules: { total: 1, compiled: 0 },
        tests: { total: 0 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, wait: true, response_format: "json" },
      client,
    );
    expect(result.content[0].text).toContain("\"errors\"");
    expect(result.content[0].text).toContain("Datatype 'Foo' not found");
    // Exactly one HTTP fetch — terminal short-circuit means no race-close fetch, no STOMP.
    const statusCalls = mockAxios.history.get.filter((req) => req.url?.endsWith("/status"));
    expect(statusCalls).toHaveLength(1);
  });

  it("should apply the ok-state items trim when wait=true short-circuits with compileState=ok", async () => {
    const encoded = encodeProjectPath(projectId);
    const fixture: ProjectStatusView = {
      projectId: { repository: "design", projectName: "insurance-rules" },
      branch: "main",
      compileState: "ok",
      compilation: {
        messages: {
          items: [{ id: 1, summary: "INFO_SHOULD_BE_TRIMMED", severity: "INFO" }],
          total: 1,
          errors: 0,
          warnings: 0,
        },
        modules: { total: 3, compiled: 3, compiledModules: ["A", "B", "C"] },
        tests: { total: 4 },
      },
    };
    mockAxios.onGet(`/projects/${encoded}/status`).reply(200, fixture);

    const result = await executeTool(
      "openl_project_status",
      { projectId, wait: true, response_format: "json" },
      client,
    );
    expect(result.content[0].text).toContain("\"ok\"");
    expect(result.content[0].text).not.toContain("INFO_SHOULD_BE_TRIMMED");
    expect(result.content[0].text).toContain("\"compiled\": 3");
  });

  it("should execute openl_open_project", async () => {
    const encoded = encodeProjectPath(projectId);
    mockAxios.onGet(`/projects/${encoded}`).reply(200, {
      id: "design:insurance-rules:hash123",
      name: "insurance-rules",
      repository: "design",
      status: "CLOSED",
      path: "insurance-rules",
      modifiedBy: "admin",
      modifiedAt: "2024-01-01T00:00:00Z",
    });
    mockAxios.onPatch(`/projects/${encoded}`, { status: "OPENED" }).reply(204);

    const result = await executeTool("openl_open_project", { projectId }, client);
    expect(result.content[0].text).toContain("opened");
  });

  it("should execute openl_list_tables", async () => {
    const encoded = encodeProjectPath(projectId);
    mockAxios.onGet(`/projects/${encoded}/tables`).reply(200, mockTables);

    const result = await executeTool("openl_list_tables", { projectId }, client);
    expect(result.content[0].text).toContain("Rules.xls_1234");
  });

  it("should execute openl_get_table", async () => {
    const encoded = encodeProjectPath(projectId);
    const tableId = "Rules.xls_1234";
    mockAxios.onGet(`/projects/${encoded}/tables/${encodeURIComponent(tableId)}`).reply(200, mockDecisionTable);

    const result = await executeTool(
      "openl_get_table",
      { projectId, tableId },
      client
    );
    expect(result.content[0].text).toContain("Rules.xls_1234");
  });

  it("should execute openl_update_table", async () => {
    const encoded = encodeProjectPath(projectId);
    const view = {
      ...mockDecisionTable,
      id: "Rules.xls_1234",
      tableType: "SimpleRules",
      kind: "Rules",
      name: "calculatePremium",
    };
    mockAxios.onPut(`/projects/${encoded}/tables/${encodeURIComponent("Rules.xls_1234")}`).reply(204);

    const result = await executeTool(
      "openl_update_table",
      { projectId, tableId: "Rules.xls_1234", view },
      client
    );
    expect(result.content[0].text).toContain("Successfully updated table");
  });

  it("should execute openl_append_table", async () => {
    const encoded = encodeProjectPath(projectId);
    const appendData = {
      tableType: "Datatype",
      fields: [{ name: "email", type: "String", required: true }],
    };
    mockAxios
      .onPost(`/projects/${encoded}/tables/${encodeURIComponent("Customer_1234")}/lines`, appendData)
      .reply(200);

    const result = await executeTool(
      "openl_append_table",
      { projectId, tableId: "Customer_1234", appendData },
      client
    );
    expect(result.content[0].text).toContain("Successfully appended");
  });

  it("should execute openl_append_table with RawSource and report row count", async () => {
    const encoded = encodeProjectPath(projectId);
    const appendData = {
      tableType: "RawSource",
      rows: [
        [{ value: "A1" }, { value: "B1" }],
        [{ value: "A2" }, { value: "B2" }],
      ],
    };
    mockAxios
      .onPost(`/projects/${encoded}/tables/${encodeURIComponent("RawTable_5678")}/lines`, appendData)
      .reply(200);

    const result = await executeTool(
      "openl_append_table",
      { projectId, tableId: "RawTable_5678", appendData },
      client
    );
    expect(result.content[0].text).toContain("Successfully appended 2 row(s)");
  });

  it("should execute openl_list_branches", async () => {
    const repos: RepositoryInfo[] = [{ id: "design", name: "Design Repository", aclId: "acl-design" }];
    mockAxios.onGet("/repos").reply(200, repos);
    mockAxios.onGet("/repos/design/branches").reply(200, mockBranches);

    const result = await executeTool("openl_list_branches", { repository: "Design Repository" }, client);
    expect(result.content[0].text).toContain("main");
  });

  it("should execute openl_create_project_branch", async () => {
    const encoded = encodeProjectPath(projectId);
    mockAxios.onPost(`/projects/${encoded}/branches`, { branch: "feature/test-branch" }).reply(200);

    const result = await executeTool(
      "openl_create_project_branch",
      { projectId, branchName: "feature/test-branch" },
      client
    );
    expect(result.content[0].text).toContain("Successfully created branch");
  });

  it("should execute openl_list_deployments", async () => {
    mockAxios.onGet("/deployments").reply(200, mockDeployments);

    const result = await executeTool("openl_list_deployments", {}, client);
    expect(result.content[0].text).toContain("# Deployments");
  });

  it("should execute openl_deploy_project", async () => {
    const deployRepos = [{ id: "production", name: "Production Repository", aclId: "acl-prod" }];
    mockAxios.onGet("/production-repos").reply(200, deployRepos);
    mockAxios.onPost("/deployments").reply(200);

    const result = await executeTool(
      "openl_deploy_project",
      {
        projectId,
        deploymentName: "insurance-rules",
        productionRepositoryId: "Production Repository",
      },
      client
    );
    expect(result.content[0].text).toContain("Successfully deployed");
  });

  it("should validate required params via handlers", async () => {
    await expect(executeTool("openl_get_project", {}, client)).rejects.toThrow(/projectId/);
  });

  // ---------------------------------------------------------------------------
  // Project Creation & Cloning
  // ---------------------------------------------------------------------------

  it("should create an empty project and return the commit revision", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPut("/repos/design/projects/Offer-CW").reply(200, { revision: "abc123", branch: "main" });

    const result = await executeTool(
      "openl_create_project",
      { repository: "Design Repository", projectName: "Offer-CW", response_format: "json" },
      client
    );

    expect(result.content[0].text).toContain("abc123");
    expect(result.content[0].text).toContain("Offer-CW");
  });

  it("should reject openl_create_project on name collision (409)", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPut("/repos/design/projects/Existing").reply(409, { message: "duplicated.project.message" });

    await expect(
      executeTool("openl_create_project", { repository: "design", projectName: "Existing" }, client)
    ).rejects.toThrow(/already exists/i);
  });

  it("should reject a blank create when a branch is requested", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    await expect(
      executeTool("openl_create_project", { repository: "design", projectName: "Offer-CW", branch: "dev" }, client)
    ).rejects.toThrow(/branch is only supported when cloning/i);
  });

  it("should clone a project (template), rename rules.xml, and return the revision", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPost("/repos/design/file-copy").reply(201);
    mockAxios
      .onGet("/repos/design/files/Offer-CW/rules.xml")
      .reply(200, "<project>\n  <name>Offer-US</name>\n  <modules>\n    <module><name>Main</name></module>\n  </modules>\n</project>");
    mockAxios.onPut("/repos/design/files/Offer-CW/rules.xml").reply(200);
    mockAxios.onGet("/repos/design/projects/Offer-CW/history").reply(200, { content: [{ revisionNo: "def456" }] });

    const result = await executeTool(
      "openl_create_project",
      { repository: "design", template: "Offer-US", projectName: "Offer-CW", response_format: "json" },
      client
    );

    expect(result.content[0].text).toContain("Cloned");
    expect(result.content[0].text).toContain("def456");

    // rules.xml project name rewritten to the new name; module name left untouched.
    const putReq = mockAxios.history.put.find((p) => p.url === "/repos/design/files/Offer-CW/rules.xml");
    const body = String(putReq?.data);
    expect(body).toContain("<name>Offer-CW</name>");
    expect(body).toContain("<module><name>Main</name></module>");
  });

  it("should clone a descriptor-less project without attempting a rename", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPost("/repos/design/file-copy").reply(201);
    mockAxios.onGet("/repos/design/files/NoDesc/rules.xml").reply(404);
    mockAxios.onGet("/repos/design/projects/NoDesc/history").reply(200, { content: [{ revisionNo: "zzz" }] });

    const result = await executeTool(
      "openl_create_project",
      { repository: "design", template: "Src", projectName: "NoDesc", response_format: "json" },
      client
    );

    expect(result.content[0].text).toContain("\"renamedDescriptor\": false");
    expect(mockAxios.history.put.some((p) => p.url?.includes("rules.xml"))).toBe(false);
  });

  it("should reject a clone when the destination already exists (409)", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPost("/repos/design/file-copy").reply(409, { message: "file.copy.failed.message" });

    await expect(
      executeTool(
        "openl_create_project",
        { repository: "design", template: "Offer-US", projectName: "Existing" },
        client
      )
    ).rejects.toThrow(/already exists/i);
  });

  it("should surface a 404 when cloning a non-existent source", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPost("/repos/design/file-copy").reply(404, { message: "Project 'Nope' not found" });

    await expect(
      executeTool(
        "openl_create_project",
        { repository: "design", template: "Nope", projectName: "NewOne" },
        client
      )
    ).rejects.toThrow(/not found/i);
  });

  it("should validate required params for create", async () => {
    await expect(executeTool("openl_create_project", {}, client)).rejects.toThrow(/repository|projectName/);
  });
});

