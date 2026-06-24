/**
 * Integration tests for the MCP resource layer.
 *
 * These run in CI without a live OpenL Studio: the OpenL client's HTTP layer is
 * mocked with axios-mock-adapter (the same harness tests/integration/tool-handlers.test.ts
 * uses for tools). We register the REAL resource handlers onto a real MCP `Server`
 * exactly as the production session setup does — `ListResources` →
 * `STATIC_RESOURCES`, `ListResourceTemplates` → `RESOURCE_TEMPLATES`,
 * `ReadResource` → `handleResourceRead(uri, client)` — and then invoke those
 * handler closures directly with mocked backend responses.
 *
 * This exercises the end-to-end resource read path: URI parsing, static vs.
 * parameterized template dispatch, the OpenLClient call, JSON/markdown
 * formatting, and the McpError error paths. The pure prefix-filter / completion
 * semantics and the docs-aggregation formatting are already covered as units in
 * tests/resources-catalog.test.ts, so they are not duplicated here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { OpenLClient } from "../../src/client.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
  handleResourceRead,
} from "../../src/resources-catalog.js";
import type { OpenLConfig } from "../../src/types.js";

const encodeProjectPath = (id: string): string => encodeURIComponent(id);

/**
 * Register the production resource handlers on a real MCP `Server` and return
 * the exact handler closures so tests can invoke them. The `setRequestHandler`
 * calls here are byte-for-byte what `registerMcpHandlers` in src/mcp-core.ts
 * registers — this is the real wiring, not a re-implementation.
 */
function registerResourceHandlers(server: Server, client: OpenLClient) {
  const listResources = async () => ({ resources: STATIC_RESOURCES });
  const listResourceTemplates = async () => ({ resourceTemplates: RESOURCE_TEMPLATES });
  const readResource = (request: { params: { uri: string } }) =>
    handleResourceRead(request.params.uri, client);

  server.setRequestHandler(ListResourcesRequestSchema, listResources);
  server.setRequestHandler(ListResourceTemplatesRequestSchema, listResourceTemplates);
  server.setRequestHandler(ReadResourceRequestSchema, readResource as any);

  return { listResources, listResourceTemplates, readResource };
}

describe("Resource layer integration", () => {
  let client: OpenLClient;
  let mockAxios: MockAdapter;
  let server: Server;
  let handlers: ReturnType<typeof registerResourceHandlers>;

  const read = (uri: string) => handlers.readResource({ params: { uri } });

  beforeAll(() => {
    const config: OpenLConfig = {
      baseUrl: "http://localhost:8080",
      username: "admin",
      password: "admin",
    };

    client = new OpenLClient(config);
    // @ts-ignore Access private axios instance for mocking in integration tests
    mockAxios = new MockAdapter(client.axiosInstance);

    server = new Server({ name: "test-server", version: "1.0.0" }, { capabilities: { resources: {} } });
    handlers = registerResourceHandlers(server, client);
  });

  beforeEach(() => {
    mockAxios.reset();
  });

  afterAll(() => {
    mockAxios.restore();
  });

  describe("ListResources", () => {
    it("returns exactly the static singleton resources the server serves", async () => {
      const result = await handlers.listResources();

      expect(Array.isArray(result.resources)).toBe(true);
      const uris = result.resources.map((r) => r.uri).sort();
      expect(uris).toEqual([
        "openl://deployments",
        "openl://projects",
        "openl://repositories",
      ]);
    });

    it("ships complete metadata for every static resource", async () => {
      const result = await handlers.listResources();

      for (const resource of result.resources) {
        expect(typeof resource.uri).toBe("string");
        expect(typeof resource.name).toBe("string");
        expect(typeof resource.description).toBe("string");
        expect(resource.mimeType).toBe("application/json");
        // Static resources never carry `{var}` placeholders — those are templates.
        expect(resource.uri).not.toMatch(/\{[^}]+\}/);
      }
    });
  });

  describe("ListResourceTemplates", () => {
    it("returns parameterized URI templates (not in the static list)", async () => {
      const result = await handlers.listResourceTemplates();

      const templateUris = result.resourceTemplates.map((t) => t.uriTemplate);
      expect(templateUris).toContain("openl://projects/{projectId}");
      expect(templateUris).toContain("openl://projects/{projectId}/tables");
      expect(templateUris).toContain("openl://projects/{projectId}/tables/{tableId}");
      expect(templateUris).toContain("openl://projects/{projectId}/history");
      expect(templateUris).toContain("openl://projects/{projectId}/files/{filePath}");
      expect(templateUris).toContain("openl://status/{projectId}");
      expect(templateUris).toContain("openl://status/{projectId}/{branch}");

      // Every template carries a placeholder and uses `uriTemplate` (spec field).
      for (const t of result.resourceTemplates) {
        expect(t.uriTemplate).toMatch(/\{[^}]+\}/);
        expect(t).not.toHaveProperty("uri");
      }
    });
  });

  describe("ReadResource — static URIs", () => {
    it("reads openl://repositories from client.listRepositories()", async () => {
      mockAxios.onGet("/repos").reply(200, [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ]);

      const result = await read("openl://repositories");

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe("openl://repositories");
      expect(content.mimeType).toBe("application/json");
      const data = JSON.parse(content.text);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].name).toBe("Design Repository");
    });

    it("reads openl://projects from client.listProjects()", async () => {
      mockAxios.onGet("/repos").reply(200, [
        { id: "design", name: "Design Repository", aclId: "acl-design" },
      ]);
      mockAxios.onGet("/projects").reply(200, [
        { id: "design:insurance-rules:hash", name: "insurance-rules", repository: "design", path: "insurance-rules" },
      ]);

      const result = await read("openl://projects");

      expect(result.contents[0].uri).toBe("openl://projects");
      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(result.contents[0].text).toContain("insurance-rules");
    });

    it("reads openl://deployments from client.listDeployments()", async () => {
      mockAxios.onGet("/deployments").reply(200, [
        { id: "deploy-001", name: "insurance-rules-v1", projectName: "insurance-rules", repository: "production" },
      ]);

      const result = await read("openl://deployments");

      expect(result.contents[0].uri).toBe("openl://deployments");
      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("ReadResource — parameterized templates", () => {
    const projectId = "design:insurance-rules:hash123";
    const encoded = encodeProjectPath(projectId);

    it("reads openl://projects/{projectId} via client.getProject()", async () => {
      mockAxios.onGet(`/projects/${encoded}`).reply(200, {
        id: projectId,
        name: "insurance-rules",
        repository: "design",
        path: "insurance-rules",
        status: "OPENED",
      });

      const result = await read(`openl://projects/${projectId}`);

      expect(result.contents[0].uri).toBe(`openl://projects/${projectId}`);
      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      expect(data.name).toBe("insurance-rules");
      expect(data.repository).toBe("design");
    });

    it("reads openl://projects/{projectId}/tables via client.listTables()", async () => {
      mockAxios.onGet(`/projects/${encoded}/tables`).reply(200, [
        { id: "Rules.xls_1234", name: "CalculatePremium", tableType: "simplerules", kind: "Rules" },
      ]);

      const result = await read(`openl://projects/${projectId}/tables`);

      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(result.contents[0].text).toContain("Rules.xls_1234");
    });

    it("reads openl://projects/{projectId}/tables/{tableId} via client.getTable()", async () => {
      const tableId = "Rules.xls_1234";
      mockAxios
        .onGet(`/projects/${encoded}/tables/${encodeURIComponent(tableId)}`)
        .reply(200, { id: tableId, name: "CalculatePremium", tableType: "simplerules", kind: "Rules" });

      const result = await read(`openl://projects/${projectId}/tables/${tableId}`);

      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      expect(data.id).toBe(tableId);
      expect(data.name).toBe("CalculatePremium");
    });

    it("reads openl://projects/{projectId}/history via client.getProjectHistory()", async () => {
      mockAxios.onGet(`/projects/${encoded}/history`).reply(200, {
        content: [
          { commitHash: "abc123", author: { name: "admin", email: "a@b.c" }, modifiedAt: "2025-11-10T10:30:00Z", comment: "init" },
        ],
        totalElements: 1,
        numberOfElements: 1,
        pageNumber: 0,
        totalPages: 1,
      });

      const result = await read(`openl://projects/${projectId}/history`);

      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      // getProjectHistory wraps the page response in { projectId, branch, commits, ... }.
      expect(Array.isArray(data.commits)).toBe(true);
      expect(data.commits[0].commitHash).toBe("abc123");
      expect(data.projectId).toBe(projectId);
    });

    it("reads openl://status/{projectId} via client.getProjectStatus()", async () => {
      mockAxios.onGet(`/projects/${encoded}/status`).reply(200, {
        projectId: { repository: "design", projectName: "insurance-rules" },
        branch: "main",
        compileState: "ok",
        compilation: { messages: { items: [], total: 0, errors: 0, warnings: 0 }, modules: { total: 1, compiled: 1 }, tests: { total: 0 } },
      });

      const result = await read(`openl://status/${projectId}`);

      expect(result.contents[0].uri).toBe(`openl://status/${projectId}`);
      expect(result.contents[0].mimeType).toBe("application/json");
      expect(result.contents[0].text).toContain("\"ok\"");
    });

    it("reads openl://status/{projectId}/{branch} and forwards the branch to the backend", async () => {
      mockAxios.onGet(`/projects/${encoded}/status`).reply((config) => {
        if (config.params?.branch === "develop") {
          return [200, {
            projectId, branch: "develop", compileState: "ok",
            compilation: { messages: { items: [], total: 0, errors: 0, warnings: 0 }, modules: { total: 1, compiled: 1 }, tests: { total: 0 } },
          }];
        }
        return [409, { message: "branch.mismatch" }];
      });

      const result = await read(`openl://status/${projectId}/develop`);

      expect(result.contents[0].uri).toBe(`openl://status/${projectId}/develop`);
      expect(result.contents[0].text).toContain("develop");
    });

    it("reads openl://projects/{projectId}/files/{filePath} as a binary-file-path descriptor", async () => {
      const filePath = "Rules.xlsx";
      mockAxios.onGet(`/projects/${encoded}/files/${filePath}`).reply(200, "PKbinary-bytes");

      const result = await read(`openl://projects/${projectId}/files/${filePath}`);

      // The file handler always reports JSON metadata, not the raw bytes.
      expect(result.contents[0].uri).toBe(`openl://projects/${projectId}/files/${filePath}`);
      expect(result.contents[0].mimeType).toBe("application/json");
      const meta = JSON.parse(result.contents[0].text);
      expect(meta.mode).toBe("binary-file-path");
      expect(meta.filePath).toBe(filePath);
      expect(typeof meta.downloadedTo).toBe("string");
      expect(meta.downloadedTo.length).toBeGreaterThan(0);
      expect(meta.size).toBeGreaterThan(0);
    });

    it("reads openl://docs/{project}/AGENTS.md as aggregated markdown", async () => {
      // getProjectAgentsMd is built on the file-search/read endpoints; stub the
      // method directly so this test stays focused on the resource dispatch.
      const originalGetAgents = client.getProjectAgentsMd.bind(client);
      (client as unknown as { getProjectAgentsMd: unknown }).getProjectAgentsMd = async () => [
        { path: "design/insurance-rules/AGENTS.md", content: "project guidance" },
        { path: "design/AGENTS.md", content: "root guidance" },
      ];
      try {
        const result = await read("openl://docs/insurance-rules/AGENTS.md");

        expect(result.contents[0].uri).toBe("openl://docs/insurance-rules/AGENTS.md");
        expect(result.contents[0].mimeType).toBe("text/markdown");
        expect(result.contents[0].text).toContain("project guidance");
        expect(result.contents[0].text).toContain("root guidance");
      } finally {
        (client as unknown as { getProjectAgentsMd: unknown }).getProjectAgentsMd = originalGetAgents;
      }
    });
  });

  describe("ReadResource — error paths", () => {
    const projectId = "design:insurance-rules:hash123";
    const encoded = encodeProjectPath(projectId);

    it("throws McpError(InvalidRequest) for a URI that is not openl://", async () => {
      await expect(read("invalid-uri")).rejects.toThrow(McpError);
      await expect(read("invalid-uri")).rejects.toThrow(/Invalid resource URI/);
    });

    it("throws McpError(InvalidRequest) for an unknown resource type", async () => {
      await expect(read("openl://unknown")).rejects.toThrow(/Unknown resource type/);
    });

    it("throws McpError(InvalidRequest) for an unknown project subresource", async () => {
      await expect(read(`openl://projects/${projectId}/bogus`)).rejects.toThrow(/Unknown project subresource/);
    });

    it("throws McpError(InvalidRequest) when the file path is missing", async () => {
      await expect(read(`openl://projects/${projectId}/files/`)).rejects.toThrow(/File path is required/);
    });

    it("throws McpError(InvalidRequest) when the status URI omits the project", async () => {
      await expect(read("openl://status")).rejects.toThrow(/Project ID is required/);
    });

    it("rejects a docs URI that does not target AGENTS.md", async () => {
      await expect(read("openl://docs/insurance-rules/README.md")).rejects.toThrow(/only 'openl:\/\/docs/);
    });

    it("wraps a backend failure in McpError(InternalError)", async () => {
      mockAxios.onGet(`/projects/${encoded}`).reply(500, { message: "boom" });

      await expect(read(`openl://projects/${projectId}`)).rejects.toThrow(McpError);
      await expect(read(`openl://projects/${projectId}`)).rejects.toThrow(/Error reading resource/);
    });
  });
});
