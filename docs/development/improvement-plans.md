# OpenL MCP Server Improvement Plan

Full-codebase review, July 2026 (v1.1.0 plus the unreleased trace/guides work).
Every finding was verified against the current code before inclusion; references
name the file and symbol (line numbers were correct at review time and will drift).

**Baseline at review time:** `tsc --noEmit` clean · 564 tests green · `npm audit`
0 vulnerabilities · dependencies current · ESLint 0 errors / 57 warnings (55
`no-explicit-any`) · coverage 77.8% statements overall, with cliffs:
`stomp-client.ts` 1.5%, `local-change-handlers.ts` 13%, `http-server.ts` 24%,
`repository-handlers.ts` 47%, `fetch-guides.ts` 48%, `login.ts` 52%.

**Overall assessment.** The foundations are in good shape: a single tool registry
feeding two transports and the CLI, centralized error translation with genuinely
agent-friendly messages, disciplined lazy-loading entry points, and a large fast
test suite. The problems cluster in four places: (1) a handful of real correctness
bugs, mostly at the client/handler seam (pagination, filters, formatting) and in
the STOMP wait path; (2) the HTTP transport, which is the least tested and least
hardened component while being the only network-exposed one; (3) a validation
layer that is advertisement-only for ~30 of 58 tools — rich Zod schemas are
published to clients but never executed; and (4) accumulated drift: dead code the
project's own conventions forbid, formatters reading fields the wire types no
longer have, and docs describing infrastructure that no longer exists.

Plans are grouped into workstreams. Priorities: **P0** = wrong results or
security exposure today; **P1** = robustness/leverage; **P2** = hygiene and
longer-term. Effort: S (< ½ day), M (½–2 days), L (> 2 days).

---

## Workstream A — Correctness bugs (P0)

### A1. Server-side pagination is double-applied — page 2+ of `list_projects`/`list_tables` is always empty [P0, M]

`client.listProjects` / `client.listTables` convert `offset`/`limit` to `page`/`size`
query params, then **unwrap the backend's `PageResponse` to a bare array and discard
`pageNumber`/`pageSize`/`total`**. The handlers (`project-handlers.ts`,
`table-handlers.ts`) receive a plain array, set `totalCount` to the *page* length,
and re-slice the already-paged array with `paginateResults(data, limit, offset)`.

Consequences against a paginating backend: `offset: 50, limit: 50` fetches page 1
(items 50–99) and then slices `[50,100)` of that 50-item array → **empty result**;
with `offset: 0`, `total_count` equals the page length so `has_more` is always
`false` — later pages are undiscoverable. The handlers' `'content' in response`
branches (~60 lines × 2) are statically dead (the client's return type is an
array; they only compile via `as any`). The one integration test covering this
(`tests/integration/handlers.test.ts`, "pagination") mocks a backend that ignores
`page`/`size`, which is exactly why the bug is invisible.

**Fix:** have the client return the page envelope (`{ items, pageNumber, pageSize,
total }`), use what is today the dead handler branch, and never re-slice
server-paged data; make the mock backend actually paginate (see E6).
**Done when:** a mocked 120-item project lists correctly across 3 pages with
correct `total_count`/`has_more`/`next_offset`.

### A2. `list_tables` `kind` filter is silently ignored [P0, S]

`client.listTables` puts a `string[]` into `params.kind`; axios's default
serializer emits `kind[]=a&kind[]=b`, which the studio does not bind — the agent
gets *every* table while believing the filter applied. Fix: scope the encoding to
`listTables` — pass a per-request `paramsSerializer: { indexes: null }` (emits
repeated `kind=a&kind=b`) or comma-join the values as `readProjectFile` already
does for `extensions`. Leave the shared axios instance's serializer unchanged
unless repeated-array encoding is deliberately adopted for every future array
param.

### A3. STOMP compile-wait: dropped terminal frames, unsettleable promises, ignored aborts [P0, M]

Four related defects in `stomp-waits.ts` / `stomp-client.ts`:

1. **Terminal-frame race:** a terminal status frame arriving while the race-close
   `getProjectStatus()` fetch is in flight is dropped (`resolveTerminal` is still
   null) and then `lastSeen` is overwritten by the pre-flip HTTP snapshot — the
   tool blocks the full 120 s timeout and returns a stale `compiling` status.
2. **Unsettleable connect:** `subscribeTopic` has no `onWebSocketClose` handler;
   a socket that closes cleanly before STOMP `CONNECTED` (including the abort
   handler's own `deactivate()`) leaves the promise pending forever — and no
   timeout is armed yet at that stage, so the tool call hangs indefinitely.
3. **Already-aborted signals:** `awaitTerminal` and `subscribeTopic` register
   abort listeners without checking `signal.aborted` first, so an abort landing
   during subscribe/fetch degrades into the full 120 s wait.
4. **Mid-wait socket death is silent:** `waitForCompilation` passes no `onError`,
   and clean closes are unhandled, so a studio restart mid-compile idles out the
   timer and returns stale state. Also `void client.deactivate()` discards a
   potential rejection (process-fatal unhandled rejection).

**Fix:** restructure the wait as a settle-once state machine treating connect,
close, error, abort, and timeout as first-class transitions: never let the HTTP
snapshot overwrite a terminal `lastSeen`, resolve immediately when `lastSeen` is
already terminal at registration, reject from `onWebSocketClose` before CONNECTED,
check `signal.aborted` up front, and re-poll or fail fast on mid-wait socket death.
**Done when:** unit tests cover each transition, including the terminal-frame-
during-fetch window and abort-before/after-connect.

### A4. Response formatting lies: no-op truncation, empty "concise" mode, formatter/wire-type drift [P0, M]

- **JSON truncation is a no-op for non-array data** (`formatters.ts`,
  `formatResponse`): an oversized single-object payload (e.g. a big
  `openl_get_table`) is returned in full with `truncated: true` added — the
  "truncation" makes it *larger*. The array path has the same hole when a single
  item exceeds the cap.
- **`markdown_concise` discards all data for single objects** (`toMarkdownConcise`):
  any non-array payload renders as literally "Retrieved details successfully." —
  no id, no status, nothing.
- **`formatDeployments` reads fields that don't exist** on
  `DeploymentViewModel_Short` (`deploymentName`/`repository`/`version` → "N/A")
  and omits `id`/`projectId` — yet `openl_redeploy_project` requires that `id`.
  The mock is typed as the obsolete `DeploymentInfo`, masking the drift.
  `formatRepositories` has the same disease (`Type`/`Status` always "N/A", `id`
  dropped).
- **`formatHistory` and the `commitHash` auto-detection are unreachable** — no
  registered tool produces that shape — and three `dataType` hints
  (`"revisions"`, `"local_changes"`, `"deploy_repositories"`) have no case in
  `toMarkdown`'s switch, silently falling to generic JSON.

**Fix:** for oversized non-array JSON fall back to a hard slice (never emit
`truncated: true` without removing content); give concise mode a key-value digest
for objects; rewrite `formatDeployments`/`formatRepositories` from the actual wire
types and retype the mocks; wire or delete the dead formatter paths. Longer-term
typing fix in D3. **Done when:** formatter tests assert output for every
registered `dataType` from the real wire types, and an oversized object response
is actually ≤ 25 K chars.

### A5. Test-results pagination mixes units and `unpaged` responses are unbounded [P0, S]

`get_test_results` paginates by test **table** but reports `total:
results.numberOfTests` (individual **tests**) — `has_more`/`next_offset` are
computed across incompatible units, sending agents to empty pages. Both test-result
tools also set `skipTruncation: true`, so `unpaged: true` returns megabytes with no
size bound at all. Fix: use table-count totals (`totalElements`) for the pagination
block, and replace blanket `skipTruncation` with a raised `characterLimit` (the
`FormatOptions.characterLimit` option exists and is otherwise unused).

### A6. `open_project` swallows `switchBranch`/`openProject` errors and re-runs the mutation [P0, S]

The `try` in the branch path covers `getProject` + `switchBranch` + `openProject`,
but the catch is documented as "if getProject fails" — a failed branch switch is
silently discarded and `openProject` is invoked *again* (blind duplicate PATCH;
the second error masks the real cause, e.g. "branch not found" surfaces as 409).
Fix: wrap only `client.getProject` in the try; let the mutations propagate.

### A7. Wrong tool annotations: `append_table` is not idempotent [P0, S]

`append_table` carries `idempotentHint: true`; retrying an append duplicates rows —
an MCP client that auto-retries timeouts can silently duplicate rules. Remove it;
also review `deploy_project`/`redeploy_project` (each call creates a new deployment
version) and `start_project_tests`.

### A8. Table-id alias key contradicts its own collision-safety comment [P0, S]

`table-id-tracking.ts` documents the alias key as `projectId + NUL + tableId`
("a NUL can't occur in either id, so distinct pairs never collide") but joins with
a **space** — and project ids routinely contain spaces. A colliding alias can
redirect a stale-id retry — including `delete_table`'s — to the wrong table.
One-character fix: `` `${projectId}\u0000${tableId}` ``.

### A9. Production repository resolution rejects ids [P0, S]

`getProductionRepositoryIdByName` matches only exact, case-sensitive `name`, while
the argument is *named* `productionRepositoryId` and every design-repo tool accepts
id **or** name case-insensitively (`getRepositoryIdByName`, 4-step match). Mirror
that resolution for deploy repositories.

### A10. `getTestResultsByTable` page-scan guesses the server's page size [P0, S]

When the caller passes no `size`, requests go out without one (server default) but
the stop condition compares `numberOfElements >= 50` (a local constant) — if the
server's default page size is smaller, the scan stops after one page and silently
drops matching test results. Always send an explicit `size` (or derive from the
response's `pageSize`).

### A11. `healthCheck` answers from the repository cache [P0, S]

`healthCheck()` calls `listRepositories()` with `useCache: true`, so after one
successful call it reports "healthy" forever without touching the network. The
method is also production-dead (see D5) — either delete it with the other dead
methods or fix it to `listRepositories(false)` if it is about to gain a caller.

---

## Workstream B — HTTP transport security & lifecycle (P0/P1)

The HTTP transport is the only network-exposed component and the least tested
(24% coverage; the session/auth/lifecycle code has no in-process tests at all).
These items should land together with the test suite in E4.

### B1. No Origin validation + wildcard CORS: drive-by websites can execute tools [P0, M]

`app.use(cors())` defaults to `Access-Control-Allow-Origin: *` and `/mcp` never
validates `Origin`/`Host` — the MCP spec requires Origin validation precisely to
prevent DNS-rebinding/drive-by access. With the documented compose setup (loopback
port, studio in single-user mode, unauthenticated sessions falling back to the
default client), any web page in the operator's browser can POST `initialize` +
`tools/call` and read the responses — i.e. read, modify, and deploy business rules.
**Fix:** allowlist localhost origins by default (configurable), reject unknown
`Origin`, and replace bare `cors()` with an explicit config including
`exposedHeaders: ['Mcp-Session-Id']` (without which a legitimate browser client
cannot read the session id at all).

### B2. All unauthenticated sessions share one client — and one studio JSESSIONID [P0, S]

`getClientForSession` returns the shared `defaultClient` whenever no token is
supplied; its captured `JSESSIONID`, repository cache, and test-execution headers
are shared mutable state. Trace debugging is server-side state keyed by that
session ("one active session per user"): two token-less MCP clients on one `--http`
server terminate each other's debug sessions and interleave step/inspect state.
**Fix:** construct a fresh `OpenLClient` per MCP session (base URL is the only
config needed).

### B3. `express.json()` default 100 kb body limit caps tool payloads on HTTP only [P0, S]

A large `openl_update_table`/`openl_write_project_file` payload (>100 kb is routine
for Excel tables / base64 files) fails over HTTP with a generic 500
(`PayloadTooLargeError` falls into the error middleware) while the same call works
over stdio. Set an explicit limit (e.g. `10mb`) and map body-parser errors to a
proper JSON-RPC error response.

### B4. `startHttpServer` neither awaits the bind nor handles listen errors [P1, S]

`app.listen(PORT, cb)` is fire-and-forget: the `http.Server` handle is discarded
and no `'error'` listener exists, so EADDRINUSE crashes with a raw uncaught
exception, bypassing `index.ts`'s "Failed to start" handler (which already
returned). Await the `listening` event, reject on `error`, keep the handle (B5).
Also validate `PORT` (a non-numeric value is currently treated by Node as a *unix
socket path* and "successfully" listens on a socket file).

### B5. No graceful shutdown [P1, S]

No SIGTERM/SIGINT handling; open StreamableHTTP transports and SSE streams are
severed mid-write on `docker stop`, and a bare `node dist/index.js --http` as
container PID 1 ignores SIGTERM entirely (waits out the 10 s kill). On signal:
`server.close()`, close all session transports, exit.

### B6. Session bookkeeping: leak on failed initialize + no TTL [P1, M]

`getClientForSession` writes `clientsBySession[sessionId]` *before* the transport
exists; if `connect()`/`handleRequest` fails before the SDK assigns the session id,
`onclose` never fires and the entry leaks (a cheap DoS when combined with B1).
Make `onsessioninitialized` the single writer. Then add the TTL/idle-timeout
cleanup with a max-session cap so abandoned sessions (network drops, killed
clients) can't accumulate over weeks — plus periodic sweep and shutdown cleanup.
*(Supersedes old Plan 1; old Plan 3's in-flight-creation mutex becomes moot once
clients are per-session and created synchronously.)*

### B7. Session auth is checked only at `initialize` [P1, M]

After session creation the `mcp-session-id` header is the sole credential: a
request carrying a different (or revoked) token on an existing session is served
with the original session's PAT, and token rotation has no effect on live
sessions. Record an auth fingerprint per session (`hashFingerprint` exists in
`utils.ts`) and reject mismatches. Related small fixes: accept `bearer`/`token`
schemes case-insensitively (RFC 7235), and return **404** (not 400) for an unknown
session id so spec-compliant clients transparently re-initialize after a restart.

### B8. Rate limiting [P2, S]

Still unaddressed (old Plan 7). Note the MCP SDK now ships with
`express-rate-limit` as a dependency, so this adds no new third-party weight.

---

## Workstream C — Client robustness & security (P1)

### C1. Repo-level file APIs skip the dot-segment defense the project-level APIs enforce [P1, S]

`getRepositoryFileContent`, `downloadRepositoryFolderZip`, `updateRepositoryFileRaw`
encode with a bare per-segment `encodeURIComponent`, and `copyRepositoryFile` sends
body paths raw — `.`/`..` segments pass through, while the project-file API
deliberately rejects them via `assertSafeProjectPath` (whose docblock explains why
encoding alone is insufficient). An LLM-supplied `projectName` like `../X` in the
clone flow reaches these URLs. Apply `assertSafeProjectPath` (and one shared
encoding helper — there are 5 copies of segment-encoding today) in all four.

### C2. First-request bootstrap gate can deadlock the client [P1, S]

The gate's release function travels on `config._releaseFirstRequestGate`, and the
error path only releases when `error.config` exists. A rejection without `config`
(e.g. a later request interceptor throwing) leaves the gate armed forever — every
subsequent request then waits on it with **no timeout** (axios `timeout` doesn't
cover interceptor waits). Keep the release in an instance field and release it on
both paths regardless of `error.config`; bound the gate wait.

### C3. Test-execution "session" replays response headers as request headers [P1, S]

`extractTestExecutionHeaders` copies *every* response header not on a hand-kept
exclude list (misses `X-Frame-Options`, `CSP`, `HSTS`, …) into subsequent request
headers, and freezes the `Cookie` captured at `tests/run` time (a rotated
JSESSIONID then points summary calls at a dead session). Allow-list only what is
needed; the session cookie is already handled globally by the interceptor.

### C4. Repositories cache has no TTL and no invalidation path [P1, S]

`repositoriesCache` lives for the process lifetime; a repository created/renamed in
the studio is invisible until restart — and the "not found" error tells the model
to call `openl_list_repositories()`, which serves the same stale cache. No
production caller ever passes `useCache: false`. Add a short TTL and/or re-fetch
once on resolution miss before throwing. *(Refines old Plan 2; the
`testExecutionHeaders` half of that plan is subsumed by C3.)*

### C5. Token cache: `/rest`-variant key misses, permission gap, non-atomic writes [P1, S]

`cacheKey` normalizes only case/trailing slash, so `login http://x:8080` +
`OPENL_BASE_URL=http://x:8080/rest` (both valid) silently miss the cached PAT.
`writeFile(..., { mode: 0o600 })` applies only on creation (a pre-existing looser
file keeps its mode) and read-modify-write is non-atomic. Normalize via the same
base-URL normalizer, chmod/temp-and-rename on write.

### C6. Small security polish [P2, S]

Escape the `error` query param interpolated into the login loopback HTML (reflected
XSS, low impact); replace 12–24-char session-id prefixes in DEBUG logs with
`hashFingerprint` (already in `utils.ts`).

### C7. Bounded reads (revised old Plan 4) [P2, S]

Old Plan 4 targeted `downloadFile`, which is dead code (D5) — delete it instead.
The residual risk is `readProjectFile`/`getRepositoryFileContent`/
`downloadRepositoryFolderZip` buffering whole files into memory; add a
`maxContentLength` on the axios instance (or per-call) with a clear
"use offset/length" error.

---

## Workstream D — Structural refactoring (P1, highest leverage)

### D1. Enforce every tool's Zod schema at dispatch [P1, M — the single highest-leverage change]

Two reviewers converged on this independently. Rich Zod schemas exist for all 58
tools but are runtime-enforced for only the 15 table tools wired to `validateArgs`;
everything else runs on hand-rolled `if (!args.x)` guards. Consequences verified
in code: `.strict()` is advertised (`additionalProperties: false`) but typo'd args
are silently ignored; the `.refine` mutual-exclusivity on the test-results schemas
never executes anywhere (pure dead logic); `project_status.timeoutMs`'s 600 000 cap
and `read_project_file.offset`'s nonnegativity are prose — a 10-hour timeout or a
negative offset (which `Buffer.subarray` interprets as *from the end*) sail
through; 38 hand-rolled missing-arg throws duplicate ~4 lines each.

**Fix:** keep each tool's Zod schema on its `ToolDefinition` and default
`validateArgs` to `schema.safeParse` in `executeTool`; type handler args via
`z.infer` instead of `args as {...}` casts. This activates all dormant
constraints/defaults, deletes ~150 lines of guard boilerplate, removes the
drift-prone casts, and guarantees the published JSON Schema can never diverge from
runtime behavior again. Fold in the schema-consistency fixes found on the way:
`size` capped like its alias `limit`; defaults declared via `.default()` not
prose; `startProjectTestsSchema.tableId` using the shared `tableIdSchema`; the
two inline pagination schemas in `repository-handlers.ts`/`deployment-handlers.ts`
moved into `schemas.ts`.

### D2. Give `OpenLClient` a request core, then split it by domain [P1, L]

`client.ts` is a 2,657-line god class spanning eight domains with three
generations of style. Quantified duplication: path-segment encoding ×5 (only one
copy validates dot segments — the root cause of C1), offset/limit→page/size
translation ×2, PageResponse unwrapping ×2 (divergent), branch-param config
building ×8, local-repo guard ×2, test-summary GET boilerplate ×2. **Fix in two
steps:** (1) a small private request core — one path builder owning encoding *and*
dot-segment validation, one params builder, typed `getJson`/`postJson`/`getBinary`
helpers with a single error-mapping policy, and a typed page-envelope return
(prerequisite for A1); (2) split the domains into focused modules composed onto
the client, mirroring the handler categories. Step 1 alone collapses most of the
duplication and makes A2/C1-class drift structurally impossible.

### D3. Type the formatter layer [P1, M]

`formatters.ts` is `any`-typed duck-typing over field names the wire types no
longer have — which is why A4's drift failed silently at runtime. Make `dataType`
a closed union with an exhaustive switch over typed per-type formatter functions
(a compile error when a hint has no case or a field disappears), and type
`escapeTableCell`'s parameter honestly (`unknown`; also strip `\r`). Extract the
thrice-duplicated data-type auto-detection block.

### D4. Dead code sweep [P1, M]

The repo's own convention is "no dead code", and the review found a substantial
accumulation (all verified by repo-wide grep — kept alive only by their own tests):

- **`client.ts` (~220 lines):** `downloadFile`, `updateProjectStatus`,
  `createRule`, `healthCheck` — zero production callers. Plus `validateProject`,
  called only from `saveProject` against an endpoint the method's own docblock
  says does not exist — every save performs a known-doomed GET.
- **Handlers (~120 lines):** the statically-dead `'content' in response` and
  "API already paginated" branches (deleted as part of A1).
- **`utils.ts`:** `parseProjectId` (actively dangerous — invites splitting opaque
  ids), `extractErrorDetails`, `createProjectId` (its own JSDoc says "legacy,
  should not be used").
- **`types.ts`:** the orphaned chains `CreateRuleRequest/Result`,
  `ValidationResult/Error/Warning`, `GetProjectHistoryRequest/Result`,
  `ProjectHistoryCommit`, `CommitType`, `ProjectRevision_Short`,
  `PageResponseProjectRevision_Short`, `DatatypeView`; three empty "Phase 2/3/4"
  banner blocks.
- **`project-templates.ts`:** the ~12 KB base64 `"sample"` template blob
  (`getProjectTemplateZip` is only ever called with `"empty"`) and the
  unreachable `if (!base64)` throw.
- **Dead exports:** `stomp-client.ts#buildDestination`,
  `table-id-tracking.ts#recordTableIdAlias`/`triggerTableRecompile`,
  `formatters.ts#FormatOptions.characterLimit` (or adopt it for A5), the six
  never-imported building-block schemas in `schemas.ts` (or adopt them per D1),
  6 of 9 exports in `tests/mocks/openl-api-mocks.ts`.
- **`logger.ts`:** `warn`/`info`/`debug` have zero call sites — adopt them at the
  ~30 raw `console.error` sites or delete them (see F5).
- **Dependencies:** `nock` (devDependency, zero imports).
- **Leftovers:** stranded JSDoc block in `project-handlers.ts` documenting
  `handleToolError` (which lives in `common.ts`); `listDeployRepositories`'
  ignored `_useCache` param with a JSDoc claiming caching semantics; empty
  `afterAll` in `cli-spawn.test.ts`; jest `**/__tests__/**` glob matching
  nothing; dependabot `ts-node` pattern matching no dependency.

### D5. Extract the shared handler helpers [P2, S]

`requireArgs(args, [...])` to replace 38 hand-rolled guards (13 of which repeat the
same "To find valid project IDs…" sentence verbatim); one STALE-table-id sentence
(3 copies with wording drift); the duplicated identity-snapshot/re-resolution
blocks in `update`/`append` (~25 lines × 2); shared Zod fragments for the
`getTestResults*` pair (~27 identical lines) and the append/editable table-type
unions (byte-identical branch pairs). Most of this falls out naturally while
doing D1.

### D6. Miscellaneous verified bugs to fix during the refactors [P2, S]

- `safeStringify` corrupts shared *non-circular* references to `"[Circular]"`
  (verified: `{a: shared, b: shared}` → second occurrence replaced). Track the
  ancestor path, not all visited nodes.
- `watch_trace_cells` discards the run's terminal status — a failed run returns a
  partial series with no error indication. Include `status`/`error` when the run
  didn't complete.
- `create_project` branch-clone: a rename failure after the copy commits surfaces
  as a bare error though the clone exists; retry then hits 409. Report
  "copy succeeded, rename failed" like step 3 already does.
- `read_project_file` continuation offset can split a multi-byte character at the
  25 K seam (code-unit slice + `Buffer.byteLength` of the replacement char); back
  off to a code-point boundary.
- `update_table` client-side id-mismatch throws a plain `Error` → surfaces as
  `InternalError` though it's a caller mistake (`InvalidParams`).
- `getProjectHistory` fabricates `timestamp: new Date()` and `branch: "main"`
  when fields are missing (dead code today — delete with D4, or fix if kept).
- Markdown truncation overshoots the cap by the note length and can split a
  surrogate pair; pagination footer prints "Showing items 21-10" when `offset`
  exceeds `total`.

---

## Workstream E — Test suite & CI (P1)

### E1. Tests are never type-checked or linted [P1, S]

Verified empirically: a test containing `const n: number = "not a number"` passes
the suite. `tsconfig.json` excludes `tests/`, ts-jest runs `isolatedModules: true`
(transpile-only), and `npm run lint` covers `src` only. Add a
`tsc --noEmit -p tsconfig.test.json` script wired into CI and extend eslint to
`tests/`. Without this, refactors leave tests silently referencing dead API —
`openl-live.test.ts` (skipped in CI) compiles today only by luck.

### E2. CI gaps: nothing runs on push to `main`, coverage unenforced, lint accepts warnings forever [P1, S]

- `quick-build.yml` triggers on `pull_request` only — a direct push/merge leaves
  `main` unchecked until the nightly.
- Coverage is measured but never enforced (no `coverageThreshold`, no CI coverage
  step) while `testing.md` states >80% goals; the cliffs in the baseline are
  invisible.
- `npm run lint` has no `--max-warnings` gate, so the 57 warnings can grow
  unbounded (the `console.log` in `http-server.ts` has sat as a warning);
  `parserOptions.project` is configured but no type-aware rules are enabled —
  full type-parse cost, zero benefit.
- The nightly `deploy.yml` never runs `actions/setup-node` — the prerelease
  tarball (which `compose.yaml` pulls daily) is built on whatever Node the runner
  image ships, unpinned against `engines: >=24`.

### E3. Packaging safety net [P1, S]

No `prepublishOnly`/`prepack` hook: the release workflow's own documented recovery
path ("re-run `npm publish` from the tagged checkout") publishes a tarball with
**no `dist/` and no `guides/`** on a fresh checkout (npm doesn't validate `bin`
targets). Add `"prepublishOnly": "npm run lint && npm test && npm run build"`.

### E4. In-process test suite for `http-server.ts` [P1, M]

The security-critical component has one exported helper under test; session
creation/reuse, auth parsing, error paths, and the full `/mcp` lifecycle ship
unverified (24% coverage — and every Workstream B fix needs a regression test).
Add supertest-style in-process tests: initialize/reuse/terminate, Token vs Bearer
vs none, oversized body, unknown session id, origin checks, shutdown.

### E5. Coverage cliffs and convention violations [P1, M]

- `stomp-client.ts` (283 lines of WebSocket/STOMP handling) at 1.5% — unit-test it
  with a mock WS (A3's state machine makes this tractable).
- No test file at all for `src/logger.ts` and `src/project-templates.ts`
  (violates the tests-mirror-src convention); `tests/stomp-waits.compilation.test.ts`
  should be `tests/stomp-waits.test.ts`; `tests/cli-spawn.test.ts` mirrors no
  `src/cli-spawn.ts` (it exercises `index.ts` dispatch — rename or document).
- Six tools' handler layer is exercised nowhere: `list_deploy_repositories`,
  `list_project_local_changes`, `list_repository_features`, `redeploy_project`,
  `repository_project_revisions`, `restore_project_local_change` — which is
  exactly where the A4/A9-class formatter and resolution bugs live.
- `local-change-handlers.ts` 13%, `repository-handlers.ts` 47%, `login.ts` 52%,
  `fetch-guides.ts` 48%.

### E6. Test-suite correctness [P1, S]

- The pagination mock must actually paginate (returning everything regardless of
  `page`/`size` is what hid A1). Mocks should mirror real backend behavior.
- `cli-spawn.test.ts` rebuilds `dist/` when it is older than **4 hand-picked
  files** — edits to `mcp-core.ts`/handlers don't trigger a rebuild (stale-dist
  test runs), and in CI the rebuild shells out to `git clone github.com/...`
  inside the *test* step (hidden network dependency; "Test" runs before "Build"
  in quick-build). Compare against the newest mtime under `src/**` and make CI
  build first.
- Remove the duplicated `validators.test.ts` limit-validation tests (repo rule:
  strengthen, don't duplicate) and fix the `openl-live.test.ts` "expected 404"
  tests that pass regardless of the behavior in their name.

---

## Workstream F — Docs, logging & product hygiene (P2)

### F1. User-facing doc corrections [P2, S]

- `README.npm.md` claims "**40 active tools**"; the server registers **58** — and
  this is the exact file the release workflow swaps in as the npmjs.com README.
  Fix the count or drop hard-coded counts (a catalog cross-validation test exists
  for `--help`; extend it to any kept count).
- `.specify/memory/constitution.md` says **License: MIT**, version 1.0.0, and an
  old repo URL — actual: LGPL-3.0 (LICENSE + package.json + README), 1.1.0,
  `openl-tablets/openl-mcp`. The constitution also declares "zero tolerance for
  `any`" against today's 55 warnings — align the principle or the reality (F6).

### F2. Developer-doc rot [P2, S]

`docs/development/testing.md` documents a nonexistent `ci.yml`, `mcp-server/**`
paths, push-to-develop triggers, and teaches `nock` (nothing imports it) with
examples that assert a mock's own reply (the antipattern AGENTS.md bans).
`tests/integration/README.md` describes a `.env.test` mechanism nothing loads,
references a nonexistent `API_ENDPOINT_MAPPING.md`, and targets "OpenL Studio
6.0.0" (actual: 6.3.0). `cli-audit-followups.md` item P2.20a proposes fixing the
deleted workflow. The `skills/` directory is linked from no index doc. Rewrite
around the real stack (axios-mock-adapter, quick-build.yml).

### F3. Unify `DEBUG` env semantics [P2, S]

`logger.ts` gates debug/info on raw truthiness (`DEBUG=false` **enables** them)
while `auth.ts` uses `parseBoolEnv` for the same variable — two contradictory
semantics for one flag. Use `parseBoolEnv` everywhere.

### F4. Logger consolidation (revises old Plan 10) [P2, M]

`logger.sanitizeContext` is strictly weaker than `utils.sanitizeJson` (doesn't
redact string patterns/keys, mangles arrays into `{"0":…}`, recurses without a
cycle guard, and only `error` sanitizes at all) — delete it and use `sanitizeJson`
at every level; run the sanitizer over `endpoint` in `handleToolError` (a base URL
carrying basic-auth credentials currently reaches the log and the McpError data
verbatim). Then either adopt `warn`/`info`/`debug` at the ~30 raw `console.error`
sites or delete the unused levels. Full structured-logging/correlation-id work
remains optional beyond that.

### F5. `any` elimination with a ratchet (old Plan 6, updated) [P2, M]

55 `no-explicit-any` warnings today (was 33 when Plan 6 was written — it drifted
upward because nothing enforces it). Do it in D1–D3's wake (typed args, typed
formatters, typed axios responses remove most instances), then set
`--max-warnings 0` in the lint script so it can never regress.

### F6. Version-aware tool availability (old Plan 12 — unchanged, still valid) [P2, M]

Tag tools with `minStudioVersion`, fetch `GET /public/info/openl.json` lazily, and
surface "requires OpenL Studio ≥ X, connected: Y" instead of opaque HTTP errors.
The trace tools (new Debug API) make this timely.

### F7. Release housekeeping [P2, S]

The `## [Unreleased]` changelog section now carries a released-sized feature set
(trace debugger rework, guides bundle, raw table tools, login flow) — cut 1.2.0.
Also consider a `healthcheck:` for the mcp service in `compose.yaml` (the
purpose-built `/health` endpoint is unused there), and pin or checksum the nightly
`x` tarball the compose service re-installs on every container start.

---

## Suggested sequencing

| Phase | Contents | Rationale |
|-------|----------|-----------|
| 1 | A2, A6–A11, B2, B3, E1, E2, E3, F1 (all S) | Maximum wrong-result/security payoff per line changed; unblocks trustworthy CI |
| 2 | A1 + E6 (pagination + honest mocks), A3 (STOMP state machine), A4/A5 (formatting truth), B1, B4–B6, E4 | The two correctness clusters and transport hardening, each landing with its regression tests |
| 3 | D1 (uniform validation) → D5, C1–C5, D4 (dead-code sweep), E5 | Structural leverage: one change activates all schemas; the sweep shrinks the surface before deeper refactors |
| 4 | D2 (client core + split), D3 (typed formatters), D6, F2–F5 | Long-term maintainability on a now-tested base |
| 5 | B7, B8, C6, C7, F6, F7 | Polish and feature-level work |

---

## History

Completed plans from the previous (2025) revision of this document, kept for
context: **Plan 5** (split `tool-handlers.ts` into `src/handlers/` with the
registry in `common.ts`), **Plan 8** (in-memory prompt caching), **Plan 9**
(shared `mcp-core.ts` for both transports), **Plan 11** (removal of the dead
`tools.ts`). Superseded/absorbed: Plan 1 → B6, Plan 2 → C3/C4, Plan 3 → B6 (moot
after B2), Plan 4 → C7 (revised: `downloadFile` is dead code), Plan 6 → F5,
Plan 7 → B8, Plan 10 → F4, Plan 12 → F6.
