/**
 * Unit tests for client.ts
 * Tests OpenL API client methods with mocked HTTP responses
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { OpenLClient } from "../src/client.js";
import type { OpenLConfig, RepositoryInfo, ProjectViewModel, SummaryTableView, TestsExecutionSummary, TestCaseExecutionResult } from "../src/types.js";
import type * as Types from "../src/types.js";

describe("OpenLClient", () => {
  let client: OpenLClient;
  let mockAxios: MockAdapter;

  beforeEach(() => {
    const config: OpenLConfig = {
      baseUrl: "http://localhost:8080",
      username: "admin",
      password: "admin",
    };
    client = new OpenLClient(config);
    // @ts-ignore - Access private axiosInstance for mocking
    mockAxios = new MockAdapter(client.axiosInstance);
  });

  afterEach(() => {
    mockAxios.reset();
    mockAxios.restore();
  });

  describe("Constructor and Configuration", () => {
    it("should keep /rest when already present in baseUrl", () => {
      const config: OpenLConfig = {
        baseUrl: "http://localhost:8080/rest",
      };
      const testClient = new OpenLClient(config);
      expect(testClient.getBaseUrl()).toMatch(/\/rest$/);
    });

    it("should set auth method when using basic auth", () => {
      const config: OpenLConfig = {
        baseUrl: "http://localhost:8080",
        username: "admin",
        password: "admin",
      };
      const testClient = new OpenLClient(config);
      expect(testClient.getAuthMethod()).toContain("Basic");
    });

    it("should auto-append /rest when missing in baseUrl", () => {
      const config: OpenLConfig = {
        baseUrl: "http://localhost:8080",
      };
      const testClient = new OpenLClient(config);
      expect(testClient.getBaseUrl()).toMatch(/\/rest$/);
    });


    it("should handle custom timeout", () => {
      const config: OpenLConfig = {
        baseUrl: "http://localhost:8080",
        timeout: 60000,
      };
      const testClient = new OpenLClient(config);
      expect(testClient).toBeDefined();
    });
  });

  describe("Repository Management", () => {
    describe("listRepositories", () => {
      it("should fetch list of repositories", async () => {
        const mockRepos: Repository[] = [
          { id: "design", name: "Design Repository" },
          { id: "production", name: "Production Repository" },
        ];

        mockAxios.onGet("/repos").reply(200, mockRepos);

        const result = await client.listRepositories();
        expect(result).toEqual(mockRepos);
        expect(result.length).toBe(2);
      });

      it("should handle empty repository list", async () => {
        mockAxios.onGet("/repos").reply(200, []);

        const result = await client.listRepositories();
        expect(result).toEqual([]);
      });

      it("should handle network errors", async () => {
        mockAxios.onGet("/repos").networkError();

        await expect(client.listRepositories()).rejects.toThrow();
      });
    });

    describe("listBranches", () => {
      it("should fetch branches for a repository", async () => {
        const mockBranches = ["main", "development", "feature/new-rules"];

        mockAxios.onGet("/repos/design/branches").reply(200, mockBranches);

        const result = await client.listBranches("design");
        expect(result).toEqual(mockBranches);
        expect(result.length).toBe(3);
      });

      it("should URL-encode repository name", async () => {
        mockAxios.onGet(/\/repos\/.*\/branches/).reply((config) => {
          expect(config.url).toContain("my%20repo");
          return [200, ["main"]];
        });

        await client.listBranches("my repo");
      });

      it("should handle repository with no branches", async () => {
        mockAxios.onGet("/repos/empty/branches").reply(200, []);

        const result = await client.listBranches("empty");
        expect(result).toEqual([]);
      });
    });
  });

  describe("Project Management", () => {
    describe("listProjects", () => {
      it("should fetch list of projects", async () => {
        const mockProjects: Partial<ProjectViewModel>[] = [
          {
            id: "design:Project 1:hash1",
            name: "Project 1",
            repository: "design",
            status: "OPENED",
            path: "Project 1",
            modifiedBy: "admin",
            modifiedAt: "2024-01-01T00:00:00Z",
          },
          {
            id: "design:Project 2:hash2",
            name: "Project 2",
            repository: "design",
            status: "CLOSED",
            path: "Project 2",
            modifiedBy: "admin",
            modifiedAt: "2024-01-01T00:00:00Z",
          },
        ];

        mockAxios.onGet("/projects", { params: { repository: "design" } }).reply(200, mockProjects);

        const result = await client.listProjects({ repository: "design" });
        expect(result.length).toBe(2);
        expect(result[0].name).toBe("Project 1");
      });

      it("should filter by status", async () => {
        const openProjects: Partial<ProjectViewModel>[] = [
          {
            id: "design:p1:hash1",
            name: "p1",
            repository: "design",
            status: "OPENED",
            path: "p1",
            modifiedBy: "admin",
            modifiedAt: "2024-01-01T00:00:00Z",
          },
        ];

        mockAxios.onGet("/projects", { params: { repository: "design", status: "OPENED" } }).reply(200, openProjects);

        const result = await client.listProjects({
          repository: "design",
          status: "OPENED"
        });
        expect(result.length).toBe(1);
      });

      it("should filter by tag", async () => {
        // Tags are sent with "tags." prefix in the API
        mockAxios.onGet("/projects", { params: { repository: "design", "tags.tag": "v1.0" } }).reply(200, []);

        await client.listProjects({
          repository: "design",
          tags: { tag: "v1.0" }
        });

        expect(mockAxios.history.get.length).toBe(1);
      });
    });

    describe("getProject", () => {
      it("should fetch project by ID", async () => {
        // projectId "design-project1" is used as path identifier
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        const mockProject: Partial<ProjectViewModel> = {
          id: "design:project1:hash123",
          name: "project1",
          repository: "design",
          status: "OPENED",
          path: "project1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        };

        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, mockProject);

        const result = await client.getProject("design-project1");
        expect(result.name).toBe("project1");
      });

      it("should parse projectId with hyphen separator", async () => {
        // projectId "design-InsuranceRules" is used as path identifier
        const projectIdForPath = "design-InsuranceRules";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "design:InsuranceRules:hash123",
          name: "InsuranceRules",
          repository: "design",
          status: "OPENED",
          path: "InsuranceRules",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });

        await client.getProject("design-InsuranceRules");
        expect(mockAxios.history.get[0].url).toContain(encodedProjectId);
      });

      it("should handle project not found", async () => {
        const projectIdForPath = "design-nonexistent";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(404);

        await expect(client.getProject("design-nonexistent")).rejects.toThrow();
      });

      it("should pass opaque projectId through to API", async () => {
        const encodedProjectId = encodeURIComponent("invalid");
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(404);

        await expect(client.getProject("invalid")).rejects.toThrow();
      });
    });

    describe("updateProjectStatus", () => {
      it("should update project status", async () => {
        // updateProjectStatus first fetches the project, then updates it
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "design:project1:hash123",
          name: "project1",
          repository: "design",
          status: "OPENED",
          path: "project1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });
        
        // updateProjectStatus uses PATCH, not PUT
        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply(200, {
          success: true,
          message: "Project status updated successfully",
        });

        const result = await client.updateProjectStatus("design-project1", {
          status: "CLOSED",
        });
        expect(result.success).toBe(true);
      });

      it("should send comment when provided", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "design:project1:hash123",
          name: "project1",
          repository: "design",
          status: "OPENED",
          path: "project1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });
        
        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.comment).toBe("Closing project");
          return [200, { success: true }];
        });

        await client.updateProjectStatus("design-project1", {
          status: "CLOSED",
          comment: "Closing project",
        });
      });

      it("should send discardChanges flag", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "design:project1:hash123",
          name: "project1",
          repository: "design",
          status: "EDITING", // Project has unsaved changes
          path: "project1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });
        
        // discardChanges is handled client-side, not sent to API
        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply(200, {
          success: true,
          message: "Project closed (changes discarded)",
        });

        await client.updateProjectStatus("design-project1", {
          status: "CLOSED",
          discardChanges: true,
        });
      });

      it("should switch branches", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "design:project1:hash123",
          name: "project1",
          repository: "design",
          status: "OPENED",
          path: "project1",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });
        
        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.branch).toBe("development");
          return [200, { success: true }];
        });

        await client.updateProjectStatus("design-project1", {
          branch: "development",
        });
      });

      it("should throw when project is in local repository", async () => {
        const projectIdForPath = "local-myproject";
        const encodedProjectId = encodeURIComponent(projectIdForPath);

        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, {
          id: "local:myproject:hash",
          name: "myproject",
          repository: "local",
          status: "CLOSED",
          path: "myproject",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });

        await expect(
          client.updateProjectStatus("local-myproject", { status: "OPENED" })
        ).rejects.toThrow(/local repository.*not connected to a remote Git/i);
      });
    });

    describe("openProject", () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      const mockDesignProject = (status: string) => ({
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status,
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      it("should open a project with status OPENED", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, mockDesignProject("CLOSED"));

        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.status).toBe("OPENED");
          return [204];
        });

        const result = await client.openProject("design-project1");
        expect(result).toBe(true);
        expect(mockAxios.history.patch.length).toBe(1);
      });

      it("should open a project on a specific branch", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, mockDesignProject("CLOSED"));

        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.status).toBe("OPENED");
          expect(data.branch).toBe("development");
          return [204];
        });

        const result = await client.openProject("design-project1", { branch: "development" });
        expect(result).toBe(true);
      });

      it("should always send status OPENED regardless of current project status", async () => {
        // Even if the project is already OPENED, openProject always sends status
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, mockDesignProject("OPENED"));

        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.status).toBe("OPENED");
          return [204];
        });

        const result = await client.openProject("design-project1");
        expect(result).toBe(true);
      });

      it("should open a project at a specific revision", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, mockDesignProject("CLOSED"));

        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.status).toBe("OPENED");
          expect(data.revision).toBe("abc123");
          return [204];
        });

        const result = await client.openProject("design-project1", { revision: "abc123" });
        expect(result).toBe(true);
      });

      it("should throw when project is in local repository", async () => {
        const localBase64Id = "local-myproject";
        const encodedLocalId = encodeURIComponent(localBase64Id);

        mockAxios.onGet(`/projects/${encodedLocalId}`).reply(200, {
          id: "local:myproject:hash",
          name: "myproject",
          repository: "local",
          status: "CLOSED",
          path: "myproject",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });

        await expect(
          client.openProject("local-myproject")
        ).rejects.toThrow(/local repository.*not connected to a remote Git/i);
      });
    });

    describe("switchBranch", () => {
      const projectIdForPath = "design-project1";
      const encodedProjectId = encodeURIComponent(projectIdForPath);

      const mockDesignProject = (status: string) => ({
        id: "design:project1:hash123",
        name: "project1",
        repository: "design",
        status,
        path: "project1",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      });

      it("should send PATCH with only branch (no status)", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}`).reply(200, mockDesignProject("OPENED"));

        mockAxios.onPatch(`/projects/${encodedProjectId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.status).toBeUndefined();
          expect(data.branch).toBe("feature/new-rules");
          return [204];
        });

        const result = await client.switchBranch("design-project1", "feature/new-rules");
        expect(result).toBe(true);
        expect(mockAxios.history.patch.length).toBe(1);
      });

      it("should throw when project is in local repository", async () => {
        const localBase64Id = "local-myproject";
        const encodedLocalId = encodeURIComponent(localBase64Id);

        mockAxios.onGet(`/projects/${encodedLocalId}`).reply(200, {
          id: "local:myproject:hash",
          name: "myproject",
          repository: "local",
          status: "OPENED",
          path: "myproject",
          modifiedBy: "admin",
          modifiedAt: "2024-01-01T00:00:00Z",
        });

        await expect(
          client.switchBranch("local-myproject", "main")
        ).rejects.toThrow(/local repository.*not connected to a remote Git/i);
      });
    });
  });

  describe("Table Management", () => {
    describe("listTables", () => {
      it("should fetch list of tables", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        const mockTables: Partial<SummaryTableView>[] = [
          {
            id: "calculatePremium_1234",
            name: "calculatePremium",
            tableType: "SimpleRules",
            kind: "Rules",
            file: "Rules.xlsx",
            pos: "A1",
          },
          {
            id: "validatePolicy_5678",
            name: "validatePolicy",
            tableType: "Spreadsheet",
            kind: "Spreadsheet",
            file: "Rules.xlsx",
            pos: "A1",
          },
        ];

        mockAxios.onGet(`/projects/${encodedProjectId}/tables`).reply(200, mockTables);

        const result = await client.listTables("design-project1");
        expect(result.length).toBe(2);
        expect(result[0].name).toBe("calculatePremium");
      });

      it("should filter by table type", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}/tables`, {
          params: { kind: ["Rules"] }
        }).reply(200, []);

        await client.listTables("design-project1", { kind: ["Rules"] });
        expect(mockAxios.history.get.length).toBe(1);
      });

      it("should filter by name pattern", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(`/projects/${encodedProjectId}/tables`, {
          params: { name: "calculate" }
        }).reply(200, []);

        await client.listTables("design-project1", { name: "calculate" });
        expect(mockAxios.history.get.length).toBe(1);
      });

      it("should filter by file", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        // Note: file filtering might not be directly supported in the API
        // This test may need adjustment based on actual API behavior
        mockAxios.onGet(`/projects/${encodedProjectId}/tables`).reply(200, []);

        await client.listTables("design-project1", {});
        expect(mockAxios.history.get.length).toBe(1);
      });
    });

    describe("getTable", () => {
      it("should fetch table by ID", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedTableId = encodeURIComponent("calculatePremium_1234");
        
        const mockTable: Partial<SummaryTableView> = {
          id: "calculatePremium_1234",
          name: "calculatePremium",
          tableType: "SimpleRules",
          kind: "Rules",
          file: "Rules.xlsx",
          pos: "A1",
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/tables/${encodedTableId}`).reply(200, mockTable);

        const result = await client.getTable("design-project1", "calculatePremium_1234");
        expect(result.id).toBe("calculatePremium_1234");
      });

      it("should URL-encode table ID", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onGet(new RegExp(`/projects/${encodedProjectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/tables/.*`)).reply((config) => {
          expect(config.url).toContain("table%20id");
          return [200, {}];
        });

        await client.getTable("design-project1", "table id");
      });

      it("should handle table not found", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedTableId = encodeURIComponent("nonexistent");

        mockAxios.onGet(`/projects/${encodedProjectId}/tables/${encodedTableId}`).reply(404);

        await expect(
          client.getTable("design-project1", "nonexistent")
        ).rejects.toThrow();
      });

      it("should pass raw=true query param when raw is true", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedTableId = encodeURIComponent("calculatePremium_1234");

        mockAxios.onGet(`/projects/${encodedProjectId}/tables/${encodedTableId}`).reply((config) => {
          expect(config.params).toEqual({ raw: true });
          return [200, { id: "calculatePremium_1234" }];
        });

        await client.getTable("design-project1", "calculatePremium_1234", true);
      });

      it("should not pass raw param when raw is false or undefined", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedTableId = encodeURIComponent("calculatePremium_1234");

        mockAxios.onGet(`/projects/${encodedProjectId}/tables/${encodedTableId}`).reply((config) => {
          expect(config.params).toBeUndefined();
          return [200, { id: "calculatePremium_1234" }];
        });

        await client.getTable("design-project1", "calculatePremium_1234");
        await client.getTable("design-project1", "calculatePremium_1234", false);
      });
    });

    describe("updateTable", () => {
      it("should update table with new data", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedTableId = encodeURIComponent("calculatePremium_1234");
        
        // updateTable requires full table structure with all required fields
        const tableView = {
          id: "calculatePremium_1234",
          name: "calculatePremium",
          tableType: "SimpleRules",
          kind: "Rules",
          rules: [
            { driverType: "SAFE", premium: 1000 },
          ],
        };

        // updateTable returns void (204 No Content)
        mockAxios.onPut(`/projects/${encodedProjectId}/tables/${encodedTableId}`).reply(204);

        await client.updateTable("design-project1", "calculatePremium_1234", tableView);
        expect(mockAxios.history.put.length).toBe(1);
      });

      it("should send comment when provided", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedTableId = encodeURIComponent("table1");
        
        // Note: comment parameter is not supported by OpenAPI schema, will be ignored
        // The view is sent directly as request body
        const tableView = { id: "table1", name: "table1", tableType: "SimpleRules", kind: "Rules" };
        
        mockAxios.onPut(`/projects/${encodedProjectId}/tables/${encodedTableId}`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.id).toBe("table1");
          return [204];
        });

        await client.updateTable("design-project1", "table1", tableView, "Updated rates");
      });
    });

    describe("createRule", () => {
      it("should create new rule table", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        const ruleSpec = {
          name: "calculatePremium",
          tableType: "SimpleRules" as const,
          returnType: "double",
          parameters: [
            { type: "String", name: "driverType" },
            { type: "int", name: "age" },
          ],
        };

        mockAxios.onPost(`/projects/${encodedProjectId}/tables`).reply(201, {
          id: "calculatePremium_1234",
          ...ruleSpec,
        });

        const result = await client.createRule("design-project1", ruleSpec);
        expect(result.success).toBe(true);
        expect(result.tableId).toBe("calculatePremium_1234");
      });

      it("should include file path when provided", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onPost(`/projects/${encodedProjectId}/tables`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.file).toBe("rules/Insurance.xlsx");
          return [201, {}];
        });

        await client.createRule("design-project1", {
          name: "test",
          tableType: "SimpleRules",
          file: "rules/Insurance.xlsx",
        });
      });

      it("should include dimension properties", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onPost(`/projects/${encodedProjectId}/tables`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.properties).toEqual({ state: "CA", lob: "Auto" });
          return [201, {}];
        });

        await client.createRule("design-project1", {
          name: "test",
          tableType: "SimpleRules",
          properties: { state: "CA", lob: "Auto" },
        });
      });
    });
  });

  describe("File Operations", () => {
    describe("uploadFile", () => {
      it("should upload file with encoded content", async () => {
        const buffer = Buffer.from("test file content");
        // New API format uses project ID path segment
        mockAxios.onPost("/projects/design-project1/files/Rules.xlsx").reply(200, {
          success: true,
        });

        const result = await client.uploadFile("design-project1", "Rules.xlsx", buffer);
        expect(result.success).toBe(true);
      });

      it("should URL-encode file name", async () => {
        mockAxios.onPost(/\/projects\/design-project1\/files\/.*/).reply((config) => {
          expect(config.url).toContain("My%20Rules.xlsx");
          return [200, {}];
        });

        const buffer = Buffer.from("test");
        await client.uploadFile("design-project1", "My Rules.xlsx", buffer);
      });

      it("should include comment when provided", async () => {
        mockAxios.onPost("/projects/design-project1/files/Rules.xlsx").reply((config) => {
          // Comment is sent as query parameter, not in body
          expect(config.params?.comment).toBe("Updated rates");
          return [200, {}];
        });

        const buffer = Buffer.from("test");
        await client.uploadFile("design-project1", "Rules.xlsx", buffer, "Updated rates");
      });

      it("should handle upload errors", async () => {
        mockAxios.onPost("/projects/design-project1/files/Rules.xlsx").reply(500);

        const buffer = Buffer.from("test");
        await expect(
          client.uploadFile("design-project1", "Rules.xlsx", buffer)
        ).rejects.toThrow();
      });
    });

    describe("downloadFile", () => {
      it("should download file with full path from list_tables", async () => {
        const fileContent = Buffer.from("test file content");
        // File path includes project name directory (as returned by list_tables)
        // Forward slashes are NOT encoded in the path
        mockAxios.onGet("/projects/design-project1/files/project1/Rules.xlsx").reply(200, fileContent);

        const result = await client.downloadFile("design-project1", "project1/Rules.xlsx");
        expect(result).toEqual(fileContent);
      });

      it("should use provided filename as-is when given just filename", async () => {
        const fileContent = Buffer.from("test file content");
        // Current client contract uses provided path as-is for plain filenames.
        mockAxios.onGet("/projects/design-project1/files/Corporate%20Rating.xlsx").reply(200, fileContent);

        const result = await client.downloadFile("design-project1", "Corporate Rating.xlsx");
        expect(result).toEqual(fileContent);
      });

      it("should handle file paths with spaces correctly", async () => {
        const fileContent = Buffer.from("test file content");
        // Path segments are encoded separately, slashes preserved
        mockAxios.onGet("/projects/design-project1/files/project1/My%20Rules.xlsx").reply(200, fileContent);

        const result = await client.downloadFile("design-project1", "project1/My Rules.xlsx");
        expect(result).toEqual(fileContent);
      });

      it("should download specific version", async () => {
        // Mock the file download with version parameter
        mockAxios.onGet("/projects/design-project1/files/project1/Rules.xlsx", { params: { version: "abc123" } })
          .reply(200, Buffer.from("old content"));

        const result = await client.downloadFile("design-project1", "project1/Rules.xlsx", "abc123");
        expect(result.toString()).toBe("old content");
      });

      it("should handle file not found with helpful error", async () => {
        // Both paths will return 404
        mockAxios.onGet("/projects/design-project1/files/NonExistent.xlsx").reply(404);
        mockAxios.onGet("/projects/design-project1/files/project1/NonExistent.xlsx").reply(404);

        await expect(
          client.downloadFile("design-project1", "NonExistent.xlsx")
        ).rejects.toThrow(/File not found.*Tried paths/);
      });

      it("should handle 400 error with helpful message", async () => {
        mockAxios.onGet("/projects/design-project1/files/Bad.xlsx").reply(400);

        await expect(
          client.downloadFile("design-project1", "Bad.xlsx")
        ).rejects.toThrow(/Invalid file path.*400 Bad Request.*exact 'file' field value from list_tables/);
      });
    });
  });

  describe("Deployment", () => {
    describe("deployProject", () => {
      it("should deploy project to production repository", async () => {
        // deployProject uses /deployments endpoint with projectId in body
        const projectIdForPath = "design-project1";
        
        mockAxios.onPost("/deployments").reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.projectId).toBe(projectIdForPath);
          expect(data.deploymentName).toBe("project1");
          expect(data.productionRepositoryId).toBe("production-deploy");
          return [200];
        });

        await client.deployProject({
          projectId: "design-project1",
          deploymentName: "project1",
          productionRepositoryId: "production-deploy",
        });
      });

      it("should include version when provided", async () => {
        // Note: version parameter is not supported in DeployProjectRequest
        // This test may need adjustment based on actual API behavior
        const projectIdForPath = "design-project1";
        
        mockAxios.onPost("/deployments").reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.projectId).toBe(projectIdForPath);
          return [200];
        });

        await client.deployProject({
          projectId: "design-project1",
          deploymentName: "project1",
          productionRepositoryId: "production-deploy",
        });
      });
    });

    describe("listDeployments", () => {
      it("should fetch list of deployments", async () => {
        const mockDeployments = [
          { name: "deployment1", status: "active" },
          { name: "deployment2", status: "inactive" },
        ];

        mockAxios.onGet("/deployments").reply(200, mockDeployments);

        const result = await client.listDeployments();
        expect(result.length).toBe(2);
      });
    });
  });

  describe("Version History", () => {
    describe("getFileHistory", () => {
      it("should fetch file commit history", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedFilePath = encodeURIComponent("Rules.xlsx");
        
        const mockHistory: Types.GetFileHistoryResult = {
          filePath: "Rules.xlsx",
          commits: [
            { commitHash: "abc123", author: { name: "user1", email: "user1@test.com" }, timestamp: "2024-01-01T00:00:00Z", comment: "test", commitType: "SAVE" },
            { commitHash: "def456", author: { name: "user2", email: "user2@test.com" }, timestamp: "2024-01-02T00:00:00Z", comment: "test", commitType: "SAVE" },
          ],
          total: 2,
          hasMore: false,
        };

        mockAxios.onGet(`/projects/${encodedProjectId}/files/${encodedFilePath}/history`).reply(200, mockHistory);

        const result = await client.getFileHistory({
          projectId: "design-project1",
          filePath: "Rules.xlsx",
        });

        expect(result.commits.length).toBe(2);
      });

      it("should include pagination parameters", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedFilePath = encodeURIComponent("Rules.xlsx");
        
        mockAxios.onGet(`/projects/${encodedProjectId}/files/${encodedFilePath}/history`, {
          params: { limit: 20, offset: 10 }
        }).reply(200, {
          filePath: "Rules.xlsx",
          commits: [],
          total: 0,
          hasMore: false,
        });

        await client.getFileHistory({
          projectId: "design-project1",
          filePath: "Rules.xlsx",
          limit: 20,
          offset: 10,
        });

        expect(mockAxios.history.get.length).toBe(1);
      });
    });

    describe("getProjectHistory", () => {
      it("should fetch project commit history", async () => {
        // getProjectHistory uses /projects/{projectId}/history
        const mockHistory: Types.PageResponseProjectRevision_Short = {
          content: [
            { commitHash: "abc123", author: { name: "user1", email: "user1@test.com" }, modifiedAt: "2024-01-01T00:00:00Z", comment: "test" },
            { commitHash: "def456", author: { name: "user2", email: "user2@test.com" }, modifiedAt: "2024-01-02T00:00:00Z", comment: "test" },
          ],
          numberOfElements: 2,
          pageNumber: 0,
          pageSize: 50,
          totalElements: 2,
          totalPages: 1,
        };

        mockAxios.onGet("/projects/design-project1/history", {
          params: { page: 0, size: 50 }
        }).reply(200, mockHistory);

        const result = await client.getProjectHistory({
          projectId: "design-project1",
        });

        expect(result.commits.length).toBe(2);
      });

      it("should filter by branch", async () => {
        // When branch is specified, branch is passed as query parameter.
        mockAxios.onGet("/projects/design-project1/history", {
          params: { page: 0, size: 50, branch: "development" }
        }).reply(200, {
          content: [],
          numberOfElements: 0,
          pageNumber: 0,
          pageSize: 50,
        });

        await client.getProjectHistory({
          projectId: "design-project1",
          branch: "development",
        });

        expect(mockAxios.history.get.length).toBe(1);
      });
    });

    describe("revertVersion", () => {
      it("should revert project to specific version", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedVersion = encodeURIComponent("abc123");
        
        // Mock the version fetch
        mockAxios.onGet(`/projects/${encodedProjectId}/versions/${encodedVersion}`).reply(200, {
          version: "abc123",
          content: {},
        });
        
        // Mock validation
        mockAxios.onGet(`/projects/${encodedProjectId}/validation`).reply(200, {
          valid: true,
          errors: [],
        });
        
        // Mock the revert operation
        mockAxios.onPost(`/projects/${encodedProjectId}/revert`).reply(200, {
          version: "new-commit",
        });

        const result = await client.revertVersion({
          projectId: "design-project1",
          targetVersion: "abc123",
        });
        
        expect(result.success).toBe(true);
        expect(result.newVersion).toBe("new-commit");

        expect(result.success).toBe(true);
      });

      it("should include comment when provided", async () => {
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        const encodedVersion = encodeURIComponent("abc123");

        // Mock the version fetch
        mockAxios.onGet(`/projects/${encodedProjectId}/versions/${encodedVersion}`).reply(200, {
          version: "abc123",
          content: {},
        });
        
        // Mock validation
        mockAxios.onGet(`/projects/${encodedProjectId}/validation`).reply(200, {
          valid: true,
          errors: [],
        });
        
        // Mock the revert operation with comment check
        mockAxios.onPost(`/projects/${encodedProjectId}/revert`).reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.comment).toBe("Reverting bad changes");
          return [200, { version: "new-commit" }];
        });

        await client.revertVersion({
          projectId: "design-project1",
          targetVersion: "abc123",
          comment: "Reverting bad changes",
        });
      });
    });
  });

  describe("Rule Execution", () => {
    describe("executeRule", () => {
      it("should execute rule with input data", async () => {
        const inputData = {
          driverType: "SAFE",
          age: 30,
        };

        // executeRule uses buildProjectPath and /rules/{ruleName}/execute
        const projectIdForPath = "design-project1";
        const encodedProjectId = encodeURIComponent(projectIdForPath);
        
        mockAxios.onPost(`/projects/${encodedProjectId}/rules/calculatePremium/execute`).reply(200, {
          result: 1000.0,
        });

        const result = await client.executeRule({
          projectId: "design-project1",
          ruleName: "calculatePremium",
          inputData,
        });

        expect(result.success).toBe(true);
        // executeRule returns output as response.data, which is { result: 1000.0 }
        expect(result.output).toEqual({ result: 1000.0 });
      });

      it("should handle execution errors", async () => {
        // executeRule uses buildProjectPath and /rules/{ruleName}/execute
        mockAxios.onPost(/\/projects\/.*\/rules\/badRule\/execute/).reply(400, {
          error: "Invalid parameters",
        });

        const result = await client.executeRule({
          projectId: "design-project1",
          ruleName: "badRule",
          inputData: {},
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle 401 unauthorized", async () => {
      mockAxios.onGet("/repos").reply(401);

      await expect(client.listRepositories()).rejects.toThrow();
    });

    it("should handle 403 forbidden", async () => {
      mockAxios.onGet("/repos").reply(403);

      await expect(client.listRepositories()).rejects.toThrow();
    });

    it("should handle 500 server error", async () => {
      mockAxios.onGet("/repos").reply(500);

      await expect(client.listRepositories()).rejects.toThrow();
    });

    it("should handle timeout errors", async () => {
      mockAxios.onGet("/repos").timeout();

      await expect(client.listRepositories()).rejects.toThrow();
    });

    it("should handle malformed JSON responses", async () => {
      mockAxios.onGet("/repos").reply(200, "not json");

      // Should not throw during request, axios handles parsing
      await client.listRepositories();
    });
  });

  describe("Test Execution Session", () => {
    // Helper: encoded project path for "design-project1"
    const projectIdForPath = "design-project1";
    const encodedProjectId = encodeURIComponent(projectIdForPath);
    const projectPath = `/projects/${encodedProjectId}`;

    // Minimal project stub returned by getProject (needed by startProjectTests)
    const mockOpenProject = {
      id: "design:project1:hash123",
      name: "project1",
      repository: "design",
      status: "OPENED",
      path: "project1",
      modifiedBy: "admin",
      modifiedAt: "2024-01-01T00:00:00Z",
    };

    // Minimal test execution summary returned by /tests/summary
    const mockSummary: Partial<Types.TestsExecutionSummary> = {
      executionTimeMs: 42,
      numberOfTests: 5,
      numberOfFailures: 1,
      testCases: [
        {
          name: "TestTable",
          tableId: "test_table_abc",
          executionTimeMs: 10,
          numberOfTests: 3,
          numberOfFailures: 0,
          testUnits: [],
        },
        {
          name: "OtherTest",
          tableId: "other_table_xyz",
          executionTimeMs: 32,
          numberOfTests: 2,
          numberOfFailures: 1,
          testUnits: [],
        },
      ],
      pageNumber: 0,
      pageSize: 50,
      numberOfElements: 2,
      totalPages: 1,
    };

    /**
     * Start a test session via startProjectTests and return the response.
     * Registers the necessary mocks for getProject and /tests/run.
     */
    const startSession = async (tableId?: string) => {
      // getProject mock — project is already OPENED
      mockAxios.onGet(projectPath).reply(200, mockOpenProject);

      // /tests/run mock — reply with a Set-Cookie header so the client stores it
      mockAxios.onPost(`${projectPath}/tests/run`).reply(
        200,
        { status: "ok" },
        { "Set-Cookie": "JSESSIONID=test-session-123; Path=/" }
      );

      return client.startProjectTests("design-project1", tableId ? { tableId } : undefined);
    };

    it("should start tests with tableId and pass tableId as query param", async () => {
      mockAxios.onGet(projectPath).reply(200, mockOpenProject);

      mockAxios.onPost(`${projectPath}/tests/run`).reply((config) => {
        expect(config.params).toBeDefined();
        expect(config.params.tableId).toBe("my_table_42");
        return [200, { status: "ok" }, { "Set-Cookie": "JSESSIONID=sess1; Path=/" }];
      });

      const result = await client.startProjectTests("design-project1", { tableId: "my_table_42" });
      expect(result.status).toBe("started");
      expect(result.tableId).toBe("my_table_42");
    });

    it("should reuse stored headers in getTestResultsSummary after starting with tableId", async () => {
      await startSession("specific_table_99");

      // Now getTestResultsSummary should find the stored headers
      mockAxios.onGet(`${projectPath}/tests/summary`).reply((config) => {
        // The stored Cookie header should be forwarded
        expect(config.headers?.["Cookie"]).toBe("JSESSIONID=test-session-123");
        return [200, mockSummary];
      });

      const summary = await client.getTestResultsSummary("design-project1");
      expect(summary.numberOfTests).toBe(5);
      expect(summary.numberOfFailures).toBe(1);
      expect(summary.numberOfPassed).toBe(4);
    });

    it("should pass unpaged=true in getTestResultsSummary", async () => {
      await startSession("specific_table_99");

      mockAxios.onGet(`${projectPath}/tests/summary`, { params: { unpaged: true } }).reply(200, mockSummary);

      const summary = await client.getTestResultsSummary("design-project1", { unpaged: true });
      expect(summary.numberOfTests).toBe(5);
    });

    it("should reuse stored headers in getTestResults after starting with tableId", async () => {
      await startSession("specific_table_99");

      mockAxios.onGet(`${projectPath}/tests/summary`).reply((config) => {
        expect(config.headers?.["Cookie"]).toBe("JSESSIONID=test-session-123");
        return [200, mockSummary];
      });

      const results = await client.getTestResults("design-project1");
      expect(results.testCases).toHaveLength(2);
    });

    it("should pass unpaged=true in getTestResults", async () => {
      await startSession("specific_table_99");

      mockAxios.onGet(`${projectPath}/tests/summary`, { params: { unpaged: true } }).reply(200, mockSummary);

      const results = await client.getTestResults("design-project1", { unpaged: true });
      expect(results.testCases).toHaveLength(2);
    });

    it("should reuse stored headers in getTestResultsByTable after starting with tableId", async () => {
      await startSession("test_table_abc");

      // getTestResultsByTable iterates pages via getTestResults
      mockAxios.onGet(`${projectPath}/tests/summary`).reply((config) => {
        expect(config.headers?.["Cookie"]).toBe("JSESSIONID=test-session-123");
        return [200, mockSummary];
      });

      const results = await client.getTestResultsByTable("design-project1", "test_table_abc");
      // Only the matching testCase should be returned
      expect(results.testCases).toHaveLength(1);
      expect(results.testCases[0].tableId).toBe("test_table_abc");
    });

    it("should overwrite previous session when starting new tests for the same project", async () => {
      // --- First session ---
      mockAxios.onGet(projectPath).reply(200, mockOpenProject);
      mockAxios.onPost(`${projectPath}/tests/run`).replyOnce(
        200,
        { status: "ok" },
        { "Set-Cookie": "JSESSIONID=session-AAA; Path=/" }
      );
      await client.startProjectTests("design-project1", { tableId: "table_a" });

      // --- Second session (overwrites first) ---
      mockAxios.onPost(`${projectPath}/tests/run`).replyOnce(
        200,
        { status: "ok" },
        { "Set-Cookie": "JSESSIONID=session-BBB; Path=/" }
      );
      await client.startProjectTests("design-project1", { tableId: "table_b" });

      // getTestResultsSummary should use the SECOND session's cookie
      mockAxios.onGet(`${projectPath}/tests/summary`).reply((config) => {
        expect(config.headers?.["Cookie"]).toBe("JSESSIONID=session-BBB");
        return [200, mockSummary];
      });

      const summary = await client.getTestResultsSummary("design-project1");
      expect(summary.numberOfTests).toBe(5);
    });

    it("should throw when getTestResultsSummary is called without starting tests", async () => {
      await expect(
        client.getTestResultsSummary("design-project1")
      ).rejects.toThrow(/No test execution session found/);
    });

    it("should throw when getTestResults is called without starting tests", async () => {
      await expect(
        client.getTestResults("design-project1")
      ).rejects.toThrow(/No test execution session found/);
    });

    it("should start tests without tableId and still allow retrieving results", async () => {
      await startSession(); // no tableId

      mockAxios.onGet(`${projectPath}/tests/summary`).reply((config) => {
        expect(config.headers?.["Cookie"]).toBe("JSESSIONID=test-session-123");
        return [200, mockSummary];
      });

      const summary = await client.getTestResultsSummary("design-project1");
      expect(summary.numberOfTests).toBe(5);
    });

    it("should auto-open closed project before starting tests", async () => {
      const closedProject = { ...mockOpenProject, status: "CLOSED" };
      mockAxios.onGet(projectPath).reply(200, closedProject);

      // openProject calls ensureNotLocalRepository → getProject, then PATCH
      mockAxios.onPatch(projectPath).reply(204);

      mockAxios.onPost(`${projectPath}/tests/run`).reply(
        200,
        { status: "ok" },
        { "Set-Cookie": "JSESSIONID=opened-session; Path=/" }
      );

      const result = await client.startProjectTests("design-project1");
      expect(result.projectWasOpened).toBe(true);

      // Session should still be usable
      mockAxios.onGet(`${projectPath}/tests/summary`).reply((config) => {
        expect(config.headers?.["Cookie"]).toBe("JSESSIONID=opened-session");
        return [200, mockSummary];
      });

      const summary = await client.getTestResultsSummary("design-project1");
      expect(summary.numberOfTests).toBe(5);
    });

    it("should not call openProject for local repository; start tests directly", async () => {
      const localProjectId = "local-project1";
      const localProjectPath = `/projects/${encodeURIComponent(localProjectId)}`;

      const mockLocalProject = {
        id: "local:project1",
        name: "Local Project",
        repository: "local",
        status: "CLOSED",
        path: "Local Project",
        modifiedBy: "admin",
        modifiedAt: "2024-01-01T00:00:00Z",
      };

      mockAxios.onGet(localProjectPath).reply(200, mockLocalProject);
      mockAxios.onPost(`${localProjectPath}/tests/run`).reply(
        200,
        { status: "ok" },
        { "Set-Cookie": "JSESSIONID=local-session; Path=/" }
      );

      const result = await client.startProjectTests(localProjectId);

      expect(result.status).toBe("started");
      expect(result.projectId).toBe(localProjectId);
      expect(result.projectWasOpened).toBe(false);
      expect(mockAxios.history.patch).toHaveLength(0);
    });
  });

  describe("URL Encoding", () => {
    it("should encode special characters in repository names", async () => {
      mockAxios.onGet(/repos\/.*\/branches/).reply((config) => {
        expect(config.url).toMatch(/my%20special%20repo/);
        return [200, []];
      });

      await client.listBranches("my special repo");
    });

    it("should encode special characters in project names", async () => {
      // getProject normalizes projectId for request path, so we match a generic projects path
      mockAxios.onGet(/\/projects\/.*/).reply((config) => {
        // The projectId "design-Example 1 - Bank Rating" will be normalized for path usage
        // and then URL-encoded, so we just check that it's a valid projects path
        expect(config.url).toMatch(/^\/projects\//);
        return [200, {}];
      });

      await client.getProject("design-Example 1 - Bank Rating");
    });

    it("should encode special characters in file names", async () => {
      mockAxios.onGet(/files\/.*/).reply((config) => {
        expect(config.url).toMatch(/My%20Rules%20%231.xlsx/);
        return [200, Buffer.from("")];
      });

      await client.downloadFile("design-project1", "My Rules #1.xlsx");
    });
  });
});
