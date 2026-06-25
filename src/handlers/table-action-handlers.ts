/**
 * Raw table-source action tools (POST /projects/{id}/tables/{tableId}/actions).
 *
 * One narrow tool per operation×orientation — append/insert/delete/update a
 * row or column, update/merge/unmerge cells. Each applies a SINGLE in-place edit
 * to the table's RAW source regardless of table type, unlike openl_update_table
 * / openl_append_table which take the parsed, per-type structure. All share one
 * runner that handles the stale-id retry, the post-edit id change, and the
 * recompile-on-read — the same machinery the full update/append tools use
 * (see `table-id-tracking.ts`).
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";

import * as schemas from "../schemas.js";
import type * as Types from "../types.js";
import { formatResponse } from "../formatters.js";
import { validateResponseFormat } from "../validators.js";
import { registerTool, type ToolResponse } from "./common.js";
import { finalizeTableEdit, withStaleIdRetry } from "./table-id-tracking.js";
import type { OpenLClient } from "../client.js";

/**
 * Validate a tool's raw arguments against its Zod schema, throwing an actionable
 * McpError(InvalidParams) on a violation. Returns the parsed (typed) arguments.
 */
function validateActionArgs(toolName: string, schema: ZodType, args: unknown): unknown {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for ${toolName}:\n${schemas.z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Apply one raw-source edit and report the table's current id.
 *
 * On a stale tableId the edit is retried once against the known new id (a 404
 * writes nothing, so the retry is safe). After the edit the table's id may have
 * changed (it was relocated); the new id is recorded as an alias and returned so
 * the caller never reuses the stale one. Finally the table is read back to force
 * the studio to recompile so a later openl_project_status reflects the change.
 */
async function runTableSourceAction(
  client: OpenLClient,
  projectId: string,
  requestedId: string,
  action: Types.RawTableSourceAction,
  pastTenseEdit: string,
  format: ReturnType<typeof validateResponseFormat>,
): Promise<ToolResponse> {
  // The studio reports the new id directly (200 + { id }) when the edit relocated
  // the table; an in-place edit answers 204 and the id is unchanged. So unlike
  // update/append there is no identity-snapshot fallback to re-resolve the id.
  const { value: reportedNewId, tableId, staleNote } = await withStaleIdRetry(
    projectId,
    requestedId,
    (id) => client.editTableSource(projectId, id, action),
  );

  const notes = staleNote ? [staleNote] : [];
  const { result } = await finalizeTableEdit(
    client,
    projectId,
    requestedId,
    tableId,
    reportedNewId ?? tableId,
    `Successfully ${pastTenseEdit} table ${requestedId}`,
    "edit",
    notes,
  );

  return { content: [{ type: "text", text: formatResponse(result, format) }] };
}

/** Common tail appended to every action tool's description. */
const ACTION_SUFFIX =
  " Operates on the table's RAW source, so it works for any table type. Positions are 0-based " +
  "(row 0 is the header row, column 0 carries the leading labels). An edit that relocates the table " +
  "(it had no room to grow in place) CHANGES its location-derived id; the response always returns the " +
  "table's CURRENT id as 'tableId' (plus previousTableId when it changed) — use it for subsequent calls. " +
  "Note: the studio does not auto-compile after an edit; this tool reads the table back to trigger the " +
  "recompile, so a subsequent openl_project_status reflects the change.";

/** Arguments shared by every action tool after schema validation. */
interface BaseActionArgs {
  projectId: string;
  tableId: string;
  response_format?: "json" | "markdown";
}

interface ActionToolSpec {
  name: string;
  title: string;
  schema: ZodType;
  description: string;
  /** Past-tense fragment for the success message, e.g. "inserted a row into". */
  pastTenseEdit: string;
  annotations: NonNullable<Parameters<typeof registerTool>[0]["annotations"]>;
  /** Build the request body from the validated arguments. */
  buildAction: (args: BaseActionArgs & Record<string, unknown>) => Types.RawTableSourceAction;
}

/** Copy `cells` into a target only when the caller supplied it. */
function withCells(
  target: Types.RawTableActionTarget,
  cells: unknown,
): Types.RawTableActionTarget {
  return Array.isArray(cells) ? { ...target, cells: cells as Types.RawCellInput[] } : target;
}

const ACTION_TOOLS: ActionToolSpec[] = [
  {
    name: "append_table_row",
    title: "Append Table Row (raw)",
    schema: schemas.appendTableRowSchema,
    pastTenseEdit: "appended a row to",
    annotations: { openWorldHint: true },
    description:
      "Add a row to the END of a table's raw source. Provide the new row's 'cells' left to right (omit for a blank row)." +
      ACTION_SUFFIX,
    buildAction: (a) => ({ operation: "append", target: withCells({ type: "row" }, a.cells) }),
  },
  {
    name: "append_table_column",
    title: "Append Table Column (raw)",
    schema: schemas.appendTableColumnSchema,
    pastTenseEdit: "appended a column to",
    annotations: { openWorldHint: true },
    description:
      "Add a column to the END of a table's raw source. Provide the new column's 'cells' top to bottom (omit for a blank column)." +
      ACTION_SUFFIX,
    buildAction: (a) => ({ operation: "append", target: withCells({ type: "column" }, a.cells) }),
  },
  {
    name: "insert_table_row",
    title: "Insert Table Row (raw)",
    schema: schemas.insertTableRowSchema,
    pastTenseEdit: "inserted a row into",
    annotations: { openWorldHint: true },
    description:
      "Insert a row at 'position' in a table's raw source, shifting the rows at and below it down. 'position' must be between 1 and the table height (height appends to the end). Provide the new row's 'cells' left to right (omit for a blank row)." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "insert",
      target: withCells({ type: "row", position: a.position as number }, a.cells),
    }),
  },
  {
    name: "insert_table_column",
    title: "Insert Table Column (raw)",
    schema: schemas.insertTableColumnSchema,
    pastTenseEdit: "inserted a column into",
    annotations: { openWorldHint: true },
    description:
      "Insert a column at 'position' in a table's raw source, shifting the columns at and to the right of it. 'position' must be between 1 and the table width (width appends to the end). Provide the new column's 'cells' top to bottom (omit for a blank column)." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "insert",
      target: withCells({ type: "column", position: a.position as number }, a.cells),
    }),
  },
  {
    name: "delete_table_row",
    title: "Delete Table Row (raw)",
    schema: schemas.deleteTableRowSchema,
    pastTenseEdit: "deleted a row from",
    annotations: { destructiveHint: true, openWorldHint: true },
    description:
      "Delete the row at 'position' (0..height-1) from a table's raw source, shifting the rows below it up." +
      ACTION_SUFFIX,
    buildAction: (a) => ({ operation: "delete", target: { type: "row", position: a.position as number } }),
  },
  {
    name: "delete_table_column",
    title: "Delete Table Column (raw)",
    schema: schemas.deleteTableColumnSchema,
    pastTenseEdit: "deleted a column from",
    annotations: { destructiveHint: true, openWorldHint: true },
    description:
      "Delete the column at 'position' (0..width-1) from a table's raw source, shifting the columns to its right left." +
      ACTION_SUFFIX,
    buildAction: (a) => ({ operation: "delete", target: { type: "column", position: a.position as number } }),
  },
  {
    name: "update_table_row",
    title: "Update Table Row (raw)",
    schema: schemas.updateTableRowSchema,
    pastTenseEdit: "updated a row of",
    annotations: { idempotentHint: true, openWorldHint: true },
    description:
      "Overwrite the cells of an existing row at 'position' (0..height-1) in a table's raw source, left to right. The table is not resized." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "update",
      target: withCells({ type: "row", position: a.position as number }, a.cells),
    }),
  },
  {
    name: "update_table_column",
    title: "Update Table Column (raw)",
    schema: schemas.updateTableColumnSchema,
    pastTenseEdit: "updated a column of",
    annotations: { idempotentHint: true, openWorldHint: true },
    description:
      "Overwrite the cells of an existing column at 'position' (0..width-1) in a table's raw source, top to bottom. The table is not resized." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "update",
      target: withCells({ type: "column", position: a.position as number }, a.cells),
    }),
  },
  {
    name: "update_table_cell",
    title: "Update Table Cell (raw)",
    schema: schemas.updateTableCellSchema,
    pastTenseEdit: "updated a cell of",
    annotations: { idempotentHint: true, openWorldHint: true },
    description:
      "Update the value of a single existing cell at ('row','column') in a table's raw source. 'value' is required: pass a string/number/boolean to set the cell, or null to clear it." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "update",
      target: {
        type: "cell",
        row: a.row as number,
        column: a.column as number,
        // `value` is required by the schema (nullable), so it is always present and
        // sent explicitly: a non-null value sets the cell, null clears it.
        value: a.value,
      },
    }),
  },
  {
    name: "merge_table_cells",
    title: "Merge Table Cells (raw)",
    schema: schemas.mergeTableCellsSchema,
    pastTenseEdit: "merged cells of",
    annotations: { idempotentHint: true, openWorldHint: true },
    description:
      "Merge a rectangular range of cells into one in a table's raw source, keeping the value of the top-left cell at ('row','column'). The range ('rowspan'×'colspan') must cover more than one cell and stay within the table." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "merge",
      target: {
        type: "cells",
        row: a.row as number,
        column: a.column as number,
        rowspan: a.rowspan as number,
        colspan: a.colspan as number,
      },
    }),
  },
  {
    name: "unmerge_table_cells",
    title: "Unmerge Table Cells (raw)",
    schema: schemas.unmergeTableCellsSchema,
    pastTenseEdit: "unmerged cells of",
    annotations: { idempotentHint: true, openWorldHint: true },
    description:
      "Unmerge the merged cell that covers ('row','column') in a table's raw source, splitting it back into individual cells." +
      ACTION_SUFFIX,
    buildAction: (a) => ({
      operation: "unmerge",
      target: { type: "cells", row: a.row as number, column: a.column as number },
    }),
  },
];

export function registerTableActionHandlers(): void {
  for (const spec of ACTION_TOOLS) {
    registerTool({
      name: spec.name,
      category: "Rules & Tables",
      title: spec.title,
      version: "1.0.0",
      description: spec.description,
      inputSchema: schemas.z.toJSONSchema(spec.schema) as Record<string, unknown>,
      annotations: spec.annotations,
      validateArgs: (args) => validateActionArgs(spec.name, spec.schema, args),
      handler: async (args, client): Promise<ToolResponse> => {
        const typedArgs = args as BaseActionArgs & Record<string, unknown>;
        const format = validateResponseFormat(typedArgs.response_format);
        const action = spec.buildAction(typedArgs);
        return runTableSourceAction(client, typedArgs.projectId, typedArgs.tableId, action, spec.pastTenseEdit, format);
      },
    });
  }
}
