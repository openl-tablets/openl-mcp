/**
 * Tests for the shared MCP core's tool-call error channel.
 *
 * A tool's own failure (backend 4xx/5xx, argument validation) must reach the
 * caller as an `isError` RESULT carrying the detailed message, so an agent can
 * self-correct — not as a thrown JSON-RPC protocol error that clients surface
 * as a generic "tool execution failed". Only a genuinely unknown tool stays a
 * protocol error. These tests drive the real CallTool handler end-to-end over
 * an in-memory transport pair.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import MockAdapter from "axios-mock-adapter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OpenLClient } from "../src/client.js";
import { createConfiguredServer } from "../src/mcp-core.js";
import type { ResourceSubscriptionManager } from "../src/resource-subscriptions.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

describe("MCP core — tool-call error channel", () => {
  let openlClient: OpenLClient;
  let mockAxios: MockAdapter;
  let server: Server;
  let subscriptions: ResourceSubscriptionManager;
  let client: Client;

  beforeEach(async () => {
    openlClient = new OpenLClient({ baseUrl: "http://localhost:8080", personalAccessToken: "openl_pat_test" });
    // @ts-ignore - access the private axios instance for mocking
    mockAxios = new MockAdapter(openlClient.axiosInstance);

    ({ server, subscriptions } = createConfiguredServer(openlClient));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    mockAxios.restore();
    await client.close();
    await server.close();
    await subscriptions.closeAll();
  });

  it("surfaces a backend error as an isError result carrying the detailed reason", async () => {
    // The studio rejects the edit with a precise reason in the error body.
    mockAxios
      .onPost(/\/tables\/t1\/actions$/)
      .reply(400, { code: "BAD_DIMENSIONS", message: "column height 6 exceeds table height 5" });

    const result = await client.callTool({
      name: "openl_append_table_column",
      arguments: { projectId: "p1", tableId: "t1", cells: [{ value: "a" }] },
    });

    // Reported as a tool RESULT (isError), not a thrown protocol error.
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    // The precise backend reason reaches the model, not a generic "failed".
    expect(text).toContain("column height 6 exceeds table height 5");
    expect(text).toContain("400");
    // ...but the internal studio REST endpoint is NOT leaked to the agent.
    expect(text).not.toContain("/projects/");
    expect(text).not.toContain("/tables/");
  });

  it("surfaces an argument-validation failure as an isError result (no backend call)", async () => {
    let called = false;
    mockAxios.onAny().reply(() => {
      called = true;
      return [204];
    });

    // insert_table_row requires `position`; the Zod validator rejects it.
    const result = await client.callTool({
      name: "openl_insert_table_row",
      arguments: { projectId: "p1", tableId: "t1" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Invalid arguments for insert_table_row");
    expect(called).toBe(false);
  });

  it("succeeds without isError when the tool runs cleanly", async () => {
    mockAxios.onPost(/\/tables\/t1\/actions$/).reply(204);
    mockAxios.onGet(/\/tables\/t1$/).reply(200, { id: "t1", name: "T", tableType: "RawSource", kind: "Other" });

    const result = await client.callTool({
      name: "openl_delete_table_row",
      arguments: { projectId: "p1", tableId: "t1", position: 2 },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Successfully deleted a row from table t1");
  });

  it("surfaces a backend HTTP 405 as an isError result, not a protocol error", async () => {
    // handleToolError maps HTTP 405 to ErrorCode.MethodNotFound — the same code an
    // unknown tool produces. A registered tool that gets a 405 is still a tool
    // failure, so it must reach the agent as an isError result, not a throw.
    mockAxios.onDelete(/\/tables\/t1$/).reply(405, { code: "METHOD_NOT_ALLOWED", message: "Delete not allowed here" });

    const result = await client.callTool({
      name: "openl_delete_table",
      arguments: { projectId: "p1", tableId: "t1" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("405");
  });

  it("keeps a genuinely unknown tool a thrown protocol error, not an isError result", async () => {
    await expect(
      client.callTool({ name: "openl_does_not_exist", arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);
  });
});
