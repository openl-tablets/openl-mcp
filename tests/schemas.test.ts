/** Unit tests for MCP input contracts. */

import { describe, expect, it } from "@jest/globals";
import {
  appendTableSchema,
  copyTableSchema,
  createProjectSchema,
  createProjectTableSchema,
  deleteProjectBranchSchema,
  deleteProjectSchema,
  getProjectRevisionsSchema,
  getTableDependenciesSchema,
  listProjectBranchesSchema,
  listProjectsSchema,
  mergeProjectBranchesSchema,
  runTableSchema,
  updateTableSchema,
  z,
} from "../src/schemas.js";

const rawTable = {
  tableType: "RawSource" as const,
  name: "Rate",
  source: [[{
    value: "Rules void Rate()",
    cell: "A1",
    colspan: 2,
    rowspan: 2,
    covered: false,
  }]],
};

describe("RawSource-only table contracts", () => {
  it("publishes only RawSource for create, update, and append", () => {
    const createJson = z.toJSONSchema(createProjectTableSchema) as Record<string, any>;
    const updateJson = z.toJSONSchema(updateTableSchema) as Record<string, any>;
    const appendJson = z.toJSONSchema(appendTableSchema) as Record<string, any>;

    expect(createJson.properties.table.properties.tableType.const).toBe("RawSource");
    expect(updateJson.properties.view.properties.tableType.const).toBe("RawSource");
    expect(appendJson.properties.appendData.properties.tableType.const).toBe("RawSource");
    expect(JSON.stringify({ createJson, updateJson, appendJson })).not.toMatch(
      /SimpleRules|SmartRules|SpreadsheetAppend|DatatypeAppend|EditableTableView|"style"/,
    );
  });

  it("round-trips the complete raw cell representation", () => {
    expect(createProjectTableSchema.parse({
      projectId: "p1",
      moduleName: "Main",
      table: rawTable,
    }).table).toEqual(rawTable);

    expect(updateTableSchema.parse({
      projectId: "p1",
      tableId: "t1",
      view: rawTable,
    }).view.source[0][0]).toEqual(rawTable.source[0][0]);
  });

  it("rejects read-only cell styles from every table write contract", () => {
    const styledCell = { value: "Rules void Rate()", style: { background: "#4472C4", bold: true } };

    expect(createProjectTableSchema.safeParse({
      projectId: "p1",
      moduleName: "Main",
      table: { tableType: "RawSource", name: "Rate", source: [[styledCell]] },
    }).success).toBe(false);
    expect(updateTableSchema.safeParse({
      projectId: "p1",
      tableId: "t1",
      view: { tableType: "RawSource", name: "Rate", source: [[styledCell]] },
    }).success).toBe(false);
    expect(appendTableSchema.safeParse({
      projectId: "p1",
      tableId: "t1",
      appendData: { tableType: "RawSource", rows: [[styledCell]] },
    }).success).toBe(false);
  });

  it("requires a nonblank name and complete source when creating", () => {
    expect(createProjectTableSchema.safeParse({
      projectId: "p1", moduleName: "Main", table: { tableType: "RawSource", source: [] },
    }).success).toBe(false);
    expect(createProjectTableSchema.safeParse({
      projectId: "p1", moduleName: "Main", table: { ...rawTable, name: "  " },
    }).success).toBe(false);
    expect(createProjectTableSchema.safeParse({
      projectId: "p1", moduleName: "Main", table: { tableType: "RawSource", name: "Rate" },
    }).success).toBe(false);
  });

  it("requires at least one raw append row", () => {
    expect(appendTableSchema.safeParse({
      projectId: "p1", tableId: "t1", appendData: { tableType: "RawSource", rows: [] },
    }).success).toBe(false);
    expect(appendTableSchema.safeParse({
      projectId: "p1", tableId: "t1", appendData: { tableType: "RawSource", rows: [[{ value: null }]] },
    }).success).toBe(true);
    expect(appendTableSchema.safeParse({
      projectId: "p1", tableId: "t1", appendData: { tableType: "RawSource", rows: [[]] },
    }).success).toBe(false);
    expect(appendTableSchema.safeParse({
      projectId: "p1", tableId: "t1", appendData: { tableType: "RawSource", rows: [[{ value: "x", colspan: 0 }]] },
    }).success).toBe(false);
  });

  it.each(["Datatype", "SimpleRules", "Spreadsheet", "Test"])(
    "rejects the lossy typed %s table contract",
    (tableType) => {
      expect(createProjectTableSchema.safeParse({
        projectId: "p1", moduleName: "Main", table: { ...rawTable, tableType },
      }).success).toBe(false);
      expect(updateTableSchema.safeParse({
        projectId: "p1", tableId: "t1", view: { ...rawTable, tableType },
      }).success).toBe(false);
      expect(appendTableSchema.safeParse({
        projectId: "p1", tableId: "t1", appendData: {
          tableType,
          rows: [[{ value: "x" }]],
        },
      }).success).toBe(false);
    },
  );

  it("accepts only an xlsx modulePath", () => {
    const base = { projectId: "p1", moduleName: "Rules", table: rawTable };
    expect(createProjectTableSchema.safeParse({ ...base, modulePath: "rules/Rules.xlsx" }).success).toBe(true);
    expect(createProjectTableSchema.safeParse({ ...base, modulePath: "rules/Rules.xls" }).success).toBe(false);
  });
});

describe("table workflow schemas", () => {
  it("accepts both backend-supported run input forms and rejects scalar JSON", () => {
    expect(runTableSchema.safeParse({ projectId: "p1", tableId: "t1", inputJson: [42] }).success).toBe(true);
    expect(runTableSchema.safeParse({ projectId: "p1", tableId: "t1", inputJson: { params: { age: 25 } } }).success).toBe(true);
    expect(runTableSchema.safeParse({ projectId: "p1", tableId: "t1", inputJson: "invalid" }).success).toBe(false);
  });

  it("enforces distinct project-graph and table-neighborhood options", () => {
    expect(getTableDependenciesSchema.safeParse({ projectId: "p1", module: "Main" }).success).toBe(true);
    expect(getTableDependenciesSchema.safeParse({ projectId: "p1", tableId: "t1", direction: "DEPENDENCIES", depth: 2 }).success).toBe(true);
    expect(getTableDependenciesSchema.safeParse({ projectId: "p1", direction: "DEPENDENCIES" }).success).toBe(false);
    expect(getTableDependenciesSchema.safeParse({ projectId: "p1", tableId: "t1", module: "Main" }).success).toBe(false);
  });

  it("requires copy destinations and validates new module paths", () => {
    const valid = { projectId: "p1", tableId: "t1", moduleName: "Main", name: "CopiedRate" };
    expect(copyTableSchema.safeParse(valid).success).toBe(true);
    expect(copyTableSchema.safeParse({ ...valid, modulePath: "rules/Copy.xlsx" }).success).toBe(true);
    expect(copyTableSchema.safeParse({ ...valid, modulePath: "rules/Copy.xls" }).success).toBe(false);
    expect(copyTableSchema.safeParse({ ...valid, name: " " }).success).toBe(false);
  });
});

describe("project branch and merge schemas", () => {
  it("defaults branch listings to project scope and accepts repository merge-target discovery", () => {
    expect(listProjectBranchesSchema.parse({ projectId: "p1" }).scope).toBe("project");
    expect(listProjectBranchesSchema.parse({ projectId: "p1", scope: "repository" }).scope).toBe("repository");
    expect(listProjectBranchesSchema.safeParse({ projectId: "p1", scope: "all" }).success).toBe(false);

    const jsonSchema = z.toJSONSchema(listProjectBranchesSchema);
    expect(jsonSchema.required).not.toContain("scope");
    expect(jsonSchema.properties?.scope).toMatchObject({
      default: "project",
      enum: ["project", "repository"],
    });
  });

  it("requires explicit confirmation for protected-branch force", () => {
    const merge = { projectId: "p1", otherBranch: "release", mode: "send", force: true } as const;
    expect(mergeProjectBranchesSchema.safeParse(merge).success).toBe(false);
    expect(mergeProjectBranchesSchema.safeParse({ ...merge, confirmForce: true }).success).toBe(true);
  });

  it("requires exact deletion confirmations and force acknowledgement", () => {
    expect(deleteProjectSchema.safeParse({ projectId: "p1" }).success).toBe(false);
    expect(deleteProjectSchema.safeParse({ projectId: "p1", confirmProjectName: "Rating" }).success).toBe(true);
    const branch = { projectId: "p1", branch: "feature/rate", confirmBranchName: "feature/rate" };
    expect(deleteProjectBranchSchema.safeParse(branch).success).toBe(true);
    expect(deleteProjectBranchSchema.safeParse({ ...branch, confirmBranchName: "feature/other" }).success).toBe(false);
    expect(deleteProjectBranchSchema.safeParse({ ...branch, force: true }).success).toBe(false);
    expect(deleteProjectBranchSchema.safeParse({ ...branch, force: true, confirmForce: true }).success).toBe(true);
  });
});

describe("current project filters", () => {
  it("accepts DELETED and rejects removed ARCHIVED status", () => {
    expect(listProjectsSchema.safeParse({ status: "DELETED" }).success).toBe(true);
    expect(listProjectsSchema.safeParse({ status: "ARCHIVED" }).success).toBe(false);
  });

  it("addresses revision history by project ID and keeps pagination forms exclusive", () => {
    expect(getProjectRevisionsSchema.safeParse({ projectId: "design:Rules", offset: 25 }).success).toBe(true);
    expect(getProjectRevisionsSchema.safeParse({ projectId: "design:Rules", offset: 25, page: 0 }).success).toBe(false);
    expect(getProjectRevisionsSchema.safeParse({
      projectId: "design:Rules",
      repository: "design",
      projectName: "Rules",
      branch: "main",
    }).success).toBe(false);
  });
});

describe("project creation", () => {
  it("rejects an empty copy source instead of falling back to blank project creation", () => {
    expect(createProjectSchema.safeParse({ repository: "design", projectName: "Copy", template: "" }).success).toBe(false);
  });
});
