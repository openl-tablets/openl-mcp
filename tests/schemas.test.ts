/**
 * Unit tests for input schemas — focused on the EditableTableView discriminated
 * union published by openl_create_project_table. This guards the "structural
 * prevention" fix: an LLM must see the correct REQUIRED/forbidden fields per
 * tableType (so it can't reuse, e.g., the SimpleRules shape for a Test table).
 */

import { describe, it, expect } from "@jest/globals";
import { z, createProjectTableSchema } from "../src/schemas.js";

type JsonSchemaObject = {
  properties: Record<string, { oneOf?: BranchSchema[] }>;
};
type BranchSchema = {
  properties: Record<string, { const?: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
};

function tableBranches(): BranchSchema[] {
  const json = z.toJSONSchema(createProjectTableSchema) as unknown as JsonSchemaObject;
  return json.properties.table.oneOf ?? [];
}
function branchFor(tableType: string): BranchSchema | undefined {
  return tableBranches().find((b) => {
    const tt = b.properties?.tableType;
    return tt?.const === tableType || (tt?.enum ?? []).includes(tableType);
  });
}

describe("createProjectTableSchema.table (EditableTableView union)", () => {
  it("is a discriminated union covering all 11 table types", () => {
    const branches = tableBranches();
    expect(branches.length).toBe(11);
    const types = branches.map((b) => b.properties.tableType.const ?? b.properties.tableType.enum?.[0]);
    expect(types).toEqual(
      expect.arrayContaining([
        "Datatype", "Vocabulary", "Spreadsheet", "SimpleSpreadsheet", "SimpleRules",
        "SmartRules", "SimpleLookup", "SmartLookup", "Data", "Test", "RawSource",
      ])
    );
  });

  it("Test branch requires testedTableName and forbids the rules-table fields", () => {
    const test = branchFor("Test");
    expect(test).toBeDefined();
    expect(test!.required).toEqual(expect.arrayContaining(["tableType", "name", "testedTableName"]));
    expect(test!.additionalProperties).toBe(false); // forbids extras up front
    // The data-table shape — NOT the rules-table shape:
    expect(test!.properties).toHaveProperty("headers");
    expect(test!.properties).toHaveProperty("rows");
    expect(test!.properties).not.toHaveProperty("rules");
    expect(test!.properties).not.toHaveProperty("testedMethodName");
    expect(test!.properties).not.toHaveProperty("signature");
  });

  it("SimpleRules branch exposes args/returnType/rules and forbids the data-table fields", () => {
    const rules = branchFor("SimpleRules");
    expect(rules).toBeDefined();
    expect(rules!.additionalProperties).toBe(false);
    expect(rules!.properties).toHaveProperty("args");
    expect(rules!.properties).toHaveProperty("returnType");
    expect(rules!.properties).toHaveProperty("rules");
    expect(rules!.properties).not.toHaveProperty("testedTableName");
    expect(rules!.properties).not.toHaveProperty("signature");
  });

  it("Datatype branch exposes fields", () => {
    const dt = branchFor("Datatype");
    expect(dt).toBeDefined();
    expect(dt!.properties).toHaveProperty("fields");
    expect(dt!.required).toEqual(expect.arrayContaining(["tableType", "name"]));
  });
});
