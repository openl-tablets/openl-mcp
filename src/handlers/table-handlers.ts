/**
 * Rules/tables tool handlers — list/get tables and update/append/create them.
 * Owns the structured-payload argument validation used by the editing tools;
 * the post-edit table-id tracking they share lives in `table-id-tracking.ts`.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ZodError, ZodType } from "zod";

import * as schemas from "../schemas.js";
import type * as Types from "../types.js";
import { formatResponse, paginateResults } from "../formatters.js";
import { validateResponseFormat, validatePagination } from "../validators.js";
import { isNotFoundError, isPlainObject } from "../utils.js";
import { registerTool, STALE_TABLE_ID_HINT, type ToolResponse } from "./common.js";
import {
  listTablesByExactName,
  recordTableIdAlias,
  resolveCurrentTableId,
  resolveTableIdAlias,
  triggerTableRecompile,
  type TableIdentity,
} from "./table-id-tracking.js";

/**
 * EPBDS-16085: reject RawSource append rows whose width does not match the
 * table, BEFORE anything is posted. The backend accepts short rows and silently
 * pads the missing cells with blanks — corrupt data with success:true.
 *
 * The table width comes from the raw source matrix (which includes covered
 * placeholder cells, so every row has one entry per column). A submitted row is
 * accepted when either its entry count matches the width (placeholder style,
 * mirroring openl_get_table raw output) or the columns covered via colspan add
 * up to the width (no-placeholder style). If the matrix is ragged the width
 * cannot be trusted and validation is skipped rather than blocking valid
 * appends.
 */
function validateRawSourceAppendRows(
  rows: Array<Array<Record<string, unknown>>>,
  source: Types.RawTableCell[][],
  tableLabel: string,
): void {
  if (!Array.isArray(source) || source.length === 0 || rows.length === 0) {
    return;
  }
  const widths = new Set(source.map((row) => (Array.isArray(row) ? row.length : -1)));
  if (widths.size !== 1 || widths.has(-1)) {
    return;
  }
  const width = source[0].length;
  if (width === 0) {
    return;
  }

  const problems: string[] = [];
  rows.forEach((row, index) => {
    const entryCount = row.length;
    let coveredColumns = 0;
    for (const cell of row) {
      if (cell && cell.covered === true) {
        coveredColumns += 1;
        continue;
      }
      const colspan = Number(cell?.colspan);
      coveredColumns += Number.isFinite(colspan) && colspan >= 2 ? colspan : 1;
    }
    if (entryCount !== width && coveredColumns !== width) {
      problems.push(
        `row ${index + 1} has ${entryCount} cell(s)` +
          (coveredColumns !== entryCount ? ` covering ${coveredColumns} column(s)` : ""),
      );
    }
  });

  if (problems.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Cannot append to table '${tableLabel}': the table is ${width} column(s) wide, but ${problems.join("; ")}. ` +
        `Each appended RawSource row must cover all ${width} column(s) — provide one cell object per column ` +
        `(use { "value": "" } for intentionally blank cells). Nothing was appended. ` +
        `Call openl_get_table(raw=true) to inspect the table's exact column layout.`,
    );
  }
}

/**
 * Validate and case-normalize the `tableType` discriminator of an EditableTableView
 * payload before it reaches the backend. Returns the view with the canonical token
 * (e.g. "datatype" -> "Datatype"); throws a clear, actionable McpError — instead of
 * the backend's opaque 400 "Failed to read request" — when tableType is missing or
 * not a recognized type. `kind` is informational (not the discriminator) and left
 * untouched.
 */
function normalizeEditableTableType(view: Types.EditableTableView, argName: string): Types.EditableTableView {
  // The backend rejects unknown JSON properties (FAIL_ON_UNKNOWN_PROPERTIES) with
  // an opaque 400 "Failed to read request". 'signature' is a common LLM invention —
  // OpenL table views have no such field; the method is defined by name+returnType+args.
  if ((view as { signature?: unknown }).signature !== undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${argName}.signature is not a valid field — OpenL table views have no 'signature'. ` +
        `Define the method with 'name', 'returnType' (e.g. "String"), and 'args': [{ name, type }] ` +
        `(the input parameters). For rules/decision tables also supply 'headers': [{ title }] (the ` +
        `column captions) and 'rules' (rows keyed by those titles). The backend rejects unknown fields ` +
        `with a 400 "Failed to read request".`
    );
  }
  const raw = (view as { tableType?: unknown }).tableType;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${argName}.tableType is required and is a CASE-SENSITIVE discriminator. Use exactly one of: ${schemas.EDITABLE_TABLE_TYPES.join(", ")}.`
    );
  }
  const canonical = schemas.EDITABLE_TABLE_TYPES.find((t) => t.toLowerCase() === raw.trim().toLowerCase());
  if (!canonical) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${argName}.tableType "${raw}" is not a valid table type. Use exactly one of (CASE-SENSITIVE): ${schemas.EDITABLE_TABLE_TYPES.join(", ")}.`
    );
  }
  return canonical === raw ? view : { ...view, tableType: canonical as Types.EditableTableView["tableType"] };
}

interface ToolValidationSpec {
  /** Schema the whole arguments object is validated against. */
  schema: ZodType;
  /** Top-level argument holding the nested object payload (e.g. "appendData"). */
  payloadArg: string;
  /** Valid tableType discriminators for this tool — used to enrich errors. */
  tableTypes: readonly string[];
}

/**
 * Case-normalize a payload's `tableType` to its canonical token (e.g.
 * "datatype" -> "Datatype") so the CASE-SENSITIVE discriminated union accepts
 * it — preserving the forgiveness of normalizeEditableTableType. An unknown
 * value is left untouched for the schema to reject (with a listed-options hint).
 */
function normalizeTableTypeCase(payload: unknown, validTypes: readonly string[]): unknown {
  if (!isPlainObject(payload)) return payload;
  const tableType = payload.tableType;
  if (typeof tableType !== "string") return payload;
  const key = tableType.trim().toLowerCase();
  const canonical = validTypes.find((t) => t.toLowerCase() === key);
  return canonical && canonical !== tableType ? { ...payload, tableType: canonical } : payload;
}

/**
 * LLM clients frequently send the nested payload (appendData/view/table) as a
 * JSON *string* instead of an object; axios would then POST a bare JSON string
 * and the backend rejects it with an opaque 400. Parse such a string back into a
 * value so validation (and the handler) see the real object. A string that LOOKS
 * like JSON but fails to parse is reported precisely; any other string is left
 * for the schema to reject ("expected object, received string").
 */
function coercePayloadJson(value: unknown, payloadArg: string, toolName: string): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${toolName}: '${payloadArg}' was provided as a string that is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}). Pass '${payloadArg}' as a JSON object, not a string.`,
    );
  }
}

/** Build an actionable message from a Zod validation failure. */
function formatValidationError(spec: ToolValidationSpec, toolName: string, error: ZodError): string {
  let message = `Invalid arguments for ${toolName}:\n${schemas.z.prettifyError(error)}`;
  // A discriminated-union failure on `<payloadArg>.tableType` surfaces as Zod's
  // terse "Invalid input"; spell out the valid (case-sensitive) discriminators.
  const tableTypeIssue = error.issues.some(
    (issue) => issue.path[0] === spec.payloadArg && issue.path[1] === "tableType",
  );
  if (tableTypeIssue) {
    message +=
      `\n\n${spec.payloadArg}.tableType is required and is a CASE-SENSITIVE discriminator. ` +
      `Use exactly one of: ${spec.tableTypes.join(", ")}. Each table type has its own shape — ` +
      `tip: call openl_get_table() on an existing table of the same type and copy its structure.`;
  }
  return message;
}

/**
 * Validate and lightly coerce a structured-payload tool's arguments before its
 * handler runs. Returns the (possibly coerced) arguments to forward to the
 * handler; throws a descriptive McpError(InvalidParams) on a schema violation.
 * Wired onto each structured-payload table tool as its `validateArgs` callback.
 */
function validateStructuredArgs(toolName: string, spec: ToolValidationSpec, args: unknown): unknown {
  let callArgs: unknown = args;
  if (isPlainObject(args)) {
    const original = args[spec.payloadArg];
    let payload = coercePayloadJson(original, spec.payloadArg, toolName);
    payload = normalizeTableTypeCase(payload, spec.tableTypes);
    if (payload !== original) {
      callArgs = { ...args, [spec.payloadArg]: payload };
    }
  }

  const result = spec.schema.safeParse(callArgs);
  if (!result.success) {
    throw new McpError(ErrorCode.InvalidParams, formatValidationError(spec, toolName, result.error));
  }
  return callArgs;
}

export function registerTableHandlers(): void {
  registerTool({
    name: "list_tables",
    category: "Rules & Tables",
    title: "List Project Tables",
    version: "1.0.0",
    description: "List all tables/rules in a project with optional filters for type, name, and file. Returns table metadata including 'tableId' (the 'id' field) which is required for calling get_table(), update_table(), append_table(), or run_project_tests(). Use the 'tableId' field from the response to reference specific tables in other API calls. IMPORTANT: a table id is derived from its location and changes when an edit relocates the table (it had no room to grow in place). After openl_update_table/openl_append_table, use the 'tableId' those tools return (or re-run openl_list_tables); an id from a listing taken before such an edit is stale.",
    inputSchema: schemas.z.toJSONSchema(schemas.listTablesSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        kind?: string[];
        name?: string;
        properties?: Record<string, string>;
        response_format?: "json" | "markdown";
        limit?: number;
        offset?: number;
      };

      if (!typedArgs || !typedArgs.projectId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required argument: projectId. To find valid project IDs, use: openl_list_projects()");
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const { limit, offset } = validatePagination(typedArgs.limit, typedArgs.offset);

      const filters: Types.TableFilters = {};
      if (typedArgs.kind && typedArgs.kind.length > 0) {
        filters.kind = typedArgs.kind;
      }
      if (typedArgs.name) filters.name = typedArgs.name;
      if (typedArgs.properties) filters.properties = typedArgs.properties;
      
      // Add pagination parameters (convert offset/limit to page/size for API)
      if (offset !== undefined && limit !== undefined) {
        filters.offset = offset;
        filters.limit = limit;
      }

      const tablesResponse = await client.listTables(typedArgs.projectId, filters);

      // Handle case when API returns PageResponse instead of array
      // API now returns { content: [...], pageNumber, pageSize, numberOfElements, total }
      let tables: Types.TableMetadata[];
      let totalCount: number | undefined;
      let apiPageNumber: number | undefined;
      let apiPageSize: number | undefined;

      if (Array.isArray(tablesResponse)) {
        // Direct array response (backward compatibility, no pagination metadata)
        tables = tablesResponse;
        totalCount = tables.length;
      } else if (tablesResponse && typeof tablesResponse === 'object' && 'content' in tablesResponse && Array.isArray((tablesResponse as any).content)) {
        // PageResponse format: { content: [...], pageNumber, pageSize, numberOfElements, total }
        tables = (tablesResponse as any).content;
        apiPageNumber = (tablesResponse as any).pageNumber;
        apiPageSize = (tablesResponse as any).pageSize;
        // Use total if available (OpenL API), otherwise totalElements
        // Do NOT use numberOfElements as it's the current page size, not the global total
        const total = (tablesResponse as any).total;
        const totalElements = (tablesResponse as any).totalElements;
        if (total !== undefined && total !== null) {
          totalCount = total;
        } else if (totalElements !== undefined && totalElements !== null) {
          totalCount = totalElements;
        } else {
          // Total count unknown - let has_more logic rely on page cursor/size
          totalCount = undefined;
        }
      } else {
        // Fallback: empty array
        tables = [];
        totalCount = 0;
      }

      // If API already paginated, use its pagination metadata
      // Otherwise apply client-side pagination
      let paginated;
      if (apiPageNumber !== undefined && apiPageSize !== undefined && totalCount !== undefined) {
        // API already paginated - use its metadata
        paginated = {
          data: tables,
          has_more: (apiPageNumber + 1) * apiPageSize < totalCount,
          next_offset: (apiPageNumber + 1) * apiPageSize < totalCount ? (apiPageNumber + 1) * apiPageSize : null,
          total_count: totalCount,
        };
      } else {
        // Apply client-side pagination
        paginated = paginateResults(tables, limit, offset);
      }

      // Use API pagination metadata if available, otherwise use client-side pagination values
      const paginationOffset = apiPageNumber !== undefined && apiPageSize !== undefined
        ? apiPageNumber * apiPageSize
        : offset;
      const paginationLimit = apiPageSize !== undefined
        ? apiPageSize
        : limit;

      const formattedResult = formatResponse(paginated.data, format, {
        pagination: {
          limit: paginationLimit,
          offset: paginationOffset,
          total: paginated.total_count,
        },
        dataType: "tables",
      });

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "get_table",
    category: "Rules & Tables",
    title: "Get Table Structure & Data",
    version: "1.0.0",
    description:
      "Get detailed information about a specific table/rule. By default returns a parsed table structure with signature, conditions, actions, dimension properties, and row data. Set raw=true to get an unparsed 2D cell matrix (RawTableView) instead — useful for unknown/custom table types or preserving exact cell layout. Note: raw output cannot be passed directly to openl_update_table (which expects the parsed form). A table id changes when an edit relocates the table; if the given id went stale through an edit made via this server, it is resolved to the current id automatically — otherwise refresh ids with openl_list_tables().",
    inputSchema: schemas.z.toJSONSchema(schemas.getTableSchema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        raw?: boolean;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId. Use openl_list_tables() to find valid table IDs");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      const fetchTable = (id: string): Promise<Types.TableView | Types.RawTableView> =>
        typedArgs.raw
          ? client.getTable(typedArgs.projectId, id, true)
          : client.getTable(typedArgs.projectId, id);

      // EPBDS-16084: a table's id changes after every edit. If this id went
      // stale through an edit made via this server, resolve it transparently.
      let table: Types.TableView | Types.RawTableView;
      let staleIdNote: string | undefined;
      try {
        table = await fetchTable(typedArgs.tableId);
      } catch (error) {
        const aliased = isNotFoundError(error)
          ? resolveTableIdAlias(typedArgs.projectId, typedArgs.tableId)
          : undefined;
        if (aliased === undefined) {
          throw error;
        }
        table = await fetchTable(aliased);
        staleIdNote =
          `Note: the provided tableId '${typedArgs.tableId}' is stale — the table was edited after that id was issued. ` +
          `It was automatically resolved to the current id '${aliased}'. ${STALE_TABLE_ID_HINT}`;
      }

      const formattedResult = formatResponse(table, format);

      return {
        content: [
          ...(staleIdNote ? [{ type: "text", text: staleIdNote }] : []),
          { type: "text", text: formattedResult },
        ],
      };
    },
  });

  registerTool({
    name: "delete_table",
    category: "Rules & Tables",
    title: "Delete Table",
    version: "1.0.0",
    description:
      "Delete an ENTIRE table from a project. The whole table area is cleared from the sheet regardless of table type, so the table no longer exists once the project is recompiled. To remove only a row or column WITHIN a table, use openl_delete_table_row / openl_delete_table_column instead. If the given id went stale through an edit made via this server, it is resolved to the current id automatically. The studio does not auto-compile after the delete — run openl_project_status afterward to confirm the project still compiles (a dangling reference to the deleted table surfaces there).",
    inputSchema: schemas.z.toJSONSchema(schemas.deleteTableSchema) as Record<string, unknown>,
    annotations: {
      destructiveHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId. Use openl_list_tables() to find valid table IDs");
      }

      const format = validateResponseFormat(typedArgs.response_format);
      const projectId = typedArgs.projectId;
      const requestedId = typedArgs.tableId;
      const notes: string[] = [
        "The table area is cleared regardless of type; the table no longer exists once the project recompiles. Run openl_project_status to confirm the project still compiles.",
      ];

      try {
        await client.deleteTable(projectId, requestedId);
      } catch (error) {
        // A 404 deletes nothing, so retrying with a known rename is safe.
        const aliased = isNotFoundError(error) ? resolveTableIdAlias(projectId, requestedId) : undefined;
        if (aliased === undefined) {
          throw error;
        }
        await client.deleteTable(projectId, aliased);
        notes.push(
          `The provided tableId '${requestedId}' was stale (the table was edited after that id was issued) and was automatically resolved to '${aliased}'.`,
        );
      }

      const result = {
        success: true,
        message: `Successfully deleted table ${requestedId}`,
        note: notes.join(" "),
      };

      return {
        content: [{ type: "text", text: formatResponse(result, format) }],
      };
    },
  });

  registerTool({
    name: "update_table",
    validateArgs: (args) =>
      validateStructuredArgs("update_table", { schema: schemas.updateTableSchema, payloadArg: "view", tableTypes: schemas.EDITABLE_TABLE_TYPES }, args),
    category: "Rules & Tables",
    title: "Replace Entire Table",
    version: "1.0.0",
    description:
      "Replace the ENTIRE table structure with a modified version. Use for MODIFYING existing rows, DELETING rows, REORDERING rows, or STRUCTURAL changes. CRITICAL: Must send the FULL table structure (not just modified fields). DO NOT use for simple additions - use append_table instead. Required workflow: 1) Call get_table() to retrieve complete structure, 2) Modify the returned object, 3) Pass the ENTIRE modified object to update_table(). IMPORTANT: an edit that relocates the table (it had no room to grow in place) CHANGES its location-derived id; the response always returns the table's CURRENT id as 'tableId' (plus previousTableId when it changed) — use it for all subsequent calls. Note: the studio does not auto-compile after an edit (it only resets the previous compile status); this tool reads the table back after updating to trigger the recompile, so a subsequent openl_project_status reflects the change.",
    inputSchema: schemas.z.toJSONSchema(schemas.updateTableSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        view: Types.EditableTableView;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId || !typedArgs.view) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId, view");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Same case-sensitive tableType discriminator guard as create (see
      // normalizeEditableTableType): catches a miscased view.tableType before it
      // becomes an opaque backend 400.
      const view = normalizeEditableTableType(typedArgs.view, "view");

      const projectId = typedArgs.projectId;
      const requestedId = typedArgs.tableId;
      const notes: string[] = [];

      // EPBDS-16084/16086: an edit that relocates the table changes its
      // location-derived id. Studio PR #1778 reports the new id directly (the
      // updateTable call returns it); for older studios that don't, fall back to
      // re-resolving by identity — so capture the table's identity (and which
      // same-name ids exist) before the edit for that fallback.
      const identity: TableIdentity | undefined =
        typeof view.name === "string" && view.name
          ? { name: view.name, kind: view.kind, file: view.file, pos: view.pos }
          : undefined;
      let idsBeforeEdit: Set<string> | undefined;
      if (identity) {
        const before = await listTablesByExactName(client, projectId, identity.name);
        if (before) {
          idsBeforeEdit = new Set(before.map((t) => t.id));
        }
      }

      let tableId = requestedId;
      let reportedNewId: string | undefined;
      try {
        reportedNewId = await client.updateTable(projectId, tableId, view);
      } catch (error) {
        // A 404 writes nothing, so retrying with a known rename is safe.
        const aliased = isNotFoundError(error) ? resolveTableIdAlias(projectId, tableId) : undefined;
        if (aliased === undefined) {
          throw error;
        }
        reportedNewId = await client.updateTable(projectId, aliased, { ...view, id: aliased });
        notes.push(
          `The provided tableId '${requestedId}' was stale (the table was edited after that id was issued) and was automatically resolved to '${aliased}'.`,
        );
        tableId = aliased;
      }

      // Determine the table's current id after the write. Prefer the id the
      // studio reported (authoritative); otherwise fall back to re-resolving by
      // identity (older studios that answer 204 even when the id changed).
      let currentId = tableId;
      if (reportedNewId) {
        currentId = reportedNewId;
      } else if (identity) {
        const resolved = await resolveCurrentTableId(client, projectId, tableId, identity, idsBeforeEdit);
        if (resolved) {
          currentId = resolved;
        }
      }
      if (currentId !== tableId) {
        recordTableIdAlias(projectId, tableId, currentId);
        notes.push(
          `This edit changed the table's id from '${tableId}' to '${currentId}' (ids are derived from table content/position). Use 'tableId' from this response for subsequent calls.`,
        );
      }

      // The studio resets (does not recompile) compile status on edit; reading the
      // table back triggers its recompile so openl_project_status reflects the change.
      const recompileTriggered = await triggerTableRecompile(client, projectId, currentId);
      if (!recompileTriggered) {
        notes.push(
          `The post-edit read could not locate the table under id '${currentId}' — the update WAS applied, but the table's id likely changed. Refresh ids with openl_list_tables().`,
        );
      }

      const idChanged = currentId !== requestedId;
      const result = {
        success: true,
        message: `Successfully updated table ${requestedId}`,
        recompileTriggered,
        tableId: currentId,
        ...(idChanged ? { tableIdChanged: true, previousTableId: requestedId } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "append_table",
    validateArgs: (args) =>
      validateStructuredArgs("append_table", { schema: schemas.appendTableSchema, payloadArg: "appendData", tableTypes: schemas.APPEND_TABLE_TYPES }, args),
    category: "Rules & Tables",
    title: "Append Rows/Fields to Table",
    version: "1.0.0",
    description:
      "Add new rows/fields to an existing table (additions only). Payload by type: Datatype→fields, SimpleRules/SmartRules→rules, SimpleSpreadsheet→steps, Spreadsheet→rows+cells, Vocabulary→values, RawSource→rows. For RawSource, each row must cover ALL columns of the table (one cell object per column; rows with a wrong cell count are rejected before anything is written). For modifying, deleting, or reordering use update_table instead. IMPORTANT: an edit that relocates the table (it had no room to grow in place) CHANGES its location-derived id; the response always returns the table's CURRENT id as 'tableId' (plus previousTableId when it changed) — use it for all subsequent calls. Note: the studio does not auto-compile after an edit (it only resets the previous compile status); this tool reads the table back after appending to trigger the recompile, so a subsequent openl_project_status reflects the change.",
    inputSchema: schemas.z.toJSONSchema(schemas.appendTableSchema) as Record<string, unknown>,
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        tableId: string;
        appendData: {
          tableType: string;
          fields?: Array<{ name: string; type: string; required?: boolean; defaultValue?: any }>;
          rules?: Array<Record<string, any>>;
          steps?: Array<any>;
          values?: Array<any>;
          rows?: Array<Array<Record<string, unknown>>>;
          cells?: Array<Array<{ value?: any }>>;
        };
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.tableId || !typedArgs.appendData) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: projectId, tableId, appendData");
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Convert to AppendTableView format expected by client
      const appendData: Types.AppendTableView = typedArgs.appendData as any;

      const projectId = typedArgs.projectId;
      const requestedId = typedArgs.tableId;
      const notes: string[] = [];

      // Spreadsheet append: when row headers are given they must align 1:1 with
      // the cell rows (one 'cells' entry per 'rows' entry); a mismatch otherwise
      // reaches the backend as an opaque 400. (cells presence is enforced by the schema.)
      if (typedArgs.appendData.tableType === "Spreadsheet") {
        const sheetRows = (typedArgs.appendData as { rows?: unknown }).rows;
        const sheetCells = (typedArgs.appendData as { cells?: unknown }).cells;
        if (Array.isArray(sheetRows) && Array.isArray(sheetCells) && sheetRows.length !== sheetCells.length) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Cannot append to Spreadsheet table '${requestedId}': 'rows' has ${sheetRows.length} row header(s) but 'cells' has ${sheetCells.length} cell row(s). ` +
              `Provide one 'cells' entry (an array of { value } across the columns) per 'rows' entry, or omit 'rows' to append cell rows only.`,
          );
        }
      }

      // Probe the table before editing. This (a) fails fast on a stale id —
      // resolving it transparently when the rename is known (EPBDS-16084),
      // (b) captures the identity needed to find the table's new id after the
      // edit, and (c) for RawSource provides the source matrix used to validate
      // row width before anything is written (EPBDS-16085).
      const needsRawProbe = appendData.tableType === "RawSource";
      let tableId = requestedId;
      let probedView: Types.TableView | Types.RawTableView | undefined;
      try {
        probedView = needsRawProbe
          ? await client.getTable(projectId, tableId, true)
          : await client.getTable(projectId, tableId);
      } catch (error) {
        if (isNotFoundError(error)) {
          const aliased = resolveTableIdAlias(projectId, tableId);
          if (aliased === undefined) {
            throw error;
          }
          probedView = needsRawProbe
            ? await client.getTable(projectId, aliased, true)
            : await client.getTable(projectId, aliased);
          notes.push(
            `The provided tableId '${requestedId}' was stale (the table was edited after that id was issued) and was automatically resolved to '${aliased}'.`,
          );
          tableId = aliased;
        }
        // Non-404 probe failures are tolerated: the append call itself decides.
      }

      if (
        needsRawProbe &&
        probedView &&
        Array.isArray((probedView as Types.RawTableView).source) &&
        Array.isArray((appendData as { rows?: unknown }).rows)
      ) {
        validateRawSourceAppendRows(
          (appendData as { rows: Array<Array<Record<string, unknown>>> }).rows,
          (probedView as Types.RawTableView).source,
          probedView.name || tableId,
        );
      }

      // EPBDS-16084/16086 fallback snapshot: which same-name ids exist before the
      // edit, so the table's new id can be re-resolved on older studios that don't
      // report it. Current studios (PR #1778) report the new id directly below.
      const identity: TableIdentity | undefined = probedView?.name
        ? { name: probedView.name, kind: probedView.kind, file: probedView.file, pos: probedView.pos }
        : undefined;
      let idsBeforeEdit: Set<string> | undefined;
      if (identity) {
        const before = await listTablesByExactName(client, projectId, identity.name);
        if (before) {
          idsBeforeEdit = new Set(before.map((t) => t.id));
        }
      }

      const reportedNewId = await client.appendProjectTable(projectId, tableId, appendData);

      // Determine the table's current id after the append. Prefer the id the
      // studio reported (authoritative); otherwise fall back to re-resolving by
      // identity (older studios that answer 204 even when the id changed).
      let currentId = tableId;
      if (reportedNewId) {
        currentId = reportedNewId;
      } else if (identity) {
        const resolved = await resolveCurrentTableId(client, projectId, tableId, identity, idsBeforeEdit);
        if (resolved) {
          currentId = resolved;
        }
      }
      if (currentId !== tableId) {
        recordTableIdAlias(projectId, tableId, currentId);
        notes.push(
          `This edit changed the table's id from '${tableId}' to '${currentId}' (ids are derived from table content/position). Use 'tableId' from this response for subsequent calls.`,
        );
      }

      // The studio resets (does not recompile) compile status on edit; reading the
      // table back triggers its recompile so openl_project_status reflects the change.
      const recompileTriggered = await triggerTableRecompile(client, projectId, currentId);
      if (!recompileTriggered) {
        notes.push(
          `The post-edit read could not locate the table under id '${currentId}' — the append WAS applied, but the table's id likely changed. Refresh ids with openl_list_tables().`,
        );
      }

      // Generate appropriate success message based on table type
      let itemCount = 0;
      let itemType = "items";
      if (typedArgs.appendData.fields) {
        itemCount = typedArgs.appendData.fields.length;
        itemType = "field(s)";
      } else if (typedArgs.appendData.rules) {
        itemCount = typedArgs.appendData.rules.length;
        itemType = "rule(s)";
      } else if (typedArgs.appendData.steps) {
        itemCount = typedArgs.appendData.steps.length;
        itemType = "step(s)";
      } else if (typedArgs.appendData.values) {
        itemCount = typedArgs.appendData.values.length;
        itemType = "value(s)";
      } else if ("rows" in typedArgs.appendData && Array.isArray(typedArgs.appendData.rows)) {
        itemCount = typedArgs.appendData.rows.length;
        itemType = "row(s)";
      } else if ("cells" in typedArgs.appendData && Array.isArray(typedArgs.appendData.cells)) {
        // Spreadsheet append with only cells (one inner array per appended row).
        itemCount = typedArgs.appendData.cells.length;
        itemType = "row(s)";
      }

      const idChanged = currentId !== requestedId;
      const result = {
        success: true,
        message: `Successfully appended ${itemCount} ${itemType} to table ${requestedId}`,
        recompileTriggered,
        tableId: currentId,
        ...(idChanged ? { tableIdChanged: true, previousTableId: requestedId } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });

  registerTool({
    name: "create_project_table",
    validateArgs: (args) =>
      validateStructuredArgs("create_project_table", { schema: schemas.createProjectTableSchema, payloadArg: "table", tableTypes: schemas.EDITABLE_TABLE_TYPES }, args),
    category: "Rules & Tables",
    title: "Create New Table",
    version: "1.0.0",
    description:
      "Create a new table/rule in an OpenL project (Create New Project Table API). This is the recommended tool for creating new OpenL tables programmatically. Use cases: Create Rules (decision tables), Spreadsheet tables, Datatype definitions, Test tables, or other table types. Requires moduleName (an EXISTING project module — modules correspond to the project's .xlsx files; a freshly created blank project has a single module named 'Main') and a complete table structure (EditableTableView). The table structure must include 'tableType' and 'name'. CRITICAL: 'tableType' is a CASE-SENSITIVE discriminator — use EXACTLY one of: Datatype, Vocabulary, Spreadsheet, SimpleSpreadsheet, SimpleRules, SmartRules, SimpleLookup, SmartLookup, Data, Test, RawSource (a lowercase value like 'datatype' is rejected by the backend). Add type-specific data: fields (Datatype), rules (SimpleRules/SmartRules), rows (Spreadsheet), steps (SimpleSpreadsheet), values (Vocabulary). For RULES/DECISION tables (SimpleRules/SmartRules) and lookups you MUST also provide: 'returnType' (e.g. \"String\"), 'args': [{name,type}] (the input parameters), and 'headers': [{title}] (the column captions — one per rule-row key, the return column is usually titled \"RET1\"); each 'rules' row is a map keyed by those header titles. There is NO 'signature' field — the method is defined by name + returnType + args. Example SimpleRules: {tableType:\"SimpleRules\", name:\"CreditCategory\", returnType:\"String\", args:[{name:\"creditScore\",type:\"Integer\"}], headers:[{title:\"creditScore\"},{title:\"RET1\"}], rules:[{creditScore:\"< 580\", RET1:\"Poor\"}, {creditScore:\">= 800\", RET1:\"Excellent\"}]}. WARNING: the backend rejects unknown/extra fields with an opaque 400 \"Failed to read request\". 'id' is optional. Use get_table() on an existing table as a reference for the structure (for a blank project with no tables, use the tableType list and the SimpleRules example above). The response contains the created table's metadata (id, signature), NOT a compilation result — call openl_project_status afterward to confirm the project still compiles. This tool uses the Create New Project Table API endpoint.",
    inputSchema: schemas.z.toJSONSchema(schemas.createProjectTableSchema) as Record<string, unknown>,
    annotations: {
      openWorldHint: true,
    },
    handler: async (args, client): Promise<ToolResponse> => {
      const typedArgs = args as {
        projectId: string;
        moduleName: string;
        sheetName?: string;
        table: Types.EditableTableView;
        response_format?: "json" | "markdown";
      };

      if (!typedArgs || !typedArgs.projectId || !typedArgs.moduleName || !typedArgs.table) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Missing required arguments: projectId, moduleName, table"
        );
      }

      const format = validateResponseFormat(typedArgs.response_format);

      // Normalize the case-sensitive tableType discriminator up front: a wrong
      // case (e.g. "datatype") otherwise reaches the backend as an opaque
      // 400 "Failed to read request" (Jackson can't resolve the subtype).
      const table = normalizeEditableTableType(typedArgs.table, "table");

      const createdTable = await client.createProjectTable(typedArgs.projectId, {
        moduleName: typedArgs.moduleName,
        sheetName: typedArgs.sheetName,
        table,
      });

      const result = {
        success: true,
        tableId: createdTable.id,
        tableName: createdTable.name,
        tableType: createdTable.tableType,
        file: createdTable.file,
        message: `Successfully created ${createdTable.tableType} table '${createdTable.name}' in module '${typedArgs.moduleName}'`,
      };

      const formattedResult = formatResponse(result, format);

      return {
        content: [{ type: "text", text: formattedResult }],
      };
    },
  });
}
