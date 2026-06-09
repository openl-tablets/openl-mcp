/**
 * Unit tests for input schemas — focused on the EditableTableView discriminated
 * union published by openl_create_project_table. This guards the "structural
 * prevention" fix: an LLM must see the correct REQUIRED/forbidden fields per
 * tableType (so it can't reuse, e.g., the SimpleRules shape for a Test table).
 */

import { describe, it, expect } from "@jest/globals";
import { z, createProjectTableSchema, appendTableSchema } from "../src/schemas.js";

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

  it("SimpleSpreadsheet branch models steps as {name,type,value} and forbids 'formula'", () => {
    const ss = branchFor("SimpleSpreadsheet");
    expect(ss).toBeDefined();
    expect(ss!.properties).toHaveProperty("steps");
    const stepItems = (ss!.properties as Record<string, { items?: BranchSchema }>).steps.items!;
    expect(Object.keys(stepItems.properties)).toEqual(expect.arrayContaining(["name", "type", "value"]));
    expect(stepItems.properties).not.toHaveProperty("formula"); // the field the agent wrongly used
    expect(stepItems.additionalProperties).toBe(false);
  });

  it("Datatype branch exposes fields incl. 'required' (parity with append)", () => {
    const dt = branchFor("Datatype");
    expect(dt).toBeDefined();
    expect(dt!.properties).toHaveProperty("fields");
    const fieldItem = (dt!.properties as Record<string, { items?: BranchSchema }>).fields.items!;
    expect(Object.keys(fieldItem.properties)).toEqual(expect.arrayContaining(["name", "type", "required", "defaultValue"]));
    expect(dt!.required).toEqual(expect.arrayContaining(["tableType", "name"]));
  });
});

describe("appendTableSchema.appendData union", () => {
  function appendBranches(): BranchSchema[] {
    const json = z.toJSONSchema(appendTableSchema) as unknown as JsonSchemaObject;
    return json.properties.appendData.oneOf ?? [];
  }

  it("covers all 10 appendable table types (incl. Data/Test/SimpleLookup/SmartLookup)", () => {
    const types = appendBranches().map((b) => b.properties.tableType.const ?? b.properties.tableType.enum?.[0]);
    expect(types).toEqual(
      expect.arrayContaining([
        "Datatype", "SimpleRules", "SmartRules", "SimpleSpreadsheet", "Vocabulary",
        "SimpleLookup", "SmartLookup", "Data", "Test", "RawSource",
      ])
    );
    expect(appendBranches().length).toBe(10);
  });

  it("Test/Data append branches use rows:[{values}]", () => {
    for (const tt of ["Test", "Data"]) {
      const b = appendBranches().find((x) => x.properties.tableType.const === tt);
      expect(b).toBeDefined();
      const rowsItem = (b!.properties as Record<string, { items?: BranchSchema }>).rows.items!;
      expect(rowsItem.properties).toHaveProperty("values");
    }
  });
});
