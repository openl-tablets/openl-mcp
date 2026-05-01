---
name: openl-trace-investigation
description: >
  Investigate why OpenL Tablets produced an unexpected result — wrong value,
  null, rejected claim, or incorrect decision. Trigger when the user asks why
  OpenL returned X, pastes a JSON payload for explanation, references a rule
  execution issue, or asks to fix a dispatch table or rule row.
compatibility: "Requires the openl-mcp-server MCP tool to be running and connected"
---

# OpenL Trace Investigation Skill

Investigate OpenL Tablets rule execution outcomes. Supports claim
specialists, BAs, and developers. Always lead with root cause and fix — trace
detail follows. Adapt depth and language to the audience (infer from phrasing,
never ask).

---

## Output order — always follow this sequence

1. **ROOT CAUSE** — one short paragraph, plain business language, no table IDs
   or formula syntax. State what produced the wrong outcome and why.
2. **SUGGESTED FIX** — concrete and minimal. Name the table, row/condition, and
   corrected logic. Offer to apply directly if user is a developer or BA. For
   claim specialists, describe in business terms and note it requires a dev team.
3. **SUPPORTING EVIDENCE** — trace summary and table data proving the root
   cause. Depth varies by audience: claim specialists get a plain summary;
   developers get the full trace tree, formulas, and table data.

Never reverse this order.

---

## Tone and depth by audience

Infer from how the question is phrased — do not ask the user:

- *"Why was my claim rejected?" / "Why is the premium wrong?"* → plain language,
  no table names or formulas, actionable next step for the business.
- *"Trace this for [product]" / "What's wrong with [table]?"* → root cause +
  fix + summary trace, table names included.
- *"Why is [factor] null?" / "Can you fix the dispatch table?"* → full trace
  tree, formula text, lookup data, offer to apply the fix.

---

## Phase 0 — Understand the problem

Always identify the expected vs actual outcome before tracing. Common issue types:

- Result is null/blank when a value was expected
- Calculation produced a wrong number
- Decision table returned an unexpected result or no result
- A rule was skipped or matched incorrectly
- A validation fired when it should not, or did not fire when it should

If the user provides a **ticket number from a tracking system (like Jira)**,
fetch it first via the issue tracker MCP tool (if connected) to understand full
context before doing anything else.

If the problem description is unclear, ask **one** clarifying question: what
was the expected outcome and what was the actual outcome?

---

## Phase 1 — Identify the project and entry point

### Step 1: Find the right project

```
openl_list_projects()
```

Match by product keyword from the user's description (e.g. "Personal Pet",
"STD", "Claims", "Group Dental", "Offering"). If ambiguous, list candidates and
ask the user to confirm.

### Step 2: Find the entry point table

Entry points are tables exposed as API endpoints. To identify them:

1. Look for a `rules.xml` file or table properties containing an **Included
   Methods** RegExp pattern — tables whose names match are exposed as endpoints.
2. Call `openl_list_tables(projectId=<id>)` and find candidates based on the
   user's problem context — the entry point name typically reflects the product
   or operation described. Common naming patterns include `Determine*`,
   `Calculate*`, `Process*`, `Rate*`, but match by context first, not by name.
3. **Match against the user's input structure**: read the top-level parameter
   types of each candidate (from the table signature). Compare against keys in
   the user's JSON. E.g. if input has a `policy` object and the signature is
   `DeterminePolicyPremium(Policy policy)` → strong match.
4. If multiple candidates match, use problem context to disambiguate (premium
   → rating entry point; claim decision → claims entry point).
5. If still ambiguous, ask the user to confirm.

---

## Phase 2 — Run the trace

### Step 3: Open the project if needed

If `openl_start_trace` returns 404, the project session is stale:

```
openl_open_project(projectId=<id>)
```

Then retry. Do NOT fall back to manual table reading — 404 is a session issue.

### Step 4: Wrap and start the trace

Wrap the user's JSON as:

```json
{ "params": { "<paramName>": <value> } }
```

The param name comes from the entry point table's signature.

```
openl_start_trace(tableId=<id>, input=<wrapped_json>)
```

If this still fails after opening the project:
- Stop and report the exact error message
- Do NOT attempt manual reconstruction
- Suggest filing a bug against the OpenL MCP server

### Step 5: Export the full trace

```
openl_export_trace(traceId=<id>)
```

Scan for:
- `ERROR` nodes
- `null` values on fields the user cares about
- Unexpected fallback branches or early exits

---

## Phase 3 — Analyse the trace

The trace reflects exactly what the engine executed. Analyse in light of the
reported problem — do not look only for exceptions.

### Issue: error or exception

Follow every ERROR node to its deepest child:

```
openl_get_trace_nodes(traceId=<id>)
openl_get_trace_nodes(traceId=<id>, nodeId=<id>)   # drill into children
openl_get_trace_node_details(traceId=<id>, nodeId=<id>)
```

Read the actual table formula with `openl_get_table` — **never infer it**.

### Issue: null or blank result

Null can be a legitimate result (a rule row intentionally returns null, or no
row matched). Do not assume null is always a bug.

- Find where in the trace the value first became null.
- Read the formula or decision table that produced it (`openl_get_table`).
- Read the **full** relevant lookup table to check whether the input combination
  has a matching row — do not assume it is missing.
- Determine: is null expected (no match by design) or unexpected (missing data,
  wrong routing, missing rule row)?

### Issue: wrong calculation

- Find the cell or rule that produced the unexpected value.
- Read its formula.
- Trace back through inputs — identify which factor, rate, or condition
  contributed the wrong value.
- Read the relevant lookup tables to confirm what was returned and why.

### Issue: wrong decision or rule match

- Find the decision table node in the trace.
- Check which condition matched and which rule was returned.
- Read the full decision table (`openl_get_table`) to understand all conditions.
- Determine whether the wrong row fired or the right row is missing.

### Root cause taxonomy

Always classify the root cause — the fix differs by type:

| Type | Description | Fix |
|---|---|---|
| **MISSING DATA** | Lookup table exists but has no row for this input | Add data row or reroute |
| **WRONG ROUTING** | Dispatch table sends input to a table that doesn't cover this case | Update dispatch condition |
| **MISSING RULE** | No row in a decision table covers this scenario | Add a rule row |
| **FORMULA BUG** | Formula references wrong field or applies wrong operation | Correct the formula |
| **INPUT ISSUE** | Input missing a required field or contains unexpected value | Fix on calling system side |

---

## Phase 4 — Propose and apply the fix

State the minimum change needed. Reference the specific table, row, condition,
or formula to change. Do not propose restructuring tables unnecessarily.

If the user is a **developer or BA**: offer to apply the fix directly using
`openl_update_table` or `openl_create_project_table`. **Never apply without
explicit user confirmation.**

If the user is a **claim specialist**: describe the fix in business terms and
note it requires a development team action.

After a confirmed fix, suggest filing a ticket in the tracking system (like
Jira) if a bug or data gap was found:
> "Suggest filing: `AgeFactor dispatch table missing cat rows for MixedBreed —
>   causes null premium for mixed-breed cats`"

---

## Cross-project dependency pattern

When a failing table calls into a shared library or another project:

1. Note the dependency reference in the table formula.
2. Use `openl_list_projects` to find the dependency project.
3. Repeat Phase 3 in the dependency project.
4. Report root cause at the dependency level, not the caller level.

**Common pattern**: Rating or processing projects often depend on shared library
projects. The failure appears in the calling project but the missing data or
rule is in the shared library.

---

## What you must never do

- Never ask the user to find the project or table themselves if they haven't provided it.
- Never conclude a root cause without reading the actual table formula first.
- Never assume data is missing from a lookup without reading the full table.
- Never treat all nulls as errors — check whether null is the intended result.
- Never apply a fix in OpenL Studio without explicit user confirmation.
- Never expose internal table IDs or system URLs in claim specialist outputs.
- Never skip running a trace and rely solely on manual table reading to determine the root cause.
