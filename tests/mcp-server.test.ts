/**
 * Integration tests for MCP tool handlers.
 * Verifies tools through executeTool() with mocked OpenL client HTTP calls.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { OpenLClient } from "../src/client.js";
import { executeTool, registerAllTools } from "../src/tool-handlers.js";
import type { OpenLConfig, RepositoryInfo, ProjectViewModel, SummaryTableView } from "../src/types.js";
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
});

