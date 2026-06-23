/**
 * Unit tests for OpenLClient — COMPLEMENT to client.test.ts.
 *
 * client.test.ts already exercises ~34 of OpenLClient's public methods. This
 * file deliberately covers ONLY the public methods that client.test.ts and
 * auth.test.ts leave untested, so the two files don't overlap:
 *
 *   getRepositoryFeatures, listDeployRepositories, getProductionRepositoryIdByName,
 *   getProjectRevisions, downloadRepositoryFolderZip, deleteProject, closeProject,
 *   saveProject, createBranch, createProjectTable, appendProjectTable,
 *   redeployProject, getProjectLocalChanges, restoreProjectLocalChange,
 *   validateProject, healthCheck, setSessionCookie, getAuthorizationHeader,
 *   startTrace, getTraceNodes, getTraceNodeDetails, getTraceParameter,
 *   cancelTrace, exportTrace.
 *
 * Same setup style as client.test.ts: a real OpenLClient with its private
 * axiosInstance mocked by axios-mock-adapter, asserting real URL/path/query
 * construction, request bodies, response parsing and error mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { OpenLClient } from "../src/client.js";
import type { OpenLConfig } from "../src/types.js";
import type * as Types from "../src/types.js";

describe("OpenLClient (gap coverage, complements client.test.ts)", () => {
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

  describe("Repository Management (gap)", () => {
    describe("getRepositoryFeatures", () => {
      it("GETs /repos/{repo}/features and returns the parsed feature flags", async () => {
        const features: Types.RepositoryFeatures = { branches: true, searchable: false };
        mockAxios.onGet("/repos/design/features").reply(200, features);

        const result = await client.getRepositoryFeatures("design");
        expect(result).toEqual({ branches: true, searchable: false });
      });

      it("URL-encodes the repository id in the features path", async () => {
        let seenUrl = "";
        mockAxios.onGet(/\/repos\/.*\/features/).reply((config) => {
          seenUrl = config.url || "";
          return [200, { branches: false, searchable: true }];
        });

        await client.getRepositoryFeatures("My Repo");
        expect(seenUrl).toBe("/repos/My%20Repo/features");
      });
    });

    describe("listDeployRepositories", () => {
      it("GETs /production-repos (NOT /repos) and returns the array", async () => {
        const repos: Types.Repository[] = [
          { id: "production-deploy", name: "Production Deployment" },
        ];
        mockAxios.onGet("/production-repos").reply(200, repos);

        const result = await client.listDeployRepositories();
        expect(result).toEqual(repos);
        // Must not hit the design-repos endpoint.
        expect(mockAxios.history.get.map((r) => r.url)).toEqual(["/production-repos"]);
      });

      it("does NOT cache — a second call hits the network again", async () => {
        mockAxios.onGet("/production-repos").reply(200, [{ id: "p", name: "P" }]);

        await client.listDeployRepositories();
        await client.listDeployRepositories();

        expect(mockAxios.history.get.filter((r) => r.url === "/production-repos")).toHaveLength(2);
      });
    });

    describe("getProductionRepositoryIdByName", () => {
      const repos: Types.Repository[] = [
        { id: "production-deploy", name: "Production Deployment" },
        { id: "staging-deploy", name: "Staging Deployment" },
      ];

      it("resolves an exact production-repo display name to its id", async () => {
        mockAxios.onGet("/production-repos").reply(200, repos);

        const id = await client.getProductionRepositoryIdByName("Production Deployment");
        expect(id).toBe("production-deploy");
      });

      it("throws listing available names when the name is unknown", async () => {
        mockAxios.onGet("/production-repos").reply(200, repos);

        await expect(
          client.getProductionRepositoryIdByName("Nope")
        ).rejects.toThrow(/"Nope" not found.*Production Deployment, Staging Deployment/);
      });
    });

    describe("getProjectRevisions", () => {
      const page: Types.PageResponse<Types.ProjectRevision> = {
        content: [
          {
            revisionNo: "abc123",
            createdAt: "2026-01-01T00:00:00Z",
            fullComment: "Initial",
            deleted: false,
            technicalRevision: false,
          },
        ],
        pageNumber: 0,
        pageSize: 50,
        numberOfElements: 1,
        totalElements: 1,
        totalPages: 1,
      };

      it("uses the non-branch history URL and forwards filter params when no branch is given", async () => {
        let seenUrl = "";
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet(/\/repos\/design\/projects\/InsuranceRules\/history/).reply((config) => {
          seenUrl = config.url || "";
          seenParams = config.params;
          return [200, page];
        });

        const result = await client.getProjectRevisions("design", "InsuranceRules", {
          search: "premium",
          techRevs: false,
          page: 0,
          size: 50,
        });

        expect(seenUrl).toBe("/repos/design/projects/InsuranceRules/history");
        expect(seenParams).toEqual({ search: "premium", techRevs: false, page: 0, size: 50 });
        expect(result.content[0].revisionNo).toBe("abc123");
      });

      it("switches to the branch-scoped history URL when a branch is given", async () => {
        let seenUrl = "";
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet(/\/branches\/develop\/projects\/InsuranceRules\/history/).reply((config) => {
          seenUrl = config.url || "";
          seenParams = config.params;
          return [200, page];
        });

        await client.getProjectRevisions("design", "InsuranceRules", { branch: "develop" });

        expect(seenUrl).toBe("/repos/design/branches/develop/projects/InsuranceRules/history");
        // branch lives in the path, AND is echoed as a query param by the client.
        expect(seenParams).toEqual({ branch: "develop" });
      });
    });

    describe("downloadRepositoryFolderZip", () => {
      it("GETs the folder path with a trailing slash and download=true, returning a Buffer", async () => {
        let seenUrl = "";
        let seenParams: Record<string, unknown> | undefined;
        mockAxios.onGet(/\/repos\/design\/files\//).reply((config) => {
          seenUrl = config.url || "";
          seenParams = config.params;
          return [200, Buffer.from("PK-zip-bytes")];
        });

        const buf = await client.downloadRepositoryFolderZip("design", "Offer CW", "main");

        // Segment encoded, trailing slash marks it as a folder.
        expect(seenUrl).toBe("/repos/design/files/Offer%20CW/");
        expect(seenParams).toEqual({ download: "true", branch: "main" });
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.toString()).toBe("PK-zip-bytes");
      });
    });
  });

  describe("Project lifecycle (gap)", () => {
    const projectId = "design-project1";
    const projectPath = `/projects/${encodeURIComponent(projectId)}`;
    const designProject = (status: string) => ({
      id: "design:project1:hash",
      name: "project1",
      repository: "design",
      status,
      path: "project1",
      modifiedBy: "admin",
      modifiedAt: "2026-01-01T00:00:00Z",
    });

    describe("deleteProject", () => {
      it("DELETEs /projects/{id} (no preceding GET / local-repo guard)", async () => {
        mockAxios.onDelete(projectPath).reply(204);

        await expect(client.deleteProject(projectId)).resolves.toBeUndefined();
        expect(mockAxios.history.delete).toHaveLength(1);
        expect(mockAxios.history.get).toHaveLength(0);
      });
    });

    describe("closeProject", () => {
      it("PATCHes status CLOSED with the comment after confirming the repo is not local", async () => {
        mockAxios.onGet(projectPath).reply(200, designProject("OPENED"));
        let body: Record<string, unknown> = {};
        mockAxios.onPatch(projectPath).reply((config) => {
          body = JSON.parse(config.data);
          return [204];
        });

        const ok = await client.closeProject(projectId, "Done for now");
        expect(ok).toBe(true);
        expect(body).toMatchObject({ status: "CLOSED", comment: "Done for now" });
      });

      it("refuses to close a project in the local repository", async () => {
        const localId = "local-myproject";
        mockAxios.onGet(`/projects/${encodeURIComponent(localId)}`).reply(200, {
          ...designProject("OPENED"),
          id: "local:myproject:hash",
          repository: "local",
        });

        await expect(client.closeProject(localId)).rejects.toThrow(
          /local repository.*not connected to a remote Git/i
        );
        expect(mockAxios.history.patch).toHaveLength(0);
      });
    });

    describe("saveProject", () => {
      it("short-circuits with 'nothing to save' and issues NO PATCH when the project is not EDITING", async () => {
        mockAxios.onGet(projectPath).reply(200, designProject("OPENED"));

        const result = await client.saveProject(projectId, "irrelevant comment");
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/nothing to save/i);
        expect(mockAxios.history.patch).toHaveLength(0);
      });

      it("requires a non-empty comment when the project IS EDITING", async () => {
        mockAxios.onGet(projectPath).reply(200, designProject("EDITING"));

        await expect(client.saveProject(projectId, "   ")).rejects.toThrow(
          /comment is required for save/i
        );
        expect(mockAxios.history.patch).toHaveLength(0);
      });

      it("PATCHes the trimmed comment when EDITING and validation is unavailable (404)", async () => {
        mockAxios.onGet(projectPath).reply(200, designProject("EDITING"));
        // Validation endpoint missing -> save proceeds.
        mockAxios.onGet(`${projectPath}/validation`).reply(404);
        let body: Record<string, unknown> = {};
        mockAxios.onPatch(projectPath).reply((config) => {
          body = JSON.parse(config.data);
          return [204];
        });

        const result = await client.saveProject(projectId, "  Add premium rule  ");
        expect(result.success).toBe(true);
        expect(body).toEqual({ comment: "Add premium rule" });
        // closeAfterSave was not requested -> no status field.
        expect(body.status).toBeUndefined();
      });

      it("adds status CLOSED to the PATCH body when closeAfterSave is set", async () => {
        mockAxios.onGet(projectPath).reply(200, designProject("EDITING"));
        mockAxios.onGet(`${projectPath}/validation`).reply(404);
        let body: Record<string, unknown> = {};
        mockAxios.onPatch(projectPath).reply((config) => {
          body = JSON.parse(config.data);
          return [204];
        });

        await client.saveProject(projectId, "Commit and close", { closeAfterSave: true });
        expect(body).toEqual({ comment: "Commit and close", status: "CLOSED" });
      });

      it("returns validation errors WITHOUT saving when the project fails validation", async () => {
        mockAxios.onGet(projectPath).reply(200, designProject("EDITING"));
        const validation: Types.ValidationResult = {
          valid: false,
          errors: [{ severity: "ERROR", message: "Datatype 'Driver' not found" }],
          warnings: [],
        };
        mockAxios.onGet(`${projectPath}/validation`).reply(200, validation);

        const result = await client.saveProject(projectId, "Try to save");
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/1 validation error/);
        expect(result.validationErrors?.[0].message).toBe("Datatype 'Driver' not found");
        expect(mockAxios.history.patch).toHaveLength(0);
      });
    });

    describe("createBranch", () => {
      it("POSTs {branch, revision} to /projects/{id}/branches", async () => {
        let body: Record<string, unknown> = {};
        mockAxios.onPost(`${projectPath}/branches`).reply((config) => {
          body = JSON.parse(config.data);
          return [201];
        });

        const ok = await client.createBranch(projectId, "feature/new-rules", "abc123");
        expect(ok).toBe(true);
        expect(body).toEqual({ branch: "feature/new-rules", revision: "abc123" });
      });
    });
  });

  describe("Local change history (gap)", () => {
    describe("getProjectLocalChanges", () => {
      it("GETs /history/project and returns the change items", async () => {
        const items: Types.ProjectHistoryItem[] = [
          { name: "Rules.xlsx", version: "v1", author: "admin", modifiedAt: "2026-01-01T00:00:00Z", comment: "edit" },
        ];
        mockAxios.onGet("/history/project").reply(200, items);

        const result = await client.getProjectLocalChanges();
        expect(result).toEqual(items);
      });
    });

    describe("restoreProjectLocalChange", () => {
      it("POSTs the historyId as a text/plain body to /history/restore", async () => {
        let contentType: string | undefined;
        let body: unknown;
        mockAxios.onPost("/history/restore").reply((config) => {
          contentType = (config.headers?.["Content-Type"] ?? config.headers?.["content-type"]) as string;
          body = config.data;
          return [204];
        });

        await client.restoreProjectLocalChange("hist-42");
        expect(contentType).toBe("text/plain");
        expect(body).toBe("hist-42");
      });
    });
  });

  describe("Table writes (gap)", () => {
    const projectId = "design-project1";
    const projectPath = `/projects/${encodeURIComponent(projectId)}`;

    describe("createProjectTable (BETA contract)", () => {
      it("POSTs {moduleName, sheetName, table} to /tables and returns the created metadata", async () => {
        let body: Record<string, unknown> = {};
        const created: Partial<Types.TableMetadata> = { id: "newTable_999", name: "newTable" };
        mockAxios.onPost(`${projectPath}/tables`).reply((config) => {
          body = JSON.parse(config.data);
          return [201, created];
        });

        const request: Types.CreateNewTableRequest = {
          moduleName: "Rules",
          sheetName: "Sheet1",
          table: { id: "", name: "newTable", tableType: "SimpleRules", kind: "Rules" },
        };
        const result = await client.createProjectTable(projectId, request);

        expect(body).toEqual({
          moduleName: "Rules",
          sheetName: "Sheet1",
          table: { id: "", name: "newTable", tableType: "SimpleRules", kind: "Rules" },
        });
        expect(result.id).toBe("newTable_999");
      });
    });

    describe("appendProjectTable", () => {
      it("POSTs the append payload to /tables/{id}/lines and returns undefined on a 204 in-place write", async () => {
        const tableId = "Customer_1234";
        let body: Record<string, unknown> = {};
        mockAxios.onPost(`${projectPath}/tables/${encodeURIComponent(tableId)}/lines`).reply((config) => {
          body = JSON.parse(config.data);
          return [204];
        });

        const appendData: Types.AppendTableView = {
          tableType: "Datatype",
          fields: [{ name: "email", type: "String", required: true }],
        };
        const newId = await client.appendProjectTable(projectId, tableId, appendData);

        expect(body).toEqual(appendData);
        expect(newId).toBeUndefined();
      });

      it("returns the relocated table id from the 200 response body when the write moved the table", async () => {
        const tableId = "Customer_1234";
        mockAxios
          .onPost(`${projectPath}/tables/${encodeURIComponent(tableId)}/lines`)
          .reply(200, { id: "Customer_5678" });

        const appendData: Types.AppendTableView = {
          tableType: "SimpleRules",
          rules: [{ driverType: "SAFE", premium: 1000 }],
        };
        const newId = await client.appendProjectTable(projectId, tableId, appendData);
        expect(newId).toBe("Customer_5678");
      });

      it("falls back to the Location header for the relocated id when the body carries none", async () => {
        const tableId = "Customer_1234";
        mockAxios
          .onPost(`${projectPath}/tables/${encodeURIComponent(tableId)}/lines`)
          .reply(200, {}, { location: "/projects/design-project1/tables/Customer_relocated%20id" });

        const newId = await client.appendProjectTable(projectId, tableId, {
          tableType: "SimpleRules",
          rules: [{ x: 1 }],
        });
        // Location segment is URL-decoded.
        expect(newId).toBe("Customer_relocated id");
      });
    });
  });

  describe("Deployment (gap)", () => {
    describe("redeployProject", () => {
      it("POSTs {projectId, comment} to /deployments/{deploymentId} (id URL-encoded)", async () => {
        let seenUrl = "";
        let body: Record<string, unknown> = {};
        mockAxios.onPost(/\/deployments\//).reply((config) => {
          seenUrl = config.url || "";
          body = JSON.parse(config.data);
          return [204];
        });

        const request: Types.RedeployProjectRequest = {
          projectId: "design-project1",
          comment: "Redeploy latest",
        };
        await client.redeployProject("deploy 001", request);

        expect(seenUrl).toBe("/deployments/deploy%20001");
        expect(body).toEqual({ projectId: "design-project1", comment: "Redeploy latest" });
      });
    });
  });

  describe("Validation & health (gap)", () => {
    describe("validateProject", () => {
      it("GETs /projects/{id}/validation and returns the parsed result", async () => {
        const projectId = "design-project1";
        const projectPath = `/projects/${encodeURIComponent(projectId)}`;
        const result: Types.ValidationResult = { valid: true, errors: [], warnings: [] };
        mockAxios.onGet(`${projectPath}/validation`).reply(200, result);

        const out = await client.validateProject(projectId);
        expect(out).toEqual(result);
      });

      it("propagates a 404 from the (often-absent) validation endpoint", async () => {
        const projectId = "design-project1";
        mockAxios.onGet(`/projects/${encodeURIComponent(projectId)}/validation`).reply(404);

        await expect(client.validateProject(projectId)).rejects.toThrow();
      });
    });

    describe("healthCheck", () => {
      it("reports healthy + serverReachable when /repos responds", async () => {
        mockAxios.onGet("/repos").reply(200, [{ id: "design", name: "Design" }]);

        const health = await client.healthCheck();
        expect(health.status).toBe("healthy");
        expect(health.serverReachable).toBe(true);
        expect(health.baseUrl).toMatch(/\/rest$/);
        expect(health.authMethod).toContain("Basic");
        expect(health.error).toBeUndefined();
      });

      it("reports unhealthy with a sanitized error when /repos fails", async () => {
        mockAxios.onGet("/repos").reply(500);

        const health = await client.healthCheck();
        expect(health.status).toBe("unhealthy");
        expect(health.serverReachable).toBe(false);
        expect(typeof health.error).toBe("string");
        expect(health.error!.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Session & auth accessors (gap)", () => {
    it("setSessionCookie installs a JSESSIONID that the request interceptor then sends", async () => {
      client.setSessionCookie("restored-123");
      expect(client.getSessionCookie()).toBe("restored-123");

      let cookie: string | undefined;
      mockAxios.onGet("/repos").reply((config) => {
        cookie = (config.headers?.Cookie ?? config.headers?.cookie) as string | undefined;
        return [200, []];
      });

      await client.listRepositories();
      expect(cookie).toContain("JSESSIONID=restored-123");
    });

    it("setSessionCookie(null) clears the stored cookie", () => {
      client.setSessionCookie("abc");
      client.setSessionCookie(null);
      expect(client.getSessionCookie()).toBeNull();
    });

    it("getAuthorizationHeader exposes the Basic header for non-axios consumers (STOMP/WS handshake)", () => {
      const header = client.getAuthorizationHeader();
      const expected = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
      expect(header).toBe(expected);
    });
  });

  describe("Trace API (BETA, gap)", () => {
    const projectId = "p1";
    const projectPath = `/projects/${encodeURIComponent(projectId)}`;

    describe("startTrace", () => {
      it("POSTs to /trace with tableId in the query and the inputJson object serialized as the JSON body", async () => {
        let seenUrl = "";
        let body: unknown;
        let contentType: string | undefined;
        mockAxios.onPost(/\/projects\/p1\/trace\?/).reply((config) => {
          seenUrl = config.url || "";
          body = config.data;
          contentType = (config.headers?.["Content-Type"] ?? config.headers?.["content-type"]) as string;
          return [202];
        });

        await client.startTrace({
          projectId,
          tableId: "calc_42",
          inputJson: { params: { age: 30 } },
        });

        expect(seenUrl).toContain(`${projectPath}/trace?`);
        expect(seenUrl).toContain("tableId=calc_42");
        expect(JSON.parse(body as string)).toEqual({ params: { age: 30 } });
        expect(contentType).toBe("application/json");
      });

      it("threads testRanges into the query string for test-suite traces", async () => {
        let seenUrl = "";
        mockAxios.onPost(/\/projects\/p1\/trace\?/).reply((config) => {
          seenUrl = config.url || "";
          return [202];
        });

        await client.startTrace({ projectId, tableId: "MyTest", testRanges: "1-3,5" });

        expect(seenUrl).toContain("tableId=MyTest");
        // URLSearchParams encodes the comma in "1-3,5".
        expect(seenUrl).toContain("testRanges=1-3%2C5");
      });
    });

    describe("getTraceNodes", () => {
      it("GETs /trace/nodes with showRealNumbers defaulting to 'false' and no id when nodeId is omitted", async () => {
        let params: Record<string, unknown> | undefined;
        const nodes: Types.TraceNodeView[] = [
          { key: 1, title: "root", tooltip: "", type: "node", lazy: false, extraClasses: "" },
        ];
        mockAxios.onGet(`${projectPath}/trace/nodes`).reply((config) => {
          params = config.params;
          return [200, nodes];
        });

        const result = await client.getTraceNodes(projectId);
        expect(params).toEqual({ showRealNumbers: "false" });
        expect(result).toEqual(nodes);
      });

      it("passes id (stringified) and showRealNumbers=true when both options are provided", async () => {
        let params: Record<string, unknown> | undefined;
        mockAxios.onGet(`${projectPath}/trace/nodes`).reply((config) => {
          params = config.params;
          return [200, []];
        });

        await client.getTraceNodes(projectId, { nodeId: 7, showRealNumbers: true });
        expect(params).toEqual({ showRealNumbers: "true", id: "7" });
      });
    });

    describe("getTraceNodeDetails", () => {
      it("GETs /trace/nodes/{nodeId} and forwards showRealNumbers", async () => {
        let params: Record<string, unknown> | undefined;
        const node: Types.TraceNodeView = {
          key: 9,
          title: "detail",
          tooltip: "",
          type: "node",
          lazy: false,
          extraClasses: "",
        };
        mockAxios.onGet(`${projectPath}/trace/nodes/9`).reply((config) => {
          params = config.params;
          return [200, node];
        });

        const result = await client.getTraceNodeDetails(projectId, 9, true);
        expect(params).toEqual({ showRealNumbers: true });
        expect(result.key).toBe(9);
      });
    });

    describe("getTraceParameter", () => {
      it("GETs /trace/parameters/{parameterId} and returns the lazy value", async () => {
        const param: Types.TraceParameterValue = {
          name: "premium",
          description: "computed premium",
          lazy: true,
          parameterId: 5,
          value: 1000,
        };
        mockAxios.onGet(`${projectPath}/trace/parameters/5`).reply(200, param);

        const result = await client.getTraceParameter(projectId, 5);
        expect(result).toEqual(param);
      });
    });

    describe("cancelTrace", () => {
      it("DELETEs /trace", async () => {
        mockAxios.onDelete(`${projectPath}/trace`).reply(204);

        await expect(client.cancelTrace(projectId)).resolves.toBeUndefined();
        expect(mockAxios.history.delete).toHaveLength(1);
        expect(mockAxios.history.delete[0].url).toBe(`${projectPath}/trace`);
      });
    });

    describe("exportTrace", () => {
      it("GETs /trace/export as text and returns the body string, omitting params by default", async () => {
        let params: Record<string, unknown> | undefined;
        mockAxios.onGet(`${projectPath}/trace/export`).reply((config) => {
          params = config.params;
          return [200, "TRACE-TEXT"];
        });

        const text = await client.exportTrace(projectId);
        expect(text).toBe("TRACE-TEXT");
        expect(params).toBeUndefined();
      });

      it("sends showRealNumbers and release as 'true' string params when requested", async () => {
        let params: Record<string, unknown> | undefined;
        mockAxios.onGet(`${projectPath}/trace/export`).reply((config) => {
          params = config.params;
          return [200, "X"];
        });

        await client.exportTrace(projectId, { showRealNumbers: true, release: true });
        expect(params).toEqual({ showRealNumbers: "true", release: "true" });
      });
    });
  });
});
