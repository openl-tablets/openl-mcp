/**
 * The optional server-side tool allow-list (`OPENL_MCP_TOOLS`).
 *
 * Two properties carry the weight:
 *   1. Unset means unchanged — every registered tool is served, so no existing
 *      deployment is altered by this feature existing.
 *   2. Set gates EXECUTION, not just discovery. Filtering tools/list alone would
 *      be decoration: a client that already knows a name could still call it.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { parseToolAllowList, toolAllowList, mcpToolName } from "../src/constants.js";

describe("parseToolAllowList", () => {
  it("returns null when unset, meaning every tool is served", () => {
    expect(parseToolAllowList(undefined)).toBeNull();
  });

  it.each(["", "   ", ",", " , , "])(
    "treats %p as unset rather than as 'serve nothing'",
    (raw) => {
      // A server with no tools is indistinguishable from a broken one, and failing
      // closed here would strand a deployment on a stray trailing comma.
      expect(parseToolAllowList(raw)).toBeNull();
    },
  );

  it("accepts bare names", () => {
    const set = parseToolAllowList("get_table,list_tables");
    expect([...set!].sort()).toEqual(["get_table", "list_tables"]);
  });

  it("accepts wire-prefixed names, because the prefix is a wire concern", () => {
    const set = parseToolAllowList("openl_get_table, openl_list_tables");
    expect([...set!].sort()).toEqual(["get_table", "list_tables"]);
  });

  it("tolerates whitespace and mixed forms", () => {
    const set = parseToolAllowList("  openl_get_table ,list_tables,  , get_started ");
    expect([...set!].sort()).toEqual(["get_started", "get_table", "list_tables"]);
  });
});

describe("toolAllowList (process env)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENL_MCP_TOOLS;
    delete process.env.OPENL_MCP_TOOLS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENL_MCP_TOOLS;
    else process.env.OPENL_MCP_TOOLS = saved;
  });

  it("is null by default", () => {
    expect(toolAllowList()).toBeNull();
  });

  it("reflects OPENL_MCP_TOOLS", () => {
    process.env.OPENL_MCP_TOOLS = "openl_get_table";
    const set = toolAllowList();
    expect(set?.has("get_table")).toBe(true);
    expect(set?.has("update_table")).toBe(false);
    // and the wire name round-trips back to the gated registry name
    expect(mcpToolName("get_table")).toBe("openl_get_table");
  });
});
