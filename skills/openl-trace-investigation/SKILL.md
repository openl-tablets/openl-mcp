---
name: openl-trace-investigation
description: >
  Investigate why OpenL Tablets produced an unexpected result — wrong value,
  null, rejected claim, or incorrect decision. Trigger when the user asks why
  OpenL returned X, pastes a JSON payload for explanation, references a rule
  execution issue, or asks to fix a dispatch table or rule row.
compatibility: "Requires the openl-mcp MCP tool to be running and connected"
---

# OpenL Trace Investigation Skill

Investigate OpenL Tablets rule execution outcomes. Supports business users,
BAs, and developers. Always lead with root cause and fix — trace
detail follows. Adapt depth and language to the audience (infer from phrasing,
never ask).

---

## Output order — always follow this sequence

1. **ROOT CAUSE** — one short paragraph, plain business language, no table IDs
   or formula syntax. State what produced the wrong outcome and why.
2. **SUGGESTED FIX** — concrete and minimal. Name the table, row/condition, and
   corrected logic. Offer to apply directly if user is a developer or BA. For
   business users, describe in business terms and note it requires a dev team.
3. **SUPPORTING EVIDENCE** — trace summary and table data proving the root
   cause. Depth varies by audience: business users get a plain summary;
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
- Result is mathematically correct given the inputs, but the inputs do not
  represent what was entered on the upstream UI (mapping or integration defect)

If the user provides a **ticket number from a tracking system (like Jira)**,
fetch it first via the issue tracker MCP tool (if connected) to understand full
context before doing anything else.

If the problem description is unclear, ask **one** clarifying question: what
was the expected outcome and what was the actual outcome?

---

## Phase 1 — Identify the project and entry point

### Step 1: Find the right project

List the available OpenL projects and match by product keyword from the user's
description (e.g. "Personal Pet", "STD", "Claims", "Group Dental", "Offering").
If ambiguous, list candidates and ask the user to confirm.

### Step 2: Find the entry point table

Entry points are tables exposed as API endpoints. To identify them:

1. Look for a `rules.xml` file containing an **Included Methods** RegExp
   pattern — tables whose names match are exposed as endpoints.
2. List the tables in the project and find candidates based on the user's
   problem context — the entry point name typically reflects the product or
   operation described. Common naming patterns include `Determine*`,
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

### Step 3: Run a whole-run profiling trace first

Wrap the user's JSON as:

```json
{ "params": { "<paramName>": <value> } }
```

The param name comes from the entry point table's signature. Start the debug
session on the identified project and entry point table with this wrapped
input, using `stopAtEntry: false` and `profiling: true` and no breakpoints —
the run completes in one call and returns a constant-size **profile** overview:
`hotspots` (the slowest tables, by selfMillis/totalMillis/count) plus
`nodeCount`/`distinctTables`/`totalMillis`. It stays small on any project size.

Scan `profile.hotspots` for the table relevant to the problem — the hot table,
or one that ran an unexpected number of times. (To browse a branch's structure
too, re-run with `includeTree: true`; to trace one factor's value across every
coverage, use openl_watch_trace_cells — see Step 4.)

If starting the trace returns 404, the project session is stale — open the
project, then retry. Do NOT fall back to manual table reading — 404 is a
session issue.

If it still fails after opening the project:
- Stop and report the exact error message
- Do NOT attempt manual reconstruction
- Suggest filing a bug against the OpenL MCP server

If the run ends in `error`, the stack carries a structured `error` with the
failing table, step, and exception — that is usually the root-cause pointer.

### Step 4: Replay into the suspicious branch for values

From `profile.hotspots` (or a watch series), pick the table relevant to the
reported problem. To see one factor's value across every coverage/iteration
in one call, run openl_watch_trace_cells with the cell name(s) — read the
series, find the outlier (e.g. 83.372 among 1.0s), and take its `ref`/`tableUri`.
Then **replay**: restart the trace with a breakpoint on that table (the input is
remembered — send neither input nor test ranges), run to the breakpoint, and
inspect the suspended frame (use `excludeStepValues: [1]` to hide neutral rating
factors and surface the outlier):

- parameters, runtime context, and computed step values (expand lazy values
  on demand);
- for a decision table — `decision` (which rule fired and how each condition
  evaluated per rule) and the full rule list for per-rule breakpoints;
- step out of a frame to see its `result` while it is still on the stack.

Terminate the session when the investigation is done.

---

## Phase 3 — Analyse the trace

The trace reflects exactly what the engine executed. Analyse in light of the
reported problem — do not look only for exceptions.

### Issue: error or exception

An exception suspends the trace at the throwing frame before it propagates —
inspect that frame's parameters and step values right there; the terminal
stack's structured `error` names the failing table, step, and exception type.
Read the actual table formula directly from the project — **never infer it**.

### Issue: null or blank result

Null can be a legitimate result (a rule row intentionally returns null, or no
row matched). Do not assume null is always a bug.

- Find where in the trace the value first became null.
- Read the formula or decision table that produced it.
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

### Issue: result is technically correct but doesn't match the intended scenario

The trace runs cleanly, the formula picks a valid branch, and the math is
internally consistent — yet the result is wrong because the input JSON does
not faithfully represent what was entered on the upstream UI. Suspect this
when:

- The result is off by an order of magnitude (10×, 100×, 1/10×, 1/100×).
- A regression mismatch is segment-specific (e.g. child rate wrong, adult
  rate fine), pointing to one branch of the formula firing on bad input.
- The JSON contains fields that look contradictory, redundant, or impossible
  given what the user describes entering on the UI.

Before concluding "OpenL bug", scan the input JSON for **integrity smells**:

- **Dual-encoded fields** — the same business concept sent two ways at once
  (e.g. both `benefitAmount` and `benefitPercentage` for one benefit). The
  formula's branch-selector silently picks one; if that branch was never
  the user's intent, the result is mathematically correct but conceptually
  wrong.
- **Scale errors** — a percentage arriving as `10` when the formula expects
  `0.1`; a basis-point field arriving as a decimal. Multiply the suspect
  field by the obvious scale factor and check whether the wrong answer
  matches the expected one.
- **Phantom fields** — values present in JSON for inputs the user says they
  never entered. Usually from default values, stale offer config, or a
  mapping layer that always emits the field.
- **Inverted booleans or mis-mapped enums** — `true` where `false` was
  intended, or an enum value that routes to the wrong branch.
- **Effective-date drift** — the JSON's effective date routes the trace to
  a module revision the user did not expect.

Then confirm the **arithmetic identity** from the trace: which branch fired,
what value it used, which constant or sub-formula it applied. If the wrong
result equals what a different input value would have produced via a
different branch, that is the smoking gun (e.g. `100/250 = 0.4` is identical
to what `benefitPercentage = 0.10` would yield via `0.10 × 1000 / 250`).

To confirm the upstream defect, request from the user any of:

- UI screenshot of the field(s) in question
- Product model definition (which fields exist, whether mutually exclusive)
- Offer configuration (defaults, hidden fields, conditional show/hide rules)
- Mapping layer rules that build this part of the JSON

If these aren't provided, do not block — state mapping is the suspected
layer based on the JSON evidence and the arithmetic identity, and request
the artifacts to confirm.

### Issue: wrong decision or rule match

- Find the decision table node in the trace.
- Check which condition matched and which rule was returned.
- Read the full decision table to understand all conditions.
- Determine whether the wrong row fired or the right row is missing.

### Root cause taxonomy

Always classify the root cause — the fix differs by type:

| Type | Description | Fix |
|---|---|---|
| **MISSING DATA** | Lookup table exists but has no row for this input | Add data row or reroute |
| **WRONG ROUTING** | Dispatch table sends input to a table that doesn't cover this case | Update dispatch condition |
| **MISSING RULE** | No row in a decision table covers this scenario | Add a rule row |
| **FORMULA BUG** | Formula references wrong field or applies wrong operation | Correct the formula |
| **INPUT MISSING/MALFORMED** | Required input field missing or contains an unexpected value | Fix on calling system side |
| **UPSTREAM MAPPING DEFECT** | Trace ran cleanly, formula picked a valid branch, but the JSON delivered data that does not represent UI entry (dual-encoded fields, scale errors, phantom fields, inverted flags, mis-mapped enums) | Primary fix in the mapping layer; consider a defensive guard in the OpenL formula |

---

## Phase 4 — Propose and apply the fix

State the minimum change needed. Reference the specific table, row, condition,
or formula to change. Do not propose restructuring tables unnecessarily.

If the user is a **developer or BA**: offer to apply the fix directly by
updating the affected table or creating a new one in the project. **Never
apply without explicit user confirmation.**

If the user is a **business user**: describe the fix in business terms and
note it requires a development team action.

### When the bug is upstream (mapping or integration)

If the root cause is `UPSTREAM MAPPING DEFECT`, the fix has two sides:

- **Primary** — the caller (UI, integration layer, or mapping rules) must
  stop sending data that misrepresents the UI entry. This is where the bug
  actually lives.
- **Defensive (optional)** — the OpenL formula can be hardened to reject
  contradictory inputs (e.g. reject when both `$` and `%` are non-zero for
  the same benefit) or to document which branch wins. This is a guardrail,
  not the fix.

Name the owning team(s) for each side. Do not draft tickets unless asked —
just state ownership and the nature of each fix clearly.

After a confirmed fix, suggest filing a ticket in the tracking system (like
Jira) if a bug or data gap was found:
> "Suggest filing: `AgeFactor dispatch table missing cat rows for MixedBreed —
>   causes null premium for mixed-breed cats`"

---

## Cross-project dependency pattern

When a failing table calls into a shared library or another project:

1. Note the dependency reference in the table formula.
2. Locate the dependency project from the list of available projects.
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
- Never conclude an OpenL bug when the trace ran cleanly and the formula picked a valid branch without first checking whether the input JSON faithfully represents the UI entry.
- Never apply a fix in OpenL Studio without explicit user confirmation.
- Never expose internal table IDs or system URLs in business user outputs.
- Never skip running a trace and rely solely on manual table reading to determine the root cause.
