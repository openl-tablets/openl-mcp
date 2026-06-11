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
    // The edit tool reads the table back to trigger a recompile.
    mockAxios.onGet(`/projects/${encoded}/tables/${encodeURIComponent("Rules.xls_1234")}`).reply(200, mockDecisionTable);

    const result = await executeTool(
      "openl_update_table",
      { projectId, tableId: "Rules.xls_1234", view },
      client
    );
    expect(result.content[0].text).toContain("Successfully updated table");
    // recompile trigger fired: GET on the table after the PUT
    expect(mockAxios.history.get.some((g) => g.url === `/projects/${encoded}/tables/Rules.xls_1234`)).toBe(true);
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
    // The edit tool reads the table back to trigger a recompile.
    mockAxios.onGet(`/projects/${encoded}/tables/${encodeURIComponent("Customer_1234")}`).reply(200, mockDecisionTable);

    const result = await executeTool(
      "openl_append_table",
      { projectId, tableId: "Customer_1234", appendData },
      client
    );
    expect(result.content[0].text).toContain("Successfully appended");
    expect(mockAxios.history.get.some((g) => g.url === `/projects/${encoded}/tables/Customer_1234`)).toBe(true);
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
    // RawSource appends probe the raw view first (row-width validation + identity).
    mockAxios.onGet(`/projects/${encoded}/tables/${encodeURIComponent("RawTable_5678")}`).reply(200, {
      id: "RawTable_5678",
      name: "RawTable",
      tableType: "RawSource",
      kind: "Other",
      file: "Rules.xlsx",
      pos: "A1:B3",
      source: [
        [{ value: "H1" }, { value: "H2" }],
        [{ value: "a" }, { value: "b" }],
      ],
    });
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

  it("openl_append_table rejects RawSource rows whose width does not match the table (EPBDS-16085)", async () => {
    const encoded = encodeProjectPath(projectId);
    const tableId = "WideTable_0001";
    mockAxios.onGet(`/projects/${encoded}/tables/${tableId}`).reply(200, {
      id: tableId,
      name: "bankFinancialData",
      tableType: "RawSource",
      kind: "Data",
      file: "Bank.xlsx",
      pos: "A1:E4",
      source: [
        [{ value: "Data BankData bankFinancialData", colspan: 5 }, { covered: true }, { covered: true }, { covered: true }, { covered: true }],
        [{ value: "id" }, { value: "date" }, { value: "a" }, { value: "b" }, { value: "c" }],
        [{ value: "R1" }, { value: "01/01/2024" }, { value: 1 }, { value: 2 }, { value: 3 }],
      ],
    });

    await expect(
      executeTool(
        "openl_append_table",
        {
          projectId,
          tableId,
          appendData: { tableType: "RawSource", rows: [[{ value: "R2" }, { value: "01/01/2025" }]] },
        },
        client
      )
    ).rejects.toThrow(/5 column\(s\) wide.*row 1 has 2 cell\(s\)/);

    // Nothing must be written when validation fails.
    expect(mockAxios.history.post.length).toBe(0);
  });

  it("openl_append_table accepts RawSource rows that cover every column", async () => {
    const encoded = encodeProjectPath(projectId);
    const tableId = "WideTable_0002";
    mockAxios.onGet(`/projects/${encoded}/tables/${tableId}`).reply(200, {
      id: tableId,
      name: "bankFinancialData",
      tableType: "RawSource",
      kind: "Data",
      file: "Bank.xlsx",
      pos: "A1:C3",
      source: [
        [{ value: "h1" }, { value: "h2" }, { value: "h3" }],
        [{ value: 1 }, { value: 2 }, { value: 3 }],
      ],
    });
    mockAxios.onPost(`/projects/${encoded}/tables/${tableId}/lines`).reply(200);

    const result = await executeTool(
      "openl_append_table",
      {
        projectId,
        tableId,
        appendData: { tableType: "RawSource", rows: [[{ value: "x" }, { value: "y" }, { value: "z" }]] },
      },
      client
    );
    expect(result.content[0].text).toContain("Successfully appended 1 row(s)");
    expect(mockAxios.history.post.length).toBe(1);
  });

  it("openl_append_table returns the table's new id after the edit (EPBDS-16084)", async () => {
    const encoded = encodeProjectPath(projectId);
    const oldId = "aaaa1111aaaa1111";
    const newId = "bbbb2222bbbb2222";
    const tableMeta = { name: "bankFinancialData", tableType: "Data", kind: "Data", file: "Bank.xlsx", pos: "A1:E4" };

    // Pre-edit probe on the old id; recompile read on the NEW id.
    mockAxios.onGet(`/projects/${encoded}/tables/${oldId}`).reply(200, { id: oldId, ...tableMeta });
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:E5" });
    // Table listing: before the edit the old id exists, afterwards only the new one.
    mockAxios
      .onGet(`/projects/${encoded}/tables`)
      .replyOnce(200, [{ id: oldId, ...tableMeta }])
      .onGet(`/projects/${encoded}/tables`)
      .replyOnce(200, [{ id: newId, ...tableMeta, pos: "A1:E5" }]);
    mockAxios.onPost(`/projects/${encoded}/tables/${oldId}/lines`).reply(200);

    const result = await executeTool(
      "openl_append_table",
      {
        projectId,
        tableId: oldId,
        appendData: { tableType: "Data", rows: [{ values: ["R2", "01/01/2025", 500, 600, 700] }] },
        response_format: "json",
      },
      client
    );

    const payload = JSON.parse(result.content[0].text).data;
    expect(payload.success).toBe(true);
    expect(payload.tableId).toBe(newId);
    expect(payload.tableIdChanged).toBe(true);
    expect(payload.previousTableId).toBe(oldId);
    expect(payload.recompileTriggered).toBe(true);
    expect(payload.note).toContain("changed the table's id");
    // The recompile read targeted the new id (with the old id it would silently 404).
    expect(mockAxios.history.get.some((g) => g.url === `/projects/${encoded}/tables/${newId}`)).toBe(true);
  });

  it("openl_append_table uses the studio-reported new id from the 200/{id}+Location response (EPBDS-16086)", async () => {
    const encoded = encodeProjectPath(projectId);
    const oldId = "aaaa0000aaaa0000";
    const newId = "bbbb1111bbbb1111";
    const tableMeta = { name: "bankFinancialData", tableType: "Data", kind: "Data", file: "Bank.xlsx", pos: "A1:E4" };

    mockAxios.onGet(`/projects/${encoded}/tables/${oldId}`).reply(200, { id: oldId, ...tableMeta });
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:E5" });
    // listTables would feed the LEGACY heuristic the OLD id (i.e. "unchanged"),
    // so asserting newId below proves the studio-reported id was used instead.
    mockAxios.onGet(`/projects/${encoded}/tables`).reply(200, [{ id: oldId, ...tableMeta }]);
    mockAxios
      .onPost(`/projects/${encoded}/tables/${oldId}/lines`)
      .reply(200, { id: newId }, { Location: `http://localhost:8080/rest/projects/${encoded}/tables/${newId}` });

    const result = await executeTool(
      "openl_append_table",
      {
        projectId,
        tableId: oldId,
        appendData: { tableType: "Data", rows: [{ values: ["R2", "01/01/2025", 500, 600, 700] }] },
        response_format: "json",
      },
      client
    );

    const payload = JSON.parse(result.content[0].text).data;
    expect(payload.success).toBe(true);
    expect(payload.tableId).toBe(newId);
    expect(payload.tableIdChanged).toBe(true);
    expect(payload.previousTableId).toBe(oldId);
    expect(payload.recompileTriggered).toBe(true);
    // Recompile read targeted the studio-reported id.
    expect(mockAxios.history.get.some((g) => g.url === `/projects/${encoded}/tables/${newId}`)).toBe(true);
  });

  it("openl_update_table reads the new id from the Location header when the body has none (EPBDS-16086)", async () => {
    const encoded = encodeProjectPath(projectId);
    const oldId = "cccc0000cccc0000";
    const newId = "dddd1111dddd1111";
    const tableMeta = { tableType: "Data", kind: "Data", name: "vehicleRating", file: "Rating.xlsx", pos: "A1:B4" };

    // before-snapshot / would-be heuristic input: only the OLD id (→ "unchanged" if it ran)
    mockAxios.onGet(`/projects/${encoded}/tables`).reply(200, [{ id: oldId, ...tableMeta }]);
    // 200 with EMPTY body but a Location header pointing at the new id.
    mockAxios
      .onPut(`/projects/${encoded}/tables/${oldId}`)
      .reply(200, "", { Location: `http://example.com/rest/projects/${encoded}/tables/${newId}` });
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:B5" });

    const view = { id: oldId, ...tableMeta, rows: [{ values: [1, 2] }] };
    const result = await executeTool(
      "openl_update_table",
      { projectId, tableId: oldId, view, response_format: "json" },
      client
    );

    const payload = JSON.parse(result.content[0].text).data;
    expect(payload.success).toBe(true);
    expect(payload.tableId).toBe(newId);
    expect(payload.tableIdChanged).toBe(true);
    expect(payload.previousTableId).toBe(oldId);
    expect(payload.recompileTriggered).toBe(true);
  });

  it("openl_append_table reports 204 (in-place edit) as an unchanged id", async () => {
    const encoded = encodeProjectPath(projectId);
    const tableId = "eeee2222eeee2222";
    const tableMeta = { name: "ratesTable", tableType: "Data", kind: "Data", file: "Rates.xlsx", pos: "A1:C9" };

    mockAxios.onGet(`/projects/${encoded}/tables/${tableId}`).reply(200, { id: tableId, ...tableMeta });
    // Same id before and after — an in-place edit that did not relocate the table.
    mockAxios.onGet(`/projects/${encoded}/tables`).reply(200, [{ id: tableId, ...tableMeta }]);
    mockAxios.onPost(`/projects/${encoded}/tables/${tableId}/lines`).reply(204);

    const result = await executeTool(
      "openl_append_table",
      { projectId, tableId, appendData: { tableType: "Data", rows: [{ values: [1, 2, 3] }] }, response_format: "json" },
      client
    );

    const payload = JSON.parse(result.content[0].text).data;
    expect(payload.success).toBe(true);
    expect(payload.tableId).toBe(tableId);
    expect(payload.tableIdChanged).toBeUndefined();
    expect(payload.previousTableId).toBeUndefined();
  });

  it("openl_get_table transparently resolves a stale id recorded by a previous edit (EPBDS-16084)", async () => {
    const encoded = encodeProjectPath(projectId);
    const oldId = "cccc3333cccc3333";
    const newId = "dddd4444dddd4444";
    const tableMeta = { name: "driverRating", tableType: "Data", kind: "Data", file: "Rating.xlsx", pos: "A1:C4" };

    // 1) An append records the old→new rename.
    mockAxios.onGet(`/projects/${encoded}/tables/${oldId}`).reply(200, { id: oldId, ...tableMeta });
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:C5" });
    mockAxios
      .onGet(`/projects/${encoded}/tables`)
      .replyOnce(200, [{ id: oldId, ...tableMeta }])
      .onGet(`/projects/${encoded}/tables`)
      .replyOnce(200, [{ id: newId, ...tableMeta, pos: "A1:C5" }]);
    mockAxios.onPost(`/projects/${encoded}/tables/${oldId}/lines`).reply(200);
    await executeTool(
      "openl_append_table",
      { projectId, tableId: oldId, appendData: { tableType: "Data", rows: [{ values: [1, 2, 3] }] } },
      client
    );

    // 2) A later read that still uses the pre-edit id is resolved automatically.
    mockAxios.reset();
    mockAxios.onGet(`/projects/${encoded}/tables/${oldId}`).reply(404, { message: "The table is not found." });
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:C5" });

    const result = await executeTool(
      "openl_get_table",
      { projectId, tableId: oldId, response_format: "json" },
      client
    );
    expect(result.content[0].text).toContain("stale");
    expect(result.content[0].text).toContain(newId);
    expect(result.content[1].text).toContain(newId);
  });

  it("openl_update_table retries with the recorded id when the given id is stale (EPBDS-16084)", async () => {
    const encoded = encodeProjectPath(projectId);
    const oldId = "eeee5555eeee5555";
    const newId = "ffff6666ffff6666";
    const tableMeta = { name: "vehicleRating", tableType: "Data", kind: "Data", file: "Rating.xlsx", pos: "A1:B4" };

    // 1) An append records the old→new rename.
    mockAxios.onGet(`/projects/${encoded}/tables/${oldId}`).reply(200, { id: oldId, ...tableMeta });
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:B5" });
    mockAxios
      .onGet(`/projects/${encoded}/tables`)
      .replyOnce(200, [{ id: oldId, ...tableMeta }])
      .onGet(`/projects/${encoded}/tables`)
      .replyOnce(200, [{ id: newId, ...tableMeta, pos: "A1:B5" }]);
    mockAxios.onPost(`/projects/${encoded}/tables/${oldId}/lines`).reply(200);
    await executeTool(
      "openl_append_table",
      { projectId, tableId: oldId, appendData: { tableType: "Data", rows: [{ values: [1, 2] }] } },
      client
    );

    // 2) An update that still uses the pre-edit id is retried with the current id.
    mockAxios.reset();
    mockAxios.onPut(`/projects/${encoded}/tables/${oldId}`).reply(404, { message: "The table is not found." });
    mockAxios.onPut(`/projects/${encoded}/tables/${newId}`).reply(204);
    mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:B5" });

    const view = { id: oldId, ...tableMeta, rows: [{ values: [9, 9] }] };
    const result = await executeTool(
      "openl_update_table",
      { projectId, tableId: oldId, view, response_format: "json" },
      client
    );

    const payload = JSON.parse(result.content[0].text).data;
    expect(payload.success).toBe(true);
    expect(payload.tableId).toBe(newId);
    expect(payload.tableIdChanged).toBe(true);
    expect(payload.note).toContain("stale");
    expect(mockAxios.history.put.length).toBe(2);
  });

  it("openl_get_table 404 explains that table ids go stale after edits (EPBDS-16086)", async () => {
    const encoded = encodeProjectPath(projectId);
    mockAxios
      .onGet(`/projects/${encoded}/tables/deadbeefdeadbeef`)
      .reply(404, { message: "The table is not found." });

    await expect(
      executeTool("openl_get_table", { projectId, tableId: "deadbeefdeadbeef" }, client)
    ).rejects.toThrow(/The table is not found.*does NOT mean the edit was rolled back.*openl_list_tables/s);
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

  it("should clone a project through create-from-zip so it is indexed immediately (EPBDS-16088)", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    // Source project folder downloaded as a ZIP (entries are project-root-relative).
    mockAxios.onGet("/repos/design/files/Offer-US/").reply(200, "PK-zip-bytes");
    // Re-uploaded through the same indexing endpoint blank create uses.
    mockAxios.onPut("/repos/design/projects/Offer-CW").reply(200, { revision: "def456", branch: "main" });

    const result = await executeTool(
      "openl_create_project",
      { repository: "design", template: "Offer-US", projectName: "Offer-CW", response_format: "json" },
      client
    );

    expect(result.content[0].text).toContain("Cloned");
    expect(result.content[0].text).toContain("def456");
    expect(result.content[0].text).toContain("visible in openl_list_projects immediately");
    // The raw git file-copy path (which bypasses indexing) must NOT be used.
    expect(mockAxios.history.post.some((p) => p.url === "/repos/design/file-copy")).toBe(false);
    const download = mockAxios.history.get.find((g) => g.url === "/repos/design/files/Offer-US/");
    expect(download?.params?.download).toBe("true");
  });

  it("should clone onto a branch via the legacy git file-copy path", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onPost("/repos/design/file-copy").reply(201);
    mockAxios
      .onGet("/repos/design/files/Offer-CW/rules.xml")
      .reply(200, "<project>\n  <name>Offer-US</name>\n  <modules>\n    <module><name>Main</name></module>\n  </modules>\n</project>");
    mockAxios.onPut("/repos/design/files/Offer-CW/rules.xml").reply(200);
    mockAxios.onGet("/repos/design/branches/dev/projects/Offer-CW/history").reply(200, { content: [{ revisionNo: "def456" }] });

    const result = await executeTool(
      "openl_create_project",
      { repository: "design", template: "Offer-US", projectName: "Offer-CW", branch: "dev", response_format: "json" },
      client
    );

    expect(result.content[0].text).toContain("Cloned");
    expect(result.content[0].text).toContain("def456");
    expect(result.content[0].text).toContain("re-indexes");

    // rules.xml project name rewritten to the new name; module name left untouched.
    const putReq = mockAxios.history.put.find((p) => p.url === "/repos/design/files/Offer-CW/rules.xml");
    const body = String(putReq?.data);
    expect(body).toContain("<name>Offer-CW</name>");
    expect(body).toContain("<module><name>Main</name></module>");
  });

  it("should reject a clone when the destination already exists (409)", async () => {
    mockAxios.onGet("/repos").reply(200, mockRepositories);
    mockAxios.onGet("/repos/design/files/Offer-US/").reply(200, "PK-zip-bytes");
    mockAxios.onPut("/repos/design/projects/Existing").reply(409, { message: "duplicated.project.message" });

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
    mockAxios.onGet("/repos/design/files/Nope/").reply(404, { message: "Project 'Nope' not found" });

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

  // ---------------------------------------------------------------------------
  // Trace (EPBDS-16089: websocket-based wait while the trace is running).
  // The full wait orchestration (subscribe → race-close re-read → terminal
  // frame → final read) is unit-tested with an injected STOMP fake in
  // tests/stomp-waits.trace.test.ts; here we cover the tool-layer glue.
  // ---------------------------------------------------------------------------

  it("openl_get_trace_nodes returns nodes when the trace is already complete", async () => {
    const encoded = encodeProjectPath(projectId);
    const nodes = [{ id: 1, name: "calculatePremium", type: "rule" }];
    mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(200, nodes);

    const result = await executeTool(
      "openl_get_trace_nodes",
      { projectId, response_format: "json" },
      client
    );

    expect(result.content[0].text).toContain("calculatePremium");
  });

  it("openl_get_trace_nodes with wait: false surfaces the 409 immediately", async () => {
    const encoded = encodeProjectPath(projectId);
    mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

    await expect(
      executeTool("openl_get_trace_nodes", { projectId, wait: false }, client)
    ).rejects.toThrow(/409|still running/i);
    expect(mockAxios.history.get.filter((g) => g.url === `/projects/${encoded}/trace/nodes`).length).toBe(1);
  });

  it("openl_get_trace_nodes asks for tableId when the trace's table is unknown (EPBDS-16089)", async () => {
    // Unique project id: nothing recorded by openl_start_trace for it.
    const unknownProjectId = "design:trace-unknown:1";
    const encoded = encodeProjectPath(unknownProjectId);
    mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

    await expect(
      executeTool("openl_get_trace_nodes", { projectId: unknownProjectId }, client)
    ).rejects.toThrow(/Pass 'tableId'/);
  });

  it("openl_get_trace_nodes explains when the websocket wait is unavailable (no studio session)", async () => {
    // The mocked axios layer never issues a JSESSIONID, so once the 409 arrives
    // the handler cannot join the trace-status websocket and must say so.
    const wsProjectId = "design:trace-no-session:1";
    const encoded = encodeProjectPath(wsProjectId);
    mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

    await expect(
      executeTool("openl_get_trace_nodes", { projectId: wsProjectId, tableId: "rule_1" }, client)
    ).rejects.toThrow(/websocket.*unavailable.*session cookie|session cookie.*websocket/is);
  });

  it("openl_start_trace records the traced table so reads can subscribe without tableId (EPBDS-16089)", async () => {
    const traceProjectId = "design:trace-recorded:1";
    const encoded = encodeProjectPath(traceProjectId);
    mockAxios.onPost(/\/projects\/.*\/trace.*/).reply(202);
    mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

    const started = await executeTool(
      "openl_start_trace",
      { projectId: traceProjectId, tableId: "calcRule_42", inputJson: { params: { x: 1 } } },
      client
    );
    expect(started.content[0].text).toContain("websocket");

    // No explicit tableId here — the handler must find the recorded one and
    // proceed to the websocket path (which then fails on the missing session
    // cookie rather than asking for tableId).
    await expect(
      executeTool("openl_get_trace_nodes", { projectId: traceProjectId }, client)
    ).rejects.toThrow(/session cookie/i);
  });

  it("openl_export_trace supports the same websocket wait glue", async () => {
    const wsProjectId = "design:trace-export:1";
    const encoded = encodeProjectPath(wsProjectId);
    mockAxios.onGet(`/projects/${encoded}/trace/export`).reply(409, { message: "Trace is still running" });

    await expect(
      executeTool("openl_export_trace", { projectId: wsProjectId, tableId: "rule_1" }, client)
    ).rejects.toThrow(/websocket.*unavailable|session cookie/is);

    // And returns the export verbatim when the trace is already complete.
    mockAxios.reset();
    mockAxios.onGet(`/projects/${encoded}/trace/export`).reply(200, "TRACE: calculatePremium -> 42");
    const result = await executeTool("openl_export_trace", { projectId: wsProjectId, tableId: "rule_1" }, client);
    expect(result.content[0].text).toContain("calculatePremium -> 42");
  });
});

