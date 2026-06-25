/**
 * Integration tests for MCP Tool Handlers
 * Tests tool execution through the MCP server with real OpenL client
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { OpenLClient } from "../../src/client.js";
import { executeTool, getAllTools, registerAllTools } from "../../src/handlers/index.js";
import type { OpenLConfig, ProjectStatusView, ProjectViewModel, RepositoryInfo, SummaryTableView, TestsExecutionSummary } from "../../src/types.js";
import * as Types from "../../src/types.js";
import { mockRepositories, mockDecisionTable, mockDeployments } from "../mocks/openl-api-mocks.js";

// Shared fixture for the tests below that address a project by its colon-form id.
const projectId = "design:insurance-rules:hash123";
const encodeProjectPath = (id: string): string => encodeURIComponent(id);

describe("Tool Handler Integration Tests", () => {
  let client: OpenLClient;
  let mockAxios: MockAdapter;

  beforeAll(() => {
    const config: OpenLConfig = {
      baseUrl: "http://localhost:8080",
      personalAccessToken: "openl_pat_test",
    };

    client = new OpenLClient(config);
    // @ts-ignore - Access private axiosInstance for mocking
    mockAxios = new MockAdapter(client.axiosInstance);

    // Register all tools before running tests
    registerAllTools();
  });

  afterEach(() => {
    mockAxios.reset();
  });

  it("getAllTools() exposes every tool under a bare name (the openl_ prefix is a wire-only concern)", () => {
    const names = getAllTools().map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    // The registry never carries the namespace prefix — it is added/stripped only
    // at the MCP protocol boundary (see tests/constants.test.ts).
    expect(names.some((n) => n.startsWith("openl_"))).toBe(false);
    // The bare names are exactly what executeTool / the CLI dispatch on.
    expect(names).toContain("list_repositories");
  });

  describe("Repository Tools", () => {
    it("should execute openl_list_repositories", async () => {
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
        { id: "production", name: "Production Repository", aclId: "acl-production" },
      ];

      mockAxios.onGet("/repos").reply(200, mockRepos);

      const result = await executeTool("list_repositories", {}, client);

      expect(result).toHaveProperty("content");
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe("text");
    });

    it("should execute openl_list_branches", async () => {
      // Mock repositories list for getRepositoryIdByName
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);

      // Mock branches API call (uses repository ID)
      mockAxios.onGet("/repos/design/branches").reply(200, ["main", "development"]);

      const result = await executeTool("list_branches", {
        repository: "Design Repository", // Use repository name, not ID
      }, client);

      expect(result.content[0].type).toBe("text");
      const text = result.content[0].text;
      expect(text).toContain("main");
      expect(text).toContain("development");
    });
  });

  describe("Project Tools", () => {
    it("should execute openl_list_projects", async () => {
      // Mock repositories list for getRepositoryIdByName
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);

      const mockProjects: Partial<ProjectViewModel>[] = [
        {
          id: "design:Project 1:hash123",
          name: "Project 1",
          repository: "design",
          status: "OPENED",
          path: "Project 1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        },
      ];

      mockAxios.onGet("/projects", { params: { repository: "design", page: 0, size: 50 } }).reply(200, mockProjects);

      const result = await executeTool("list_projects", {
        repository: "Design Repository", // Use repository name, not ID
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Project 1");
    });

    it("should execute openl_get_project", async () => {
      // getProject normalizes projectId for request path
      // "design-project1" is used as project ID path segment
      const projectIdForPath = "design-project1";
      const mockProject: Partial<ProjectViewModel> = {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "OPENED",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      };

      // getProject uses buildProjectPath and calls /projects/{projectIdPath}
      mockAxios.onGet(`/projects/${encodeURIComponent(projectIdForPath)}`).reply(200, mockProject);

      const result = await executeTool("get_project", {
        projectId: "design-project1",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("project1");
    });

  });

  describe("Table Tools", () => {
    it("should execute openl_list_tables", async () => {
      const mockTables: Partial<SummaryTableView>[] = [
        {
          id: "calculatePremium_1234",
          name: "calculatePremium",
          tableType: "SimpleRules",
          kind: "Rules",
          signature: "double calculatePremium(int age, double amount)",
          returnType: "double",
          file: "Rules.xlsx",
          pos: "A1",
          properties: {
            category: "Premium Calculation",
            version: "1.0",
          },
        },
      ];

      // list_tables uses buildProjectPath
      mockAxios.onGet(/\/projects\/.*\/tables/).reply(200, mockTables);

      const result = await executeTool("list_tables", {
        projectId: "design-project1",
      }, client);

      expect(result.content[0].type).toBe("text");
      const text = result.content[0].text;
      expect(text).toContain("calculatePremium");
      // Verify new columns are included in markdown output
      expect(text).toContain("Kind");
      expect(text).toContain("Signature");
      expect(text).toContain("Return Type");
      expect(text).toContain("Properties");
      expect(text).toContain("Rules"); // kind value
      expect(text).toContain("double calculatePremium"); // signature value
      expect(text).toContain("double"); // returnType value
      expect(text).toContain("category"); // properties keys
    });

    it("should execute openl_get_table", async () => {
      const mockTable: Partial<SummaryTableView> = {
        id: "calculatePremium_1234",
        name: "calculatePremium",
        tableType: "SimpleRules",
        kind: "Rules",
        file: "Rules.xlsx",
        pos: "A1",
      };

      // get_table uses buildProjectPath
      mockAxios.onGet(/\/projects\/.*\/tables\/calculatePremium_1234/).reply(200, mockTable);

      const result = await executeTool("get_table", {
        projectId: "design-project1",
        tableId: "calculatePremium_1234",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("calculatePremium");
    });

    it("openl_create_project_table normalizes a miscased tableType to the canonical token", async () => {
      let body: Record<string, any> = {};
      mockAxios.onPost(/\/projects\/.*\/tables/).reply((config) => {
        body = JSON.parse(config.data);
        return [201, { id: "t1", name: "LoanApplication", tableType: "Datatype", file: "Main.xlsx" }];
      });

      // Agent's bug: lowercase "datatype" — must be sent to the backend as "Datatype".
      await executeTool("create_project_table", {
        projectId: "p1",
        moduleName: "Main",
        table: { tableType: "datatype", kind: "Datatype", name: "LoanApplication", fields: [{ name: "age", type: "Integer" }] },
      }, client);

      expect(body.table.tableType).toBe("Datatype");
    });

    it("openl_create_project_table rejects an unknown tableType with an actionable error (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/projects\/.*\/tables/).reply(() => {
        called = true;
        return [201, {}];
      });

      await expect(
        executeTool("create_project_table", {
          projectId: "p1",
          moduleName: "Main",
          table: { tableType: "frobnicate", name: "X" },
        }, client)
      ).rejects.toThrow(/not a valid table type|CASE-SENSITIVE/);
      expect(called).toBe(false);
    });

    it("openl_create_project_table rejects an unsupported 'signature' field with guidance (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/projects\/.*\/tables/).reply(() => {
        called = true;
        return [201, {}];
      });

      await expect(
        executeTool("create_project_table", {
          projectId: "p1",
          moduleName: "Main",
          table: { tableType: "SimpleRules", name: "CreditCategory", signature: "String CreditCategory(Integer creditScore)", rules: [] },
        }, client)
      ).rejects.toThrow(/signature is not a valid field|returnType.*args/);
      expect(called).toBe(false);
    });

    it("openl_create_project_table rejects a missing tableType", async () => {
      await expect(
        executeTool("create_project_table", {
          projectId: "p1",
          moduleName: "Main",
          table: { name: "X", fields: [] },
        }, client)
      ).rejects.toThrow(/tableType is required/);
    });

    // --- Request validation for the structured-payload table tools (EPBDS-16110/16112) ---

    it("openl_append_table rejects appendData with no tableType discriminator (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/lines/).reply(() => {
        called = true;
        return [200];
      });

      // Agent bug #1: a payload that omits the required tableType discriminator.
      await expect(
        executeTool("append_table", {
          projectId: "p1",
          tableId: "t1",
          appendData: { rules: [{ "Commission Type": "UDI", "Partner Code": "CIDP_CL_FB" }] },
        }, client)
      ).rejects.toThrow(/tableType is required.*CASE-SENSITIVE/s);
      expect(called).toBe(false);
    });

    it("openl_append_table accepts appendData sent as a JSON string and forwards a real object", async () => {
      mockAxios.onGet(/\/tables\/t1$/).reply(200, {
        id: "t1", name: "MyData", tableType: "Data", kind: "Data", file: "Rules.xlsx", pos: "A1",
      });
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/t1\/lines/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [200];
      });

      // Agent bug #2: the whole payload arrives as a JSON *string*, not an object.
      const result = await executeTool("append_table", {
        projectId: "p1",
        tableId: "t1",
        appendData: '{"tableType":"Data","rows":[{"values":[2035,"01/01/2035",1000]}]}',
      }, client);

      expect(result.content[0].text).toContain("Successfully appended");
      // The stringified payload reached the backend as a parsed object, not a string literal.
      expect(postBody.tableType).toBe("Data");
      expect(Array.isArray(postBody.rows)).toBe(true);
    });

    it("openl_append_table reports a precise error when appendData is a malformed JSON string (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/lines/).reply(() => {
        called = true;
        return [200];
      });

      await expect(
        executeTool("append_table", {
          projectId: "p1",
          tableId: "t1",
          appendData: '{"tableType":"Data","rows":[',
        }, client)
      ).rejects.toThrow(/not valid JSON/);
      expect(called).toBe(false);
    });

    it("openl_append_table rejects a payload whose shape does not match its tableType (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/lines/).reply(() => {
        called = true;
        return [200];
      });

      // Data appends use rows:[{values}], not rules — the union must catch this.
      await expect(
        executeTool("append_table", {
          projectId: "p1",
          tableId: "t1",
          appendData: { tableType: "Data", rules: [{ a: 1 }] },
        }, client)
      ).rejects.toThrow(/rows/);
      expect(called).toBe(false);
    });

    it("openl_append_table normalizes a miscased tableType before sending", async () => {
      mockAxios.onGet(/\/tables\/t1$/).reply(200, {
        id: "t1", name: "MyData", tableType: "Data", kind: "Data", file: "Rules.xlsx", pos: "A1",
      });
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/t1\/lines/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [200];
      });

      await executeTool("append_table", {
        projectId: "p1",
        tableId: "t1",
        appendData: { tableType: "data", rows: [{ values: [1, 2, 3] }] },
      }, client);

      expect(postBody.tableType).toBe("Data");
    });

    it("openl_update_table accepts view sent as a JSON string and forwards a real object", async () => {
      let putBody: Record<string, any> = {};
      mockAxios.onPut(/\/tables\/t1$/).reply((config) => {
        putBody = JSON.parse(config.data);
        return [204];
      });
      mockAxios.onGet(/\/tables\/t1$/).reply(200, {
        id: "t1", name: "calc", tableType: "SimpleRules", kind: "Rules",
      });

      const view = { id: "t1", name: "calc", tableType: "SimpleRules", kind: "Rules", rules: [{ x: 1 }] };
      const result = await executeTool("update_table", {
        projectId: "p1",
        tableId: "t1",
        view: JSON.stringify(view),
      }, client);

      expect(result.content[0].text).toContain("Successfully updated table");
      expect(putBody.tableType).toBe("SimpleRules");
    });

    it("openl_update_table rejects a view that is a plain (non-JSON) string (no request sent)", async () => {
      let called = false;
      mockAxios.onPut(/\/tables\//).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("update_table", {
          projectId: "p1",
          tableId: "t1",
          view: "SimpleRules",
        }, client)
      ).rejects.toThrow(/Invalid arguments for update_table/);
      expect(called).toBe(false);
    });

    it("openl_append_table rejects a Spreadsheet append without cells (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/lines/).reply(() => {
        called = true;
        return [200];
      });

      await expect(
        executeTool("append_table", {
          projectId: "p1",
          tableId: "t1",
          appendData: { tableType: "Spreadsheet", rows: [{ name: "Step1", type: "Double" }] },
        }, client)
      ).rejects.toThrow(/cells/);
      expect(called).toBe(false);
    });

    it("openl_append_table rejects a Spreadsheet append whose rows and cells lengths differ (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/lines/).reply(() => {
        called = true;
        return [200];
      });

      // 2 row headers but only 1 cell row — caught before any backend probe/POST.
      await expect(
        executeTool("append_table", {
          projectId: "p1",
          tableId: "t1",
          appendData: {
            tableType: "Spreadsheet",
            rows: [{ name: "Step1" }, { name: "Step2" }],
            cells: [[{ value: "=1+1" }]],
          },
        }, client)
      ).rejects.toThrow(/Cannot append to Spreadsheet table/);
      expect(called).toBe(false);
    });

    it("openl_append_table appends to a Spreadsheet via cells and reports the row count", async () => {
      mockAxios.onGet(/\/tables\/sheet1$/).reply(200, {
        id: "sheet1", name: "Calc", tableType: "Spreadsheet", kind: "Spreadsheet", file: "Main.xlsx", pos: "A1",
      });
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/sheet1\/lines/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [200];
      });

      const result = await executeTool("append_table", {
        projectId: "p1",
        tableId: "sheet1",
        appendData: { tableType: "Spreadsheet", cells: [[{ value: "=1+1" }], [{ value: "=2+2" }]] },
      }, client);

      // cells-only append (no rows): item count comes from cells.length.
      expect(result.content[0].text).toContain("Successfully appended 2 row(s)");
      expect(postBody.tableType).toBe("Spreadsheet");
      expect(Array.isArray(postBody.cells)).toBe(true);
    });

    it("openl_delete_table DELETEs the table and reports success", async () => {
      let url = "";
      mockAxios.onDelete(/\/tables\/t1$/).reply((config) => {
        url = config.url || "";
        return [204];
      });

      const result = await executeTool("delete_table", { projectId: "p1", tableId: "t1" }, client);

      expect(url).toMatch(/\/projects\/p1\/tables\/t1$/);
      expect(result.content[0].text).toContain("Successfully deleted table t1");
      expect(result.content[0].text).toContain("openl_project_status");
    });

    it("openl_delete_table requires projectId and tableId (no request sent)", async () => {
      let called = false;
      mockAxios.onDelete(/\/tables\//).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("delete_table", { projectId: "p1" }, client),
      ).rejects.toThrow(/Missing required arguments/);
      expect(called).toBe(false);
    });
  });

  describe("Table Action Tools (raw source)", () => {
    it("registers a narrow tool per operation×orientation", () => {
      const names = getAllTools().map((t) => t.name);
      for (const name of [
        "append_table_row", "append_table_column",
        "insert_table_row", "insert_table_column",
        "delete_table_row", "delete_table_column",
        "update_table_row", "update_table_column", "update_table_cell",
        "merge_table_cells", "unmerge_table_cells",
      ]) {
        expect(names).toContain(name);
      }
    });

    it("openl_insert_table_row POSTs an insert/row action carrying position and cells", async () => {
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/t1\/actions$/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [204];
      });
      mockAxios.onGet(/\/tables\/t1$/).reply(200, { id: "t1", name: "T", tableType: "RawSource", kind: "Other" });

      const result = await executeTool("insert_table_row", {
        projectId: "p1",
        tableId: "t1",
        position: 3,
        cells: [{ value: "A" }, { value: "B" }],
      }, client);

      expect(postBody).toEqual({
        operation: "insert",
        target: { type: "row", position: 3, cells: [{ value: "A" }, { value: "B" }] },
      });
      expect(result.content[0].text).toContain("Successfully inserted a row into table t1");
      // 204 in-place edit: the id is unchanged.
      expect(result.content[0].text).not.toContain("tableIdChanged");
    });

    it("openl_append_table_column omits cells from the action when none are supplied", async () => {
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/t1\/actions$/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [204];
      });
      mockAxios.onGet(/\/tables\/t1$/).reply(200, { id: "t1", name: "T", tableType: "RawSource", kind: "Other" });

      await executeTool("append_table_column", { projectId: "p1", tableId: "t1" }, client);

      expect(postBody).toEqual({ operation: "append", target: { type: "column" } });
    });

    it("openl_update_table_cell sends an explicit null value so the cell is cleared", async () => {
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/t1\/actions$/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [204];
      });
      mockAxios.onGet(/\/tables\/t1$/).reply(200, { id: "t1", name: "T", tableType: "RawSource", kind: "Other" });

      await executeTool("update_table_cell", {
        projectId: "p1", tableId: "t1", row: 2, column: 1, value: null,
      }, client);

      expect(postBody).toEqual({
        operation: "update",
        target: { type: "cell", row: 2, column: 1, value: null },
      });
    });

    it("openl_update_table_cell requires value (omitting it is rejected, no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/actions$/).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("update_table_cell", { projectId: "p1", tableId: "t1", row: 2, column: 1 }, client),
      ).rejects.toThrow(/Invalid arguments for update_table_cell/);
      expect(called).toBe(false);
    });

    it("openl_merge_table_cells POSTs a merge/cells action with the span", async () => {
      let postBody: Record<string, any> = {};
      mockAxios.onPost(/\/tables\/t1\/actions$/).reply((config) => {
        postBody = JSON.parse(config.data);
        return [204];
      });
      mockAxios.onGet(/\/tables\/t1$/).reply(200, { id: "t1", name: "T", tableType: "RawSource", kind: "Other" });

      await executeTool("merge_table_cells", {
        projectId: "p1", tableId: "t1", row: 1, column: 0, rowspan: 2, colspan: 3,
      }, client);

      expect(postBody).toEqual({
        operation: "merge",
        target: { type: "cells", row: 1, column: 0, rowspan: 2, colspan: 3 },
      });
    });

    it("reports the new table id and previousTableId when an edit relocates the table", async () => {
      mockAxios.onPost(/\/tables\/t1\/actions$/).reply(200, { id: "t1_moved" });
      mockAxios.onGet(/\/tables\/t1_moved$/).reply(200, { id: "t1_moved", name: "T", tableType: "RawSource", kind: "Other" });

      const result = await executeTool("delete_table_row", {
        projectId: "p1", tableId: "t1", position: 5,
      }, client);

      const text = result.content[0].text;
      expect(text).toContain("t1_moved");
      expect(text).toContain("previousTableId");
      expect(text).toContain("t1");
    });

    it("rejects insert_table_row without a position (no request sent)", async () => {
      let called = false;
      mockAxios.onPost(/\/actions$/).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("insert_table_row", { projectId: "p1", tableId: "t1" }, client),
      ).rejects.toThrow(/Invalid arguments for insert_table_row/);
      expect(called).toBe(false);
    });

    it("rejects a negative position before reaching the backend", async () => {
      let called = false;
      mockAxios.onPost(/\/actions$/).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("delete_table_row", { projectId: "p1", tableId: "t1", position: -1 }, client),
      ).rejects.toThrow(/Invalid arguments for delete_table_row/);
      expect(called).toBe(false);
    });

    it("rejects a 1x1 (no-op) merge before reaching the backend", async () => {
      let called = false;
      mockAxios.onPost(/\/actions$/).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("merge_table_cells", { projectId: "p1", tableId: "t1", row: 0, column: 0, rowspan: 1, colspan: 1 }, client),
      ).rejects.toThrow(/more than one cell/);
      expect(called).toBe(false);
    });

    it("rejects a cell with a zero/negative colspan before reaching the backend", async () => {
      let called = false;
      mockAxios.onPost(/\/actions$/).reply(() => {
        called = true;
        return [204];
      });

      await expect(
        executeTool("append_table_row", { projectId: "p1", tableId: "t1", cells: [{ value: "a", colspan: 0 }] }, client),
      ).rejects.toThrow(/Invalid arguments for append_table_row/);
      expect(called).toBe(false);
    });
  });

  describe("AGENTS.md Tool", () => {
    it("should execute openl_get_project_agents_md (aggregated document, root-first)", async () => {
      mockAxios.onPost(/\/projects\/.*\/file-search/).reply(200, [
        { path: "foo/P1/AGENTS.md", name: "AGENTS.md", type: "file", basePath: "foo/P1", content: "project guidance" },
        { path: "foo/AGENTS.md", name: "AGENTS.md", type: "file", basePath: "foo", content: "root guidance" },
      ]);

      const result = await executeTool("get_project_agents_md", {
        projectId: "design-P1",
      }, client);

      expect(result.content[0].type).toBe("text");
      const text = result.content[0].text;
      expect(text).toContain("*Important note about this document*");
      // Root file precedes the project file (root-first, project last = highest priority).
      expect(text.indexOf("## /foo/AGENTS.md")).toBeLessThan(text.indexOf("## /foo/P1/AGENTS.md"));
      expect(text.indexOf("root guidance")).toBeLessThan(text.indexOf("project guidance"));
    });

    it("returns a 'no files' note when the project has no AGENTS.md", async () => {
      mockAxios.onPost(/\/projects\/.*\/file-search/).reply(200, []);

      const result = await executeTool("get_project_agents_md", {
        projectId: "design-P2",
      }, client);

      expect(result.content[0].text).toBe("No AGENTS.md files apply to this project.");
    });
  });

  describe("Response Format Variants", () => {
    it("should support json response format", async () => {
      mockAxios.onGet("/repos").reply(200, [
        { id: "design", name: "Design" },
      ]);

      const result = await executeTool("list_repositories", {
        response_format: "json",
      }, client);

      const text = result.content[0].text;
      expect(() => JSON.parse(text)).not.toThrow();

      const data = JSON.parse(text);
      expect(data).toHaveProperty("data");
    });

    // Shared project data so concise and detailed renders are compared on the SAME input.
    const formatVariantProjects = [
      {
        id: "design:p1:hash1",
        name: "p1",
        repository: "design",
        status: "OPENED",
        path: "p1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "design:p2:hash2",
        name: "p2",
        repository: "design",
        status: "CLOSED",
        path: "p2",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      },
    ];

    async function renderProjects(response_format: "markdown_concise" | "markdown_detailed") {
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);
      mockAxios
        .onGet("/projects", { params: { repository: "design", page: 0, size: 50 } })
        .reply(200, formatVariantProjects);

      const result = await executeTool("list_projects", {
        repository: "Design Repository", // Use repository name, not ID
        response_format,
      }, client);
      return result.content[0].text as string;
    }

    it("should support markdown_concise response format", async () => {
      const concise = await renderProjects("markdown_concise");
      mockAxios.reset();
      const detailed = await renderProjects("markdown_detailed");

      // Concise emits the "Found N project(s)" summary line (toMarkdownConcise) ...
      expect(concise).toContain("Found 2 projects");
      // ... and must NOT include the detail-only Status Breakdown line.
      expect(concise).not.toContain("**Status Breakdown:**");
      // ... and is strictly shorter than the detailed render of the SAME data.
      expect(concise.length).toBeLessThan(detailed.length);
    });

    it("should support markdown_detailed response format", async () => {
      const detailed = await renderProjects("markdown_detailed");
      mockAxios.reset();
      const concise = await renderProjects("markdown_concise");

      // toMarkdownDetailed emits a "**Status Breakdown:** N opened, M closed" line for projects ...
      expect(detailed).toContain("**Status Breakdown:** 1 opened, 1 closed");
      // ... plus the Summary/Retrieved headings, none of which the concise render emits.
      expect(detailed).toContain("**Summary:**");
      expect(detailed).toContain("**Retrieved:**");
      expect(concise).not.toContain("**Status Breakdown:**");
    });
  });

  describe("Destructive Operation Confirmation", () => {
    it("should execute openl_deploy_project", async () => {
      // Mock production repositories list for getProductionRepositoryIdByName
      const mockProdRepos: RepositoryInfo[] = [
        { id: "production", name: "Production Repository", aclId: "acl-production" },
      ];
      mockAxios.onGet("/production-repos").reply(200, mockProdRepos);

      // deploy_project uses /deployments endpoint
      mockAxios.onPost("/deployments").reply(200, {
        success: true,
        deploymentName: "project1",
      });

      const result = await executeTool("deploy_project", {
        projectId: "design-project1",
        deploymentName: "project1",
        productionRepositoryId: "Production Repository", // Use repository name, not ID
        comment: "Deploy test",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("success");
    });


    it("should execute openl_open_project", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "CLOSED",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      mockAxios.onPatch(`/projects/${encodedProjectId}`, {
        status: "OPENED",
      }).reply(204);

      const result = await executeTool("open_project", {
        projectId: "design-project1",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("opened");
    });

    it("should execute openl_open_project with branch", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "CLOSED",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      mockAxios.onPatch(`/projects/${encodedProjectId}`, {
        status: "OPENED",
        branch: "develop",
      }).reply(204);

      const result = await executeTool("open_project", {
        projectId: "design-project1",
        branch: "develop",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("branch");
    });

    it("should execute openl_save_project", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      // save_project requires project status EDITING and comment
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      // Mock validation endpoint (404 = validation unavailable, proceed with save)
      mockAxios.onGet(`/projects/${encodedProjectId}/validation`).reply(404);

      // Save is done via PATCH /projects/{projectId} with { comment } (204 No Content)
      mockAxios.onPatch(`/projects/${encodedProjectId}`, {
        comment: "Test commit",
      }).reply(204);

      const result = await executeTool("save_project", {
        projectId: "design-project1",
        comment: "Test commit",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("success");
      expect(result.content[0].text).toContain("Test commit");
    });

    it("should execute openl_save_project with closeAfterSave sends comment and status CLOSED in one PATCH", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      mockAxios.onGet(`/projects/${encodedProjectId}/validation`).reply(404);

      let patchBody: { comment?: string; status?: string } = {};
      mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
        patchBody = config.data ? JSON.parse(config.data) : {};
        return [204];
      });

      const result = await executeTool("save_project", {
        projectId: "design-project1",
        comment: "Save and close",
        closeAfterSave: true,
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("success");
      expect(result.content[0].text).toContain("Save and close");
      expect(patchBody).toEqual({ comment: "Save and close", status: "CLOSED" });
    });

    it("should execute openl_close_project without unsaved changes", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      // Mock project fetch to check status
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "OPENED", // No unsaved changes
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      // Mock close
      mockAxios.onPatch(`/projects/${encodedProjectId}`, {
        status: "CLOSED",
      }).reply(200);

      const result = await executeTool("close_project", {
        projectId: "design-project1",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("closed");
    });

    it("should execute openl_close_project with saveChanges", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      // Mock project fetch to check status
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING", // Has unsaved changes
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      // Mock validation endpoint (404 = validation unavailable, proceed with save)
      mockAxios.onGet(`/projects/${encodedProjectId}/validation`).reply(404);

      // saveProject uses PATCH with { comment }; closeProject uses PATCH with { status: "CLOSED" }
      mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
        const data = config.data ? JSON.parse(config.data) : {};
        if (data.status === "CLOSED") return [204];
        if (data.comment === "Save before close") return [204];
        return [404];
      });

      const result = await executeTool("close_project", {
        projectId: "design-project1",
        saveChanges: true,
        comment: "Save before close",
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("saved");
      expect(result.content[0].text).toContain("closed");
    });

    it("should execute openl_close_project with discardChanges", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      // Mock project fetch to check status
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING", // Has unsaved changes
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      // Mock close (discarding changes)
      mockAxios.onPatch(`/projects/${encodedProjectId}`, {
        status: "CLOSED",
      }).reply(200);

      const result = await executeTool("close_project", {
        projectId: "design-project1",
        discardChanges: true,
        confirmDiscard: true,
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("discarded");
    });

    it("should require confirmDiscard when closing EDITING with discardChanges", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      const result = await executeTool("close_project", {
        projectId: "design-project1",
        discardChanges: true,
        // no confirmDiscard
      }, client);

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("confirmationRequired");
      expect(result.content[0].text).toContain("confirmDiscard");
      expect(result.content[0].text).toContain("unsaved changes");
    });

    it("should error when closing project with unsaved changes without saveChanges or discardChanges", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      // Mock project fetch to check status
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING", // Has unsaved changes
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      await expect(
        executeTool("close_project", {
          projectId: "design-project1",
          // No saveChanges or discardChanges
        }, client)
      ).rejects.toThrow(/unsaved changes|saveChanges|discardChanges/i);
    });

    it("should error when saveChanges is true but comment is missing", async () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      // Mock project fetch to check status
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "EDITING", // Has unsaved changes
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      await expect(
        executeTool("close_project", {
          projectId: "design-project1",
          saveChanges: true,
          // Missing comment
        }, client)
      ).rejects.toThrow(/comment.*required/i);
    });
  });

  describe("Pagination", () => {
    it("should support pagination parameters", async () => {
      // Mock repositories list for getRepositoryIdByName
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);

      const mockProjects = Array.from({ length: 100 }, (_, i) => ({
        id: `design:p${i}:hash${i}`,
        name: `p${i}`,
        repository: "design",
        status: "OPENED",
        path: `p${i}`,
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      }));

      mockAxios.onGet("/projects", { params: { repository: "design", page: 0, size: 10 } }).reply(200, mockProjects);

      const result = await executeTool("list_projects", {
        repository: "Design Repository", // Use repository name, not ID
        limit: 10,
        offset: 0,
        response_format: "json",
      }, client);

      const data = JSON.parse(result.content[0].text);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.limit).toBe(10);
      expect(data.pagination.offset).toBe(0);
      expect(data.pagination.has_more).toBe(true);
      expect(data.pagination.next_offset).toBe(10);
    });

    it("should enforce maximum limit of 200", async () => {
      // Mock repositories list for getRepositoryIdByName
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);

      await expect(
        executeTool("list_projects", {
          repository: "Design Repository", // Use repository name, not ID
          limit: 300, // Exceeds max
        }, client)
      ).rejects.toThrow(/limit must be <= 200/);
    });

    it("should enforce minimum limit of 1", async () => {
      // Mock repositories list for getRepositoryIdByName
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);

      await expect(
        executeTool("list_projects", {
          repository: "Design Repository", // Use repository name, not ID
          limit: 0,
        }, client)
      ).rejects.toThrow(/limit must be positive/);
    });
  });

  describe("Error Handling", () => {
    it("should return actionable error for missing projectId", async () => {
      await expect(
        executeTool("get_project", {
          // Missing projectId
        }, client)
      ).rejects.toThrow(/Missing required argument: projectId/);
      await expect(
        executeTool("get_project", {}, client)
      ).rejects.toThrow(/openl_list_projects/);
    });

    it("should return actionable error for invalid response_format", async () => {
      // Mock repositories list for getRepositoryIdByName
      const mockRepos: RepositoryInfo[] = [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ];
      mockAxios.onGet("/repos").reply(200, mockRepos);

      await expect(
        executeTool("list_projects", {
          repository: "Design Repository", // Use repository name, not ID
          response_format: "xml" as any,
        }, client)
      ).rejects.toThrow(/markdown_concise.*markdown_detailed/);
    });
  });

  describe("Test Execution Tools", () => {
    const projectIdForPath = "design-project1";
    const encodedProjectId = encodeURIComponent(projectIdForPath);

    beforeEach(() => {
      // Mock project fetch for auto-open functionality
      mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status: "OPENED",
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });
    });

    describe("start_project_tests", () => {
      it("should execute openl_start_project_tests and store session headers", async () => {
        // Mock /tests/run endpoint - returns 202 with session headers
        const sessionHeaders = {
          "x-test-execution-id": "test-session-123",
          "set-cookie": ["JSESSIONID=abc123; Path=/"],
        } as any;

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        const result = await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("started");
        
        // Verify that headers were stored by checking that subsequent calls work
        // This is verified indirectly through get_test_results tests
      });

      it("should execute openl_start_project_tests with tableId", async () => {
        const sessionHeaders = {
          "x-test-execution-id": "test-session-456",
          "set-cookie": ["JSESSIONID=def456; Path=/"],
        } as any;

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`, undefined, {
          params: { tableId: "Test_calculatePremium_1234" },
        }).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        const result = await executeTool("start_project_tests", {
          projectId: "design-project1",
          tableId: "Test_calculatePremium_1234",
        }, client);

        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("started");
      });

      it("should auto-open project if closed", async () => {
        // Mock project as closed
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "design:project1:hash123",
          name: "project1",
          repository: "design",
          status: "CLOSED",
          path: "project1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });

        // Mock project open
        mockAxios.onPatch(`/projects/${encodedProjectId}`, {
          status: "OPENED",
        }).reply(200);

        const sessionHeaders = {
          "x-test-execution-id": "test-session-789",
        };

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        const result = await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        expect(result.content[0].text).toContain("automatically opened");
      });

      it("should propagate session headers from /tests/run response", async () => {
        const sessionHeaders = {
          "x-test-execution-id": "test-session-abc",
          "x-custom-header": "custom-value",
          "set-cookie": ["JSESSIONID=xyz789; Path=/"],
        } as any;

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        // Verify headers are stored by making a get_test_results call
        // Mock the /tests/summary endpoint and verify headers are sent
        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`).reply((config) => {
          // Verify that session headers are present in the request
          expect(config.headers).toHaveProperty("x-test-execution-id", "test-session-abc");
          expect(config.headers).toHaveProperty("x-custom-header", "custom-value");
          expect(config.headers).toHaveProperty("Cookie", "JSESSIONID=xyz789");
          expect(config.headers).toHaveProperty("Accept", "application/json");

          return [200, {
            testCases: [],
            executionTimeMs: 100,
            numberOfTests: 0,
            numberOfFailures: 0,
          }];
        });

        await executeTool("get_test_results_summary", {
          projectId: "design-project1",
        }, client);
      });
    });

    describe("get_test_results_summary", () => {
      it("should execute openl_get_test_results_summary with stored headers", async () => {
        // First, start test execution to store headers
        const sessionHeaders = {
          "x-test-execution-id": "test-session-summary",
          "set-cookie": ["JSESSIONID=summary123; Path=/"],
        } as any;

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        // Now get test results summary
        const mockSummary: Types.TestsExecutionSummary = {
          testCases: [],
          executionTimeMs: 250.5,
          numberOfTests: 10,
          numberOfFailures: 2,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`).reply((config) => {
          // Verify headers are propagated
          expect(config.headers).toHaveProperty("x-test-execution-id");
          expect(config.headers).toHaveProperty("Accept", "application/json");
          return [200, mockSummary];
        });

        const result = await executeTool("get_test_results_summary", {
          projectId: "design-project1",
        }, client);

        expect(result.content[0].type).toBe("text");
        const text = result.content[0].text;
        expect(text).toContain("Test Results Summary");
        expect(text).toContain("10"); // Total tests
        expect(text).toContain("8"); // Passed (10 - 2)
        expect(text).toContain("2"); // Failed
      });

      it("should error when no test session exists", async () => {
        // Client checks for headers first and throws before API call
        // But error gets wrapped by tool handler, so just check that error is thrown
        await expect(
          executeTool("get_test_results_summary", {
            projectId: "design-project1",
          }, client)
        ).rejects.toThrow();
      });

      it("should support failures parameter", async () => {
        // Start test execution
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-failures" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        // Get summary with failures parameter
        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { failures: 5 },
        }).reply(200, {
          testCases: [],
          executionTimeMs: 100,
          numberOfTests: 10,
          numberOfFailures: 2,
        });

        const result = await executeTool("get_test_results_summary", {
          projectId: "design-project1",
          failures: 5,
        }, client);

        expect(result.content[0].type).toBe("text");
      });

      it("should pass unpaged=true parameter", async () => {
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-summary-unpaged" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { unpaged: true },
        }).reply(200, {
          testCases: [],
          executionTimeMs: 100,
          numberOfTests: 10,
          numberOfFailures: 2,
        });

        const result = await executeTool("get_test_results_summary", {
          projectId: "design-project1",
          unpaged: true,
        }, client);

        expect(result.content[0].type).toBe("text");
      });
    });

    describe("get_test_results", () => {
      it("should execute openl_get_test_results with stored headers", async () => {
        // Start test execution
        const sessionHeaders = {
          "x-test-execution-id": "test-session-results",
          "set-cookie": ["JSESSIONID=results456; Path=/"],
        } as any;

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        // Get full test results
        const mockResults: Types.TestsExecutionSummary = {
          testCases: [
            {
              name: "Test_calculatePremium",
              tableId: "Test_calculatePremium_1234",
              executionTimeMs: 50,
              numberOfTests: 5,
              numberOfFailures: 0,
              testUnits: [],
            },
            {
              name: "Test_calculateDiscount",
              tableId: "Test_calculateDiscount_5678",
              executionTimeMs: 30,
              numberOfTests: 3,
              numberOfFailures: 1,
              testUnits: [],
            },
          ],
          executionTimeMs: 80,
          numberOfTests: 8,
          numberOfFailures: 1,
          pageNumber: 0,
          pageSize: 50,
          numberOfElements: 2,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`).reply((config) => {
          // Verify headers are propagated
          expect(config.headers).toHaveProperty("x-test-execution-id", "test-session-results");
          expect(config.headers).toHaveProperty("Cookie", "JSESSIONID=results456");
          expect(config.headers).toHaveProperty("Accept", "application/json");
          return [200, mockResults];
        });

        const result = await executeTool("get_test_results", {
          projectId: "design-project1",
        }, client);

        expect(result.content[0].type).toBe("text");
        const text = result.content[0].text;
        expect(text).toContain("Test Results");
        expect(text).toContain("Test_calculatePremium");
        expect(text).toContain("Test_calculateDiscount");
        expect(text).toContain("PASSED");
        expect(text).toContain("FAILED");
      });

      it("should error when no test session exists", async () => {
        // Client checks for headers first and throws before API call
        // But error gets wrapped by tool handler, so just check that error is thrown
        await expect(
          executeTool("get_test_results", {
            projectId: "design-project1",
          }, client)
        ).rejects.toThrow();
      });

      it("should support pagination parameters", async () => {
        // Start test execution
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-pagination" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        // Get results with pagination
        const mockResults: Types.TestsExecutionSummary = {
          testCases: [],
          executionTimeMs: 100,
          numberOfTests: 100,
          numberOfFailures: 5,
          pageNumber: 1,
          pageSize: 50,
          numberOfElements: 50,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { page: 1, size: 50 },
        }).reply(200, mockResults);

        const result = await executeTool("get_test_results", {
          projectId: "design-project1",
          page: 1,
          size: 50,
        }, client);

        expect(result.content[0].type).toBe("text");
        const text = result.content[0].text;
        // Verify pagination metadata is included
        // Pagination shows "Showing items 51-100" (offset 50 + 1 to offset 50 + limit 50)
        expect(text).toContain("51"); // First item (offset 50 + 1)
        expect(text).toContain("Pagination"); // Pagination section exists
      });

      it("should calculate offset correctly from pageNumber and pageSize", async () => {
        // Start test execution
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-offset" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        const mockResults: Types.TestsExecutionSummary = {
          testCases: [],
          executionTimeMs: 100,
          numberOfTests: 100,
          numberOfFailures: 5,
          pageNumber: 2,
          pageSize: 25,
          numberOfElements: 25,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { page: 2, size: 25 },
        }).reply(200, mockResults);

        const result = await executeTool("get_test_results", {
          projectId: "design-project1",
          page: 2,
          size: 25,
        }, client);

        expect(result.content[0].type).toBe("text");
        // Verify offset is calculated as pageNumber * pageSize = 2 * 25 = 50
        // Pagination shows "Showing items 51-75" (offset+1 to offset+limit)
        const text = result.content[0].text;
        expect(text).toContain("51"); // First item should be 51 (offset 50 + 1)
      });

      it("should support failuresOnly parameter", async () => {
        // Start test execution
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-failures-only" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { failuresOnly: true },
        }).reply(200, {
          testCases: [],
          executionTimeMs: 100,
          numberOfTests: 5,
          numberOfFailures: 5,
        });

        const result = await executeTool("get_test_results", {
          projectId: "design-project1",
          failuresOnly: true,
        }, client);

        expect(result.content[0].type).toBe("text");
      });

      it("should pass unpaged=true parameter", async () => {
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-results-unpaged" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { unpaged: true },
        }).reply(200, {
          testCases: [],
          executionTimeMs: 100,
          numberOfTests: 10,
          numberOfFailures: 2,
          pageNumber: 0,
          pageSize: 10,
          numberOfElements: 10,
        });

        const result = await executeTool("get_test_results", {
          projectId: "design-project1",
          unpaged: true,
        }, client);

        expect(result.content[0].type).toBe("text");
      });
    });

    describe("get_test_results_by_table", () => {
      it("should execute openl_get_test_results_by_table with stored headers", async () => {
        // Start test execution
        const sessionHeaders = {
          "x-test-execution-id": "test-session-by-table",
          "set-cookie": ["JSESSIONID=bytable789; Path=/"],
        } as any;

        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, sessionHeaders);

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        // Get results - mock should return results for page 0, empty for page 1+
        const allResults: Types.TestsExecutionSummary = {
          testCases: [
            {
              name: "Test_calculatePremium",
              tableId: "Test_calculatePremium_1234",
              executionTimeMs: 50,
              numberOfTests: 5,
              numberOfFailures: 0,
              testUnits: [],
            },
            {
              name: "Test_calculateDiscount",
              tableId: "Test_calculateDiscount_5678",
              executionTimeMs: 30,
              numberOfTests: 3,
              numberOfFailures: 1,
              testUnits: [],
            },
          ],
          executionTimeMs: 80,
          numberOfTests: 8,
          numberOfFailures: 1,
          pageNumber: 0,
          pageSize: 50,
          numberOfElements: 2,
          totalPages: 1,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`).reply((config) => {
          // Verify headers are propagated
          expect(config.headers).toHaveProperty("x-test-execution-id", "test-session-by-table");
          expect(config.headers).toHaveProperty("Cookie", "JSESSIONID=bytable789");
          expect(config.headers).toHaveProperty("Accept", "application/json");
          
          // Return empty results for pages > 0 to stop pagination
          const page = config.params?.page ?? 0;
          if (page > 0) {
            return [200, {
              testCases: [],
              executionTimeMs: 80,
              numberOfTests: 8,
              numberOfFailures: 1,
              pageNumber: page,
              pageSize: 50,
              numberOfElements: 0,
              totalPages: 1,
            }];
          }
          
          return [200, allResults];
        });

        const result = await executeTool("get_test_results_by_table", {
          projectId: "design-project1",
          tableId: "Test_calculatePremium_1234",
        }, client);

        expect(result.content[0].type).toBe("text");
        const text = result.content[0].text;
        // Should only contain results for the specified table
        expect(text).toContain("Test_calculatePremium");
        expect(text).not.toContain("Test_calculateDiscount");
      });

      it("should error when no test session exists", async () => {
        // Client checks for headers first and throws before API call
        // But error gets wrapped by tool handler, so just check that error is thrown
        await expect(
          executeTool("get_test_results_by_table", {
            projectId: "design-project1",
            tableId: "Test_calculatePremium_1234",
          }, client)
        ).rejects.toThrow();
      });

      it("should error when tableId is missing", async () => {
        await expect(
          executeTool("get_test_results_by_table", {
            projectId: "design-project1",
            // Missing tableId
          }, client)
        ).rejects.toThrow(/Missing required arguments.*tableId/);
      });

      it("should support pagination parameters", async () => {
        // Start test execution
        mockAxios.onPost(`/projects/${encodedProjectId}/tests/run`).reply(202, {
          status: "accepted",
        }, { "x-test-execution-id": "test-session-by-table-pagination" });

        await executeTool("start_project_tests", {
          projectId: "design-project1",
        }, client);

        const allResults: Types.TestsExecutionSummary = {
          testCases: [
            {
              name: "Test_calculatePremium",
              tableId: "Test_calculatePremium_1234",
              executionTimeMs: 50,
              numberOfTests: 5,
              numberOfFailures: 0,
              testUnits: [],
            },
          ],
          executionTimeMs: 50,
          numberOfTests: 5,
          numberOfFailures: 0,
          pageNumber: 0,
          pageSize: 50,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tests/summary`, {
          params: { page: 0, size: 50 },
        }).reply(200, allResults);

        const result = await executeTool("get_test_results_by_table", {
          projectId: "design-project1",
          tableId: "Test_calculatePremium_1234",
          page: 0,
          size: 50,
        }, client);

        expect(result.content[0].type).toBe("text");
      });
    });

    describe("Project Files (BETA) Tools", () => {
      it("openl_read_project_file returns UTF-8 text content verbatim", async () => {
        mockAxios.onGet("/projects/p1/files/readme.md").reply(200, "# Title\nbody", {
          "content-type": "text/markdown",
          "content-disposition": "attachment; filename=readme.md",
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "readme.md",
        }, client);

        expect(result.content[0].text).toBe("# Title\nbody");
      });

      it("openl_read_project_file base64-encodes binary content with metadata", async () => {
        const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]);
        mockAxios.onGet("/projects/p1/files/data.bin").reply(200, binary, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "data.bin",
          response_format: "json",
        }, client);

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.encoding).toBe("base64");
        expect(parsed.data.byteLength).toBe(5);
        expect(parsed.data.content).toBe(binary.toString("base64"));
      });

      it("openl_read_project_file applies a client-side byte range", async () => {
        mockAxios.onGet("/projects/p1/files/nums.txt").reply(200, "0123456789", {
          "content-type": "text/plain",
          "content-disposition": "attachment",
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "nums.txt",
          offset: 2,
          length: 3,
        }, client);

        expect(result.content[0].text).toBe("234");
      });

      it("openl_read_project_file caps oversized text at 25K and appends a continuation cursor", async () => {
        const big = "A".repeat(30000); // > 25K chars
        mockAxios.onGet("/projects/p1/files/big.txt").reply(200, big, {
          "content-type": "text/plain",
          "content-disposition": "attachment",
        });

        const result = await executeTool("read_project_file", { projectId: "p1", path: "big.txt" }, client);
        const text = result.content[0].text;
        expect(text.startsWith("A".repeat(100))).toBe(true);
        // First 25000 chars of content + a continuation note pointing at the next byte offset.
        expect(text).toContain("continue with offset=25000");
        expect(text.length).toBeLessThan(25000 + 300);
      });

      it("openl_read_project_file returns a folder listing as JSON", async () => {
        const listing = JSON.stringify([
          { path: "a.xlsx", name: "a.xlsx", type: "file" },
          { path: "sub", name: "sub", type: "folder" },
        ]);
        mockAxios.onGet(/\/projects\/p1\/files\/?/).reply(200, listing, {
          "content-type": "application/json",
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "",
          recursive: true,
          response_format: "json",
        }, client);

        const parsed = JSON.parse(result.content[0].text);
        expect(Array.isArray(parsed.data)).toBe(true);
        expect(parsed.data).toHaveLength(2);
      });

      it("openl_read_project_file returns file metadata for view=meta", async () => {
        const meta = JSON.stringify({ path: "a.xlsx", name: "a.xlsx", type: "file", size: 100 });
        mockAxios.onGet("/projects/p1/files/a.xlsx").reply(200, meta, {
          "content-type": "application/json",
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "a.xlsx",
          view: "meta",
          response_format: "json",
        }, client);

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.size).toBe(100);
      });

      it("openl_write_project_file decodes base64 and reports an uncommitted working-copy write", async () => {
        let captured: { data?: unknown; params?: Record<string, unknown> } = {};
        mockAxios.onPost("/projects/p1/files/docs/new.md").reply((config) => {
          captured = config;
          return [201, {}];
        });

        const result = await executeTool("write_project_file", {
          projectId: "p1",
          path: "docs/new.md",
          content: Buffer.from("hello").toString("base64"),
          encoding: "base64",
          response_format: "json",
        }, client);

        expect(Buffer.from(captured.data as Buffer).toString("utf-8")).toBe("hello");
        // createFolders default (true) is materialized by the handler.
        expect(captured.params?.createFolders).toBe(true);

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.bytesWritten).toBe(5);
        expect(parsed.data.committed).toBe(false);
      });

      it("openl_write_project_file with 'message' commits the write (save) and reports committed:true", async () => {
        mockAxios.onPost("/projects/p1/files/docs/x.md").reply(201, {});
        // saveProject(): GET project (EDITING, design) -> GET validation -> PATCH commit
        mockAxios.onGet("/projects/p1").reply(200, { id: "p1", name: "P", status: "EDITING", repository: "design" });
        mockAxios.onGet("/projects/p1/validation").reply(200, { valid: true, errors: [] });
        let patched: Record<string, unknown> = {};
        mockAxios.onPatch("/projects/p1").reply((config) => {
          patched = JSON.parse(config.data);
          return [204];
        });

        const result = await executeTool("write_project_file", {
          projectId: "p1",
          path: "docs/x.md",
          content: "hello",
          message: "add docs/x.md",
          response_format: "json",
        }, client);

        expect(patched.comment).toBe("add docs/x.md"); // committed via save (PATCH)
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.committed).toBe(true);
        expect(parsed.data.message).toContain("committed");
      });

      it("openl_delete_project_file deletes and reports success", async () => {
        mockAxios.onDelete("/projects/p1/files/old.txt").reply(204);

        const result = await executeTool("delete_project_file", {
          projectId: "p1",
          path: "old.txt",
          response_format: "json",
        }, client);

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.path).toBe("old.txt");
      });

      it("openl_search_project_files builds the query body and returns matches", async () => {
        const nodes = [{ path: "rules/M.xlsx", name: "M.xlsx", type: "file" }];
        let body: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          body = JSON.parse(config.data);
          return [200, nodes];
        });

        const result = await executeTool("search_project_files", {
          projectId: "p1",
          pattern: "**/*.xlsx",
          content: "premium",
          response_format: "json",
        }, client);

        expect(body).toEqual({ pattern: "**/*.xlsx", content: "premium" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data).toHaveLength(1);
        expect(parsed.data[0].name).toBe("M.xlsx");
      });

      it("openl_search_project_files paginates the match set client-side (limit/offset)", async () => {
        const nodes = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.xlsx`, name: `f${i}.xlsx`, type: "file" }));
        mockAxios.onPost("/projects/p1/file-search").reply(200, nodes);

        const page1 = JSON.parse((await executeTool("search_project_files", {
          projectId: "p1", pattern: "**/*.xlsx", limit: 2, offset: 0, response_format: "json",
        }, client)).content[0].text);
        expect(page1.data).toHaveLength(2);
        expect(page1.data[0].name).toBe("f0.xlsx");
        expect(page1.pagination).toMatchObject({ limit: 2, offset: 0, total_count: 5, has_more: true });

        const page3 = JSON.parse((await executeTool("search_project_files", {
          projectId: "p1", pattern: "**/*.xlsx", limit: 2, offset: 4, response_format: "json",
        }, client)).content[0].text);
        expect(page3.data).toHaveLength(1);
        expect(page3.data[0].name).toBe("f4.xlsx");
        expect(page3.pagination).toMatchObject({ total_count: 5, has_more: false });
      });

      it("openl_copy_project_file copies and reports source/destination", async () => {
        let body: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-copy").reply((config) => {
          body = JSON.parse(config.data);
          return [201];
        });

        const result = await executeTool("copy_project_file", {
          projectId: "p1",
          sourcePath: "rules/M.xlsx",
          destinationPath: "rules/M-copy.xlsx",
          response_format: "json",
        }, client);

        expect(body).toEqual({ sourcePath: "rules/M.xlsx", destinationPath: "rules/M-copy.xlsx" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.destinationPath).toBe("rules/M-copy.xlsx");
      });

      it("openl_move_project_file moves and reports source/destination", async () => {
        let body: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-move").reply((config) => {
          body = JSON.parse(config.data);
          return [204];
        });

        const result = await executeTool("move_project_file", {
          projectId: "p1",
          sourcePath: "rules/M.xlsx",
          destinationPath: "legacy/M.xlsx",
          response_format: "json",
        }, client);

        expect(body).toEqual({ sourcePath: "rules/M.xlsx", destinationPath: "legacy/M.xlsx" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.sourcePath).toBe("rules/M.xlsx");
      });

      it("openl_read_project_file forwards version and branch query params", async () => {
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet("/projects/p1/files/a.xlsx").reply((config) => {
          seenParams = config.params;
          return [200, "x", { "content-type": "text/plain", "content-disposition": "attachment" }];
        });

        await executeTool("read_project_file", {
          projectId: "p1",
          path: "a.xlsx",
          version: "rev1",
          branch: "dev",
        }, client);

        expect(seenParams).toMatchObject({ version: "rev1", branch: "dev" });
      });

      it("openl_read_project_file with encoding='utf-8' returns binary-ish bytes as raw text (no base64 envelope)", async () => {
        const bytes = Buffer.from([0x41, 0x00, 0x42]); // 'A', NUL, 'B' -> looksBinary true
        mockAxios.onGet("/projects/p1/files/data.bin").reply(200, bytes, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "data.bin",
          encoding: "utf-8",
        }, client);

        expect(result.content[0].text).toBe(bytes.toString("utf-8"));
        expect(result.content[0].text).not.toContain('"encoding":"base64"');
      });

      it("openl_read_project_file does not truncate a large base64 binary payload", async () => {
        // 30 KB of NUL bytes -> base64 ~40 KB, well past the 25k markdown cap.
        const big = Buffer.alloc(30000, 0);
        mockAxios.onGet("/projects/p1/files/big.bin").reply(200, big, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
        });

        // Default response_format (markdown): binary must still come back as an
        // intact JSON envelope, NOT a truncated markdown string.
        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "big.bin",
        }, client);

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.encoding).toBe("base64");
        expect(parsed.data.byteLength).toBe(30000);
        expect(Buffer.from(parsed.data.content, "base64").length).toBe(30000);
      });

      it("openl_read_project_file download=true returns a base64 ZIP and passes download=true", async () => {
        const zip = Buffer.from("PKfakezip");
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet(/\/projects\/p1\/files\//).reply((config) => {
          seenParams = config.params;
          return [200, zip, { "content-type": "application/zip", "content-disposition": "attachment; filename=rules.zip" }];
        });

        const result = await executeTool("read_project_file", {
          projectId: "p1",
          path: "rules/",
          download: true,
          response_format: "json",
        }, client);

        expect(seenParams?.download).toBe("true");
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.encoding).toBe("base64");
        expect(parsed.data.content).toBe(zip.toString("base64"));
      });

      it("openl_read_project_file auto-encoding boundary: 1/10 control chars stays text, 2/10 becomes base64", async () => {
        const oneCtrl = Buffer.concat([Buffer.from("A".repeat(9)), Buffer.from([0x01])]); // 1/10 -> text
        mockAxios.onGet("/projects/p1/files/a.txt").reply(200, oneCtrl, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
        });
        const textResult = await executeTool("read_project_file", { projectId: "p1", path: "a.txt" }, client);
        expect(textResult.content[0].text).toBe(oneCtrl.toString("utf-8"));

        mockAxios.reset();
        const twoCtrl = Buffer.concat([Buffer.from("A".repeat(8)), Buffer.from([0x01, 0x01])]); // 2/10 -> binary
        mockAxios.onGet("/projects/p1/files/b.txt").reply(200, twoCtrl, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
        });
        const binResult = await executeTool("read_project_file", { projectId: "p1", path: "b.txt", response_format: "json" }, client);
        expect(JSON.parse(binResult.content[0].text).data.encoding).toBe("base64");
      });

      it("openl_write_project_file create POSTs (no conflictPolicy param) and forwards branch", async () => {
        let captured: { params?: Record<string, unknown> } = {};
        mockAxios.onPost("/projects/p1/files/docs/x.md").reply((config) => {
          captured = config;
          return [201, {}];
        });

        const result = await executeTool("write_project_file", {
          projectId: "p1",
          path: "docs/x.md",
          content: "hi",
          branch: "dev",
          response_format: "json",
        }, client);

        // conflictPolicy must NOT be sent to the backend (it ignores it for single files).
        expect(captured.params).not.toHaveProperty("conflictPolicy");
        expect(captured.params?.branch).toBe("dev");
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.action).toBe("created");
        expect(parsed.data.branch).toBe("dev");
      });

      it("openl_write_project_file conflictPolicy=OVERWRITE replaces an existing file via PUT", async () => {
        let putBody = "";
        mockAxios.onPost("/projects/p1/files/docs/x.md").reply(409, { message: "already exists" });
        mockAxios.onPut("/projects/p1/files/docs/x.md").reply((config) => {
          putBody = Buffer.from(config.data as Buffer).toString("utf-8");
          return [204];
        });

        const result = await executeTool("write_project_file", {
          projectId: "p1",
          path: "docs/x.md",
          content: "v2-overwrite",
          conflictPolicy: "OVERWRITE",
          response_format: "json",
        }, client);

        expect(putBody).toBe("v2-overwrite");
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.action).toBe("overwritten");
      });

      it("openl_write_project_file conflictPolicy=SKIP leaves an existing file unchanged (no PUT)", async () => {
        let putCalled = false;
        mockAxios.onPost("/projects/p1/files/docs/x.md").reply(409, { message: "already exists" });
        mockAxios.onPut("/projects/p1/files/docs/x.md").reply(() => {
          putCalled = true;
          return [204];
        });

        const result = await executeTool("write_project_file", {
          projectId: "p1",
          path: "docs/x.md",
          content: "v2",
          conflictPolicy: "SKIP",
          response_format: "json",
        }, client);

        expect(putCalled).toBe(false);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.success).toBe(true);
        expect(parsed.data.skipped).toBe(true);
        expect(parsed.data.written).toBe(false);
      });

      it("openl_write_project_file rejects invalid base64 content before calling the API", async () => {
        let called = false;
        mockAxios.onPost("/projects/p1/files/x.bin").reply(() => {
          called = true;
          return [201, {}];
        });

        await expect(
          executeTool("write_project_file", {
            projectId: "p1",
            path: "x.bin",
            content: "not valid base64 @@@!!!",
            encoding: "base64",
          }, client)
        ).rejects.toThrow(/base64/i);
        expect(called).toBe(false);
      });

      it("openl_write_project_file surfaces a 409 conflict as an actionable error", async () => {
        mockAxios.onPost("/projects/p1/files/exists.md").reply(409, { message: "already exists" });

        await expect(
          executeTool("write_project_file", { projectId: "p1", path: "exists.md", content: "x" }, client)
        ).rejects.toThrow(/already exists|conflictPolicy/);
      });

      it("openl_search_project_files forwards extensions/type/scope=ANCESTORS/recursive/from/version", async () => {
        let body: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          body = JSON.parse(config.data);
          return [200, []];
        });

        await executeTool("search_project_files", {
          projectId: "p1",
          extensions: ["xlsx", "xml"],
          type: "FOLDER",
          scope: "ANCESTORS",
          recursive: true,
          from: "rules",
          version: "abc123",
        }, client);

        expect(body).toEqual({
          extensions: ["xlsx", "xml"],
          type: "FOLDER",
          scope: "ANCESTORS",
          recursive: true,
          from: "rules",
          version: "abc123",
        });
      });

      it("openl_copy_project_file surfaces a 409 destination conflict as an actionable error", async () => {
        mockAxios.onPost("/projects/p1/file-copy").reply(409, { message: "exists" });

        await expect(
          executeTool("copy_project_file", {
            projectId: "p1",
            sourcePath: "a.xlsx",
            destinationPath: "b.xlsx",
          }, client)
        ).rejects.toThrow(/already exists|different destinationPath/);
      });

      it("openl_move_project_file surfaces a 409 destination conflict as an actionable error", async () => {
        mockAxios.onPost("/projects/p1/file-move").reply(409, { message: "exists" });

        await expect(
          executeTool("move_project_file", {
            projectId: "p1",
            sourcePath: "a.xlsx",
            destinationPath: "b.xlsx",
          }, client)
        ).rejects.toThrow(/already exists|different destinationPath/);
      });

      it("openl_read_project_file rejects a path-traversal attempt", async () => {
        await expect(
          executeTool("read_project_file", { projectId: "p1", path: "rules/../../etc/passwd" }, client)
        ).rejects.toThrow(/project-relative|not allowed/);
      });

      it("openl_read_project_file requires projectId", async () => {
        await expect(
          executeTool("read_project_file", { path: "x" }, client)
        ).rejects.toThrow(/projectId/);
      });
    });
  });
});

// These suites were migrated from the former tests/mcp-server.test.ts. They use
// their OWN client/mockAxios so they stay isolated from the session state that
// the "Test Execution Tools" suite above stores on its shared client (a leaked
// JSESSIONID would flip the trace tests off their intended no-session path).
describe("Tool Handler Integration Tests — status, edits, creation & trace", () => {
  let client: OpenLClient;
  let mockAxios: MockAdapter;

  beforeAll(() => {
    const config: OpenLConfig = {
      baseUrl: "http://localhost:8080",
      personalAccessToken: "openl_pat_test",
    };

    client = new OpenLClient(config);
    // @ts-ignore Access private axios instance for mocking in integration tests
    mockAxios = new MockAdapter(client.axiosInstance);

    registerAllTools();
  });

  beforeEach(() => {
    mockAxios.reset();
  });

  afterAll(() => {
    mockAxios.restore();
  });

  describe("Project Status", () => {
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
        "project_status",
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
        "project_status",
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
        "project_status",
        { projectId, branch: "develop", response_format: "json" },
        client
      );
      expect(result.content[0].text).toContain("\"ok\"");
    });

    it("should validate projectId for openl_project_status", async () => {
      await expect(executeTool("project_status", {}, client)).rejects.toThrow(/projectId/);
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
        "project_status",
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
        "project_status",
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
        "project_status",
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
        "project_status",
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
        "project_status",
        { projectId, wait: true, response_format: "json" },
        client,
      );
      expect(result.content[0].text).toContain("\"ok\"");
      expect(result.content[0].text).not.toContain("INFO_SHOULD_BE_TRIMMED");
      expect(result.content[0].text).toContain("\"compiled\": 3");
    });
  });

  describe("Table Edits & ID Stability (EPBDS-16084/16085/16086)", () => {
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
        "update_table",
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
        "append_table",
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
        "append_table",
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
          "append_table",
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
        "append_table",
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
        "append_table",
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
        "append_table",
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
        "update_table",
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
        "append_table",
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
        "append_table",
        { projectId, tableId: oldId, appendData: { tableType: "Data", rows: [{ values: [1, 2, 3] }] } },
        client
      );

      // 2) A later read that still uses the pre-edit id is resolved automatically.
      mockAxios.reset();
      mockAxios.onGet(`/projects/${encoded}/tables/${oldId}`).reply(404, { message: "The table is not found." });
      mockAxios.onGet(`/projects/${encoded}/tables/${newId}`).reply(200, { id: newId, ...tableMeta, pos: "A1:C5" });

      const result = await executeTool(
        "get_table",
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
        "append_table",
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
        "update_table",
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
        executeTool("get_table", { projectId, tableId: "deadbeefdeadbeef" }, client)
      ).rejects.toThrow(/The table is not found.*does NOT mean the edit was rolled back.*openl_list_tables/s);
    });
  });

  describe("Branches & Deployments", () => {
    it("should execute openl_create_project_branch", async () => {
      const encoded = encodeProjectPath(projectId);
      mockAxios.onPost(`/projects/${encoded}/branches`, { branch: "feature/test-branch" }).reply(200);

      const result = await executeTool(
        "create_project_branch",
        { projectId, branchName: "feature/test-branch" },
        client
      );
      expect(result.content[0].text).toContain("Successfully created branch");
    });

    it("should execute openl_list_deployments", async () => {
      mockAxios.onGet("/deployments").reply(200, mockDeployments);

      const result = await executeTool("list_deployments", {}, client);
      expect(result.content[0].text).toContain("# Deployments");
    });
  });

  describe("Project Creation & Cloning", () => {
    it("should create an empty project and return the commit revision", async () => {
      mockAxios.onGet("/repos").reply(200, mockRepositories);
      mockAxios.onPut("/repos/design/projects/Offer-CW").reply(200, { revision: "abc123", branch: "main" });

      const result = await executeTool(
        "create_project",
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
        executeTool("create_project", { repository: "design", projectName: "Existing" }, client)
      ).rejects.toThrow(/already exists/i);
    });

    it("should reject a blank create when a branch is requested", async () => {
      mockAxios.onGet("/repos").reply(200, mockRepositories);
      await expect(
        executeTool("create_project", { repository: "design", projectName: "Offer-CW", branch: "dev" }, client)
      ).rejects.toThrow(/branch is only supported when cloning/i);
    });

    it("should clone a project through create-from-zip so it is indexed immediately (EPBDS-16088)", async () => {
      mockAxios.onGet("/repos").reply(200, mockRepositories);
      // Source project folder downloaded as a ZIP (entries are project-root-relative).
      mockAxios.onGet("/repos/design/files/Offer-US/").reply(200, "PK-zip-bytes");
      // Re-uploaded through the same indexing endpoint blank create uses.
      mockAxios.onPut("/repos/design/projects/Offer-CW").reply(200, { revision: "def456", branch: "main" });

      const result = await executeTool(
        "create_project",
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
        "create_project",
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
          "create_project",
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
          "create_project",
          { repository: "design", template: "Nope", projectName: "NewOne" },
          client
        )
      ).rejects.toThrow(/not found/i);
    });

    it("should validate required params for create", async () => {
      await expect(executeTool("create_project", {}, client)).rejects.toThrow(/repository|projectName/);
    });
  });

  // ---------------------------------------------------------------------------
  // Trace (EPBDS-16089: websocket-based wait while the trace is running).
  // The full wait orchestration (subscribe → race-close re-read → terminal
  // frame → final read) is unit-tested with an injected STOMP fake in
  // tests/stomp-waits.trace.test.ts; here we cover the tool-layer glue.
  // ---------------------------------------------------------------------------
  describe("Trace (EPBDS-16089)", () => {
    it("openl_get_trace_nodes returns nodes when the trace is already complete", async () => {
      const encoded = encodeProjectPath(projectId);
      const nodes = [{ id: 1, name: "calculatePremium", type: "rule" }];
      mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(200, nodes);

      const result = await executeTool(
        "get_trace_nodes",
        { projectId, response_format: "json" },
        client
      );

      expect(result.content[0].text).toContain("calculatePremium");
    });

    it("openl_get_trace_nodes with wait: false surfaces the 409 immediately", async () => {
      const encoded = encodeProjectPath(projectId);
      mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

      await expect(
        executeTool("get_trace_nodes", { projectId, wait: false }, client)
      ).rejects.toThrow(/409|still running/i);
      expect(mockAxios.history.get.filter((g) => g.url === `/projects/${encoded}/trace/nodes`).length).toBe(1);
    });

    it("openl_get_trace_nodes asks for tableId when the trace's table is unknown (EPBDS-16089)", async () => {
      // Unique project id: nothing recorded by openl_start_trace for it.
      const unknownProjectId = "design:trace-unknown:1";
      const encoded = encodeProjectPath(unknownProjectId);
      mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

      await expect(
        executeTool("get_trace_nodes", { projectId: unknownProjectId }, client)
      ).rejects.toThrow(/Pass 'tableId'/);
    });

    it("openl_get_trace_nodes explains when the websocket wait is unavailable (no studio session)", async () => {
      // The mocked axios layer never issues a JSESSIONID, so once the 409 arrives
      // the handler cannot join the trace-status websocket and must say so.
      const wsProjectId = "design:trace-no-session:1";
      const encoded = encodeProjectPath(wsProjectId);
      mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

      await expect(
        executeTool("get_trace_nodes", { projectId: wsProjectId, tableId: "rule_1" }, client)
      ).rejects.toThrow(/websocket.*unavailable.*session cookie|session cookie.*websocket/is);
    });

    it("openl_start_trace records the traced table so reads can subscribe without tableId (EPBDS-16089)", async () => {
      const traceProjectId = "design:trace-recorded:1";
      const encoded = encodeProjectPath(traceProjectId);
      mockAxios.onPost(/\/projects\/.*\/trace.*/).reply(202);
      mockAxios.onGet(`/projects/${encoded}/trace/nodes`).reply(409, { message: "Trace is still running" });

      const started = await executeTool(
        "start_trace",
        { projectId: traceProjectId, tableId: "calcRule_42", inputJson: { params: { x: 1 } } },
        client
      );
      expect(started.content[0].text).toContain("websocket");

      // No explicit tableId here — the handler must find the recorded one and
      // proceed to the websocket path (which then fails on the missing session
      // cookie rather than asking for tableId).
      await expect(
        executeTool("get_trace_nodes", { projectId: traceProjectId }, client)
      ).rejects.toThrow(/session cookie/i);
    });

    it("openl_export_trace supports the same websocket wait glue", async () => {
      const wsProjectId = "design:trace-export:1";
      const encoded = encodeProjectPath(wsProjectId);
      mockAxios.onGet(`/projects/${encoded}/trace/export`).reply(409, { message: "Trace is still running" });

      await expect(
        executeTool("export_trace", { projectId: wsProjectId, tableId: "rule_1" }, client)
      ).rejects.toThrow(/websocket.*unavailable|session cookie/is);

      // And returns the export verbatim when the trace is already complete.
      mockAxios.reset();
      mockAxios.onGet(`/projects/${encoded}/trace/export`).reply(200, "TRACE: calculatePremium -> 42");
      const result = await executeTool("export_trace", { projectId: wsProjectId, tableId: "rule_1" }, client);
      expect(result.content[0].text).toContain("calculatePremium -> 42");
    });
  });
});
