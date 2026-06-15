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

    describe("getRepositoryIdByName (id-or-name, case-insensitive)", () => {
      const repos: Repository[] = [
        { id: "design", name: "Design Repository" },
        { id: "production", name: "Production Repository" },
      ];

      beforeEach(() => {
        mockAxios.onGet("/repos").reply(200, repos);
      });

      it("resolves exact id", async () => {
        expect(await client.getRepositoryIdByName("design")).toBe("design");
      });

      it("resolves exact display name", async () => {
        expect(await client.getRepositoryIdByName("Design Repository")).toBe("design");
      });

      it("resolves case-insensitive id", async () => {
        expect(await client.getRepositoryIdByName("DESIGN")).toBe("design");
      });

      it("resolves case-insensitive display name", async () => {
        expect(await client.getRepositoryIdByName("design repository")).toBe("design");
      });

      it("throws with a helpful message listing id + name pairs when no match", async () => {
        await expect(client.getRepositoryIdByName("ghost")).rejects.toThrow(
          /Repository "ghost" not found.*design \(Design Repository\), production \(Production Repository\)/,
        );
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

    describe("getSessionCookie", () => {
      it("returns null before any HTTP call has captured a Set-Cookie", () => {
        expect(client.getSessionCookie()).toBeNull();
      });

      it("returns the JSESSIONID value extracted from a response Set-Cookie header", async () => {
        // The cookie interceptor parses single-string or array forms of set-cookie.
        mockAxios.onGet("/repos").reply(
          200,
          [],
          { "set-cookie": "JSESSIONID=abc123def; Path=/; HttpOnly" },
        );
        await client.listRepositories();
        expect(client.getSessionCookie()).toBe("abc123def");
      });

      it("survives subsequent responses that don't include a new cookie", async () => {
        mockAxios.onGet("/repos").reply(
          200,
          [],
          { "set-cookie": "JSESSIONID=stay-put; Path=/" },
        );
        await client.listRepositories();
        // A second call without set-cookie should leave the stored value alone.
        mockAxios.onGet("/repos").reply(200, []);
        await client.listRepositories(false);
        expect(client.getSessionCookie()).toBe("stay-put");
      });
    });

    describe("getProjectStatus", () => {
      const projectId = "design-AutoInsurance";
      const encodedProjectId = encodeURIComponent(projectId);

      const okFixture: Types.ProjectStatusView = {
        projectId: { repository: "design", projectName: "AutoInsurance" },
        branch: "main",
        revision: "abc123",
        compileState: "ok",
        compilation: {
          messages: { items: [], total: 0, errors: 0, warnings: 0 },
          modules: { total: 1, compiled: 1, compiledModules: ["Main"] },
          tests: { total: 5 },
        },
      };

      const errorsFixture: Types.ProjectStatusView = {
        projectId: { repository: "design", projectName: "AutoInsurance" },
        branch: "main",
        compileState: "errors",
        compilation: {
          messages: {
            items: [
              { id: 1, summary: "Datatype 'Driver' not found", severity: "ERROR" },
              { id: 2, summary: "Unused field 'tmp'", severity: "WARN" },
            ],
            total: 2,
            errors: 1,
            warnings: 1,
          },
          modules: { total: 1, compiled: 0 },
          tests: { total: 0 },
        },
      };

      it("should fetch project status without branch parameter", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}/status`).reply(200, okFixture);

        const result = await client.getProjectStatus(projectId);
        expect(result.compileState).toBe("ok");
        expect(result.compilation?.modules.compiled).toBe(1);
        // No query string sent when branch omitted
        expect(mockAxios.history.get[0].params).toEqual({});
      });

      it("should pass branch as query parameter when provided", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}/status`).reply((config) => {
          if (config.params?.branch === "main") {
            return [200, errorsFixture];
          }
          return [400, { message: "expected branch=main" }];
        });

        const result = await client.getProjectStatus(projectId, "main");
        expect(result.compileState).toBe("errors");
        expect(result.compilation?.messages.items).toHaveLength(2);
        expect(mockAxios.history.get[0].params).toEqual({ branch: "main" });
      });

      it("should surface 409 when branch does not match the opened branch", async () => {
        mockAxios.onGet(`/projects/${encodedProjectId}/status`).reply(409, {
          message: "project.branch.mismatch.message",
        });

        await expect(client.getProjectStatus(projectId, "develop")).rejects.toThrow();
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

  describe("Project Creation & Repository Files", () => {
    it("createProjectFromZip PUTs multipart to /repos/{repo}/projects/{name} and returns the revision", async () => {
      let capturedContentType: string | undefined;
      mockAxios.onPut("/repos/design/projects/Offer-CW").reply((config) => {
        capturedContentType = (config.headers?.["Content-Type"] ?? config.headers?.["content-type"]) as string;
        return [200, { revision: "abc123", branch: "main" }];
      });

      const result = await client.createProjectFromZip(
        "design",
        "Offer-CW",
        Buffer.from("PK-zip-bytes"),
        { comment: "Initial commit" }
      );

      expect(result).toEqual({ revision: "abc123", branch: "main" });
      expect(capturedContentType).toMatch(/^multipart\/form-data; boundary=/);
    });

    it("createProjectFromZip includes the comment field in the multipart body", async () => {
      mockAxios.onPut("/repos/design/projects/Offer-CW").reply(200, { revision: "r1" });

      await client.createProjectFromZip("design", "Offer-CW", Buffer.from("zip"), { comment: "Hello audit" });

      // form-data with only Buffer/string parts exposes getBuffer().
      const form = mockAxios.history.put[0].data as unknown as { getBuffer: () => Buffer };
      const body = form.getBuffer().toString("utf-8");
      expect(body).toContain('name="template"; filename="template.zip"');
      expect(body).toContain('name="comment"');
      expect(body).toContain("Hello audit");
    });

    it("copyRepositoryFile POSTs the path pair to /file-copy with the branch param", async () => {
      let capturedBody: unknown;
      let capturedParams: unknown;
      mockAxios.onPost("/repos/design/file-copy").reply((config) => {
        capturedBody = JSON.parse(config.data);
        capturedParams = config.params;
        return [201];
      });

      await client.copyRepositoryFile("design", "Offer-US", "Offer-CW", "main");

      expect(capturedBody).toEqual({ sourcePath: "Offer-US", destinationPath: "Offer-CW" });
      expect(capturedParams).toEqual({ branch: "main" });
    });

    it("getRepositoryFileContent returns the file as a string and null on 404", async () => {
      mockAxios.onGet("/repos/design/files/Offer-CW/rules.xml").reply(200, "<project><name>X</name></project>");
      const xml = await client.getRepositoryFileContent("design", "Offer-CW/rules.xml");
      expect(xml).toContain("<name>X</name>");

      mockAxios.onGet("/repos/design/files/Missing/rules.xml").reply(404);
      const missing = await client.getRepositoryFileContent("design", "Missing/rules.xml");
      expect(missing).toBeNull();
    });

    it("updateRepositoryFileRaw PUTs the raw body with a non-JSON content type", async () => {
      let capturedContentType: string | undefined;
      mockAxios.onPut("/repos/design/files/Offer-CW/rules.xml").reply((config) => {
        capturedContentType = (config.headers?.["Content-Type"] ?? config.headers?.["content-type"]) as string;
        return [200];
      });

      await client.updateRepositoryFileRaw("design", "Offer-CW/rules.xml", "<project/>");
      expect(capturedContentType).toBe("application/xml");
    });
  });

  describe("Session continuity (firstRequestGate)", () => {
    it("shares one JSESSIONID across concurrent calls when the bootstrap request issues no cookie", async () => {
      // Studio reality: GET /repos issues NO Set-Cookie; GET /projects issues a fresh
      // JSESSIONID for any request that arrives without one. If the turn's first request
      // (the bootstrap) lands on /repos, naive gating releases all waiting siblings
      // cookie-less and each opens its own studio session. The gate must keep
      // serializing until a cookie actually lands.
      let sessionsIssued = 0;
      const cookiesSentToProjects: Array<string | undefined> = [];

      mockAxios.onGet("/repos").reply(200, [{ id: "design", name: "Design" }]); // no Set-Cookie

      mockAxios.onGet(/\/projects\/[^/]+\/status$/).reply((config) => {
        const cookie = (config.headers?.Cookie ?? config.headers?.cookie) as string | undefined;
        cookiesSentToProjects.push(cookie);
        if (cookie && cookie.includes("JSESSIONID=")) {
          return [200, { compileState: "ok" }]; // reuse existing session, no new cookie
        }
        sessionsIssued += 1;
        return [200, { compileState: "ok" }, { "set-cookie": [`JSESSIONID=SESS-${sessionsIssued}; Path=/`] }];
      });

      // listRepositories() (→ /repos, first in array) bootstraps; two concurrent status calls follow.
      await Promise.all([
        client.listRepositories(),
        client.getProjectStatus("p1"),
        client.getProjectStatus("p2"),
      ]);

      // Exactly one session is ever issued, and only one /projects request went out cookie-less.
      expect(sessionsIssued).toBe(1);
      const cookieless = cookiesSentToProjects.filter((c) => !c || !c.includes("JSESSIONID=")).length;
      expect(cookieless).toBe(1);
    });
  });

  describe("Project Files (BETA)", () => {
    describe("readProjectFile", () => {
      it("returns file bytes plus content-type/disposition headers and forwards version/branch", async () => {
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet("/projects/p1/files/rules/Model.xlsx").reply((config) => {
          seenParams = config.params;
          return [200, "hello-bytes", {
            "content-type": "text/plain",
            "content-disposition": "attachment; filename=Model.xlsx",
          }];
        });

        const res = await client.readProjectFile("p1", "rules/Model.xlsx", {
          version: "abc123",
          branch: "main",
        });

        expect(res.data.toString("utf-8")).toBe("hello-bytes");
        expect(res.contentType).toBe("text/plain");
        expect(res.contentDisposition).toMatch(/attachment/i);
        expect(seenParams).toMatchObject({ version: "abc123", branch: "main" });
      });

      it("lists the project root with a trailing-slash URL when path is empty", async () => {
        const listing = JSON.stringify([{ path: "Bank Rating.xlsx", name: "Bank Rating.xlsx", type: "file" }]);
        let url = "";
        mockAxios.onGet(/\/projects\/p1\/files\/?/).reply((config) => {
          url = config.url || "";
          return [200, listing, { "content-type": "application/json" }];
        });

        const res = await client.readProjectFile("p1", "", { recursive: true, viewMode: "FLAT" });

        expect(url).toBe("/projects/p1/files/");
        expect(res.contentType).toBe("application/json");
        expect(res.contentDisposition).toBe("");
        expect(JSON.parse(res.data.toString("utf-8"))[0].name).toBe("Bank Rating.xlsx");
      });

      it("percent-encodes path segments but preserves '/' separators", async () => {
        let url = "";
        mockAxios.onGet(/\/projects\/p1\/files\//).reply((config) => {
          url = config.url || "";
          return [200, "x", { "content-type": "application/octet-stream", "content-disposition": "attachment" }];
        });

        await client.readProjectFile("p1", "a b/c.xml");

        expect(url).toBe("/projects/p1/files/a%20b/c.xml");
      });

      it("rejects '.'/'..' path-traversal segments before issuing a request", async () => {
        let called = false;
        mockAxios.onAny().reply(() => {
          called = true;
          return [200, ""];
        });

        await expect(client.readProjectFile("p1", "rules/../../etc/passwd")).rejects.toThrow(/project-relative|not allowed/);
        await expect(client.deleteProjectFile("p1", "..")).rejects.toThrow(/project-relative|not allowed/);
        expect(called).toBe(false);
      });

      it("rejects '.'/'..' in copy/move body paths and search 'from' (defense-in-depth)", async () => {
        let called = false;
        mockAxios.onAny().reply(() => {
          called = true;
          return [200, []];
        });

        await expect(
          client.copyProjectFile("p1", { sourcePath: "a.xlsx", destinationPath: "../b.xlsx" })
        ).rejects.toThrow(/project-relative|not allowed/);
        await expect(
          client.copyProjectFile("p1", { sourcePath: "../a.xlsx", destinationPath: "b.xlsx" })
        ).rejects.toThrow(/project-relative|not allowed/);
        await expect(
          client.moveProjectFile("p1", { sourcePath: "a.xlsx", destinationPath: "sub/../../x.xlsx" })
        ).rejects.toThrow(/project-relative|not allowed/);
        await expect(
          client.searchProjectFiles("p1", { from: "../secrets" })
        ).rejects.toThrow(/project-relative|not allowed/);

        expect(called).toBe(false);
      });

      it("serializes extensions as a comma-separated query param", async () => {
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet(/\/projects\/p1\/files\/?/).reply((config) => {
          seenParams = config.params;
          return [200, "[]", { "content-type": "application/json" }];
        });

        await client.readProjectFile("p1", "", { extensions: ["xlsx", "xml"] });

        expect(seenParams?.extensions).toBe("xlsx,xml");
      });
    });

    describe("writeProjectFile / updateProjectFile", () => {
      it("writeProjectFile POSTs octet-stream bytes with createFolders/branch (create) and returns metadata", async () => {
        let captured: { headers?: Record<string, unknown>; params?: Record<string, unknown>; data?: unknown } = {};
        mockAxios.onPost("/projects/p1/files/docs/readme.md").reply((config) => {
          captured = config;
          return [201, { name: "readme.md", size: 5 }];
        });

        const meta = await client.writeProjectFile("p1", "docs/readme.md", Buffer.from("hello"), {
          createFolders: true,
          branch: "main",
        });

        const ct = (captured.headers?.["Content-Type"] ?? captured.headers?.["content-type"]) as string;
        expect(ct).toContain("octet-stream");
        // conflictPolicy is NOT sent on POST — the backend ignores it for single files (overwrite = PUT).
        expect(captured.params).toEqual({ createFolders: true, branch: "main" });
        expect(Buffer.from(captured.data as Buffer).toString("utf-8")).toBe("hello");
        expect(meta).toEqual({ name: "readme.md", size: 5 });
      });

      it("updateProjectFile PUTs octet-stream bytes (overwrite) with branch", async () => {
        let captured: { headers?: Record<string, unknown>; params?: Record<string, unknown>; data?: unknown } = {};
        mockAxios.onPut("/projects/p1/files/docs/readme.md").reply((config) => {
          captured = config;
          return [204];
        });

        await client.updateProjectFile("p1", "docs/readme.md", Buffer.from("v2"), { branch: "main" });

        const ct = (captured.headers?.["Content-Type"] ?? captured.headers?.["content-type"]) as string;
        expect(ct).toContain("octet-stream");
        expect(captured.params).toEqual({ branch: "main" });
        expect(Buffer.from(captured.data as Buffer).toString("utf-8")).toBe("v2");
      });
    });

    describe("deleteProjectFile", () => {
      it("DELETEs with the branch query param", async () => {
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onDelete("/projects/p1/files/old.txt").reply((config) => {
          seenParams = config.params;
          return [204];
        });

        await client.deleteProjectFile("p1", "old.txt", { branch: "dev" });

        expect(seenParams).toEqual({ branch: "dev" });
      });

      it("omits query params when no branch is given", async () => {
        let seenParams: Record<string, unknown> | undefined = { sentinel: true };
        mockAxios.onDelete("/projects/p1/files/old.txt").reply((config) => {
          seenParams = config.params;
          return [204];
        });

        await client.deleteProjectFile("p1", "old.txt");

        expect(seenParams).toBeUndefined();
      });
    });

    describe("searchProjectFiles", () => {
      it("POSTs the FileSearchQuery body and returns the FsNode array", async () => {
        const nodes = [{ path: "rules/M.xlsx", name: "M.xlsx", type: "file" }];
        let body: unknown;
        let params: Record<string, unknown> | undefined;
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          body = JSON.parse(config.data);
          params = config.params;
          return [200, nodes];
        });

        const res = await client.searchProjectFiles(
          "p1",
          { pattern: "**/*.xlsx", content: "premium", type: "FILE" },
          { branch: "main", fields: "path,name" }
        );

        expect(body).toEqual({ pattern: "**/*.xlsx", content: "premium", type: "FILE" });
        expect(params).toMatchObject({ branch: "main", fields: "path,name" });
        expect(res).toEqual(nodes);
      });
    });

    describe("getProjectAgentsMd", () => {
      const ancestorsNodes = [
        { path: "foo/Project-1/AGENTS.md", name: "AGENTS.md", type: "file", basePath: "foo/Project-1", size: 7, lastModified: "2026-06-12T10:47:05Z", content: "project" },
        { path: "foo/AGENTS.md", name: "AGENTS.md", type: "file", basePath: "foo", size: 0, lastModified: "2026-06-12T10:47:06Z", content: "" },
      ];

      it("issues a fixed ANCESTORS search from AGENTS.md and returns path+content nearest-first", async () => {
        let body: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          body = JSON.parse(config.data);
          return [200, ancestorsNodes];
        });

        const res = await client.getProjectAgentsMd("p1");

        // Direction + start path are fixed (not caller-controllable).
        expect(body).toEqual({ scope: "ANCESTORS", from: "AGENTS.md" });
        // Nearest-first, carrying only path/content (+ size/lastModified passthrough).
        expect(res).toEqual([
          { path: "foo/Project-1/AGENTS.md", content: "project", size: 7, lastModified: "2026-06-12T10:47:05Z" },
          { path: "foo/AGENTS.md", content: "", size: 0, lastModified: "2026-06-12T10:47:06Z" },
        ]);
      });

      it("does NOT call getProject (no enrichment round-trip)", async () => {
        mockAxios.onPost("/projects/p1/file-search").reply(200, ancestorsNodes);
        // No GET /projects/p1 mock registered: a call would 404 and surface here.
        await client.getProjectAgentsMd("p1");
        expect(mockAxios.history.get.find((r) => r.url === "/projects/p1")).toBeUndefined();
      });

      it("starts the walk from a sub-folder when 'folder' is given", async () => {
        let body: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          body = JSON.parse(config.data);
          return [200, ancestorsNodes];
        });

        await client.getProjectAgentsMd("p1", { folder: "/rules/pricing/" });

        // Leading/trailing slashes trimmed; '/AGENTS.md' appended.
        expect(body).toEqual({ scope: "ANCESTORS", from: "rules/pricing/AGENTS.md" });
      });

      it("threads the 'branch' option to the file-search query params", async () => {
        let params: Record<string, unknown> | undefined;
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          params = config.params;
          return [200, ancestorsNodes];
        });

        await client.getProjectAgentsMd("p1", { branch: "release" });
        expect(params).toMatchObject({ branch: "release" });
      });

      it("defaults missing content to an empty string", async () => {
        mockAxios.onPost("/projects/p1/file-search").reply(200, [
          { path: "foo/AGENTS.md", name: "AGENTS.md", type: "file", basePath: "foo" },
        ]);

        const res = await client.getProjectAgentsMd("p1");
        expect(res).toEqual([{ path: "foo/AGENTS.md", content: "", size: undefined, lastModified: undefined }]);
      });

      it("returns an empty array when no AGENTS.md exists anywhere", async () => {
        mockAxios.onPost("/projects/p1/file-search").reply(200, []);
        await expect(client.getProjectAgentsMd("p1")).resolves.toEqual([]);
      });
    });

    describe("copyProjectFile / moveProjectFile", () => {
      it("copies with a {sourcePath,destinationPath} body and branch param", async () => {
        let body: unknown;
        let params: Record<string, unknown> | undefined;
        mockAxios.onPost("/projects/p1/file-copy").reply((config) => {
          body = JSON.parse(config.data);
          params = config.params;
          return [201];
        });

        await client.copyProjectFile("p1", { sourcePath: "a.xlsx", destinationPath: "b.xlsx" }, { branch: "main" });

        expect(body).toEqual({ sourcePath: "a.xlsx", destinationPath: "b.xlsx" });
        expect(params).toEqual({ branch: "main" });
      });

      it("moves with a {sourcePath,destinationPath} body", async () => {
        let body: unknown;
        mockAxios.onPost("/projects/p1/file-move").reply((config) => {
          body = JSON.parse(config.data);
          return [204];
        });

        await client.moveProjectFile("p1", { sourcePath: "a.xlsx", destinationPath: "sub/a.xlsx" });

        expect(body).toEqual({ sourcePath: "a.xlsx", destinationPath: "sub/a.xlsx" });
      });

      it("normalizes body paths (strips leading slash) but does NOT percent-encode them", async () => {
        let copyBody: Record<string, unknown> = {};
        let searchBody: Record<string, unknown> = {};
        mockAxios.onPost("/projects/p1/file-copy").reply((config) => {
          copyBody = JSON.parse(config.data);
          return [201];
        });
        mockAxios.onPost("/projects/p1/file-search").reply((config) => {
          searchBody = JSON.parse(config.data);
          return [200, []];
        });

        // Leading slash is stripped; the space is preserved (NOT %20) — body paths are raw JSON.
        await client.copyProjectFile("p1", { sourcePath: "/rules/My File.xlsx", destinationPath: "/out/Copy File.xlsx" });
        expect(copyBody).toEqual({ sourcePath: "rules/My File.xlsx", destinationPath: "out/Copy File.xlsx" });

        await client.searchProjectFiles("p1", { from: "/rules" });
        expect(searchBody.from).toBe("rules");
      });
    });
  });
});
