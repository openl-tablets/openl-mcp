# OpenL MCP Server Improvement Plans

Deep codebase analysis results. Plans are grouped by priority.

---

## Plan 1. TTL-based Cleanup for Sessions and Transport Maps [CRITICAL]

**Problem:** In `server.ts`, `clientsBySession` and `sseTransports` for SSE connections are cleaned up via a `res.on('close')` handler, while `streamableHttpTransports` (and the associated `clientsBySession` entries for StreamableHTTP) are cleaned up via `transport.onclose`. If these close callbacks don't fire (e.g., network drop, client process kill, or abrupt server termination), entries can remain indefinitely. During long-running Docker deployments, this leads to memory leaks.

**Affected files:**
- `src/server.ts` — primary changes
- New file `src/session-store.ts`

**Implementation steps:**

1. Create a generic `SessionStore<T>` class (in `src/session-store.ts`):
   - Stores entries with a `lastActivity: number` timestamp
   - `set(id, value)` — adds/updates entry and refreshes `lastActivity`
   - `get(id)` — returns value and refreshes `lastActivity`
   - `delete(id)` — removes entry
   - `cleanup()` — removes entries older than TTL
   - `size()` — for monitoring
   - Optional `onExpire` callback for graceful cleanup (e.g., closing transports)

2. In `server.ts`, replace plain objects with `SessionStore`:
   ```typescript
   // Before:
   const clientsBySession: Record<string, OpenLClient> = {};
   const sseTransports: Record<string, SSEServerTransport> = {};
   const streamableHttpTransports: Record<string, StreamableHTTPServerTransport> = {};

   // After:
   const clientsBySession = new SessionStore<OpenLClient>({ ttlMs: 30 * 60 * 1000 });
   const sseTransports = new SessionStore<SSEServerTransport>({
     ttlMs: 30 * 60 * 1000,
     onExpire: (id, transport) => transport.close?.()
   });
   const streamableHttpTransports = new SessionStore<StreamableHTTPServerTransport>({
     ttlMs: 30 * 60 * 1000,
     onExpire: (id, transport) => transport.close?.()
   });
   ```

3. Start a `setInterval` for periodic cleanup (every 5 minutes).

4. Refresh `lastActivity` on every request via `store.get(sessionId)`.

5. On server shutdown (`process.on('SIGTERM')`) — stop the interval and clean up all sessions.

6. Add a maximum session limit (e.g., 100) — reject new sessions when the limit is exceeded.

7. Write unit tests for `SessionStore`: TTL expiration, cleanup, onExpire callback, max limit.

**Done criteria:** Server running for weeks in Docker does not accumulate dead sessions.

---

## Plan 2. TTL/LRU for testExecutionHeaders and repositoriesCache Invalidation [CRITICAL]

**Problem:** In `client.ts`, two storage structures grow without bounds:
- `testExecutionHeaders` (line 38) — Map entries are added (line 1254) but only removed by explicit `clearTestHeaders()` call (line 1275), which may never be called.
- `repositoriesCache` (line 36) — repository cache is only invalidated on repository creation (line 225). If repositories change by other means, data becomes stale.

**Affected files:**
- `src/client.ts`

**Implementation steps:**

### testExecutionHeaders:
1. Add TTL to each Map entry (wrapper with timestamp).
2. In `getTestHeaders()`, check TTL — if expired, delete and return `undefined`.
3. Add a maximum Map size (e.g., 50 entries). On overflow, remove the oldest entry (LRU).
4. Add a `cleanupExpiredHeaders()` method, called periodically or on every `set`.

### repositoriesCache:
1. Add `cacheTimestamp` and `cacheTtlMs` (e.g., 5 minutes).
2. In `listRepositories()`, check: if `Date.now() - cacheTimestamp > cacheTtlMs` — refetch.
3. Add an `invalidateCache()` method for forced invalidation.
4. Invalidate cache on any mutations (create, delete, rename repository).

**Done criteria:** Caches do not grow indefinitely and do not contain stale data.

---

## Plan 3. Mutex for getClientForSession [LOW]

**Problem:** Today, `getClientForSession()` in `server.ts` (line 103) is fully synchronous and runs to completion without `await`, so Node's event loop will not interleave two calls mid-function and duplicate clients for the same `sessionId` cannot be created within a single process. However, if `getClientForSession()` is later refactored to perform async work (e.g., network I/O, disk access) or is invoked across multiple workers/processes, two concurrent calls with the same `sessionId` could race, creating multiple clients and causing one to be dropped or leaked. We should future-proof this by explicitly deduplicating in-flight client creation.

**Affected files:**
- `src/server.ts`

**Implementation steps:**

1. Add a `Map<string, Promise<OpenLClient>>` for in-flight client creation:
   ```typescript
   const clientCreationInFlight = new Map<string, Promise<OpenLClient>>();
   ```

2. In `getClientForSession()`:
   - If client already exists — return it.
   - If there's an in-flight Promise for this sessionId — await it.
   - Otherwise — create a Promise, store it in the Map, remove from Map on completion.

3. Write a test: two concurrent `getClientForSession()` calls with the same sessionId must return the same client.

**Done criteria:** Concurrent requests do not create duplicate clients.

---

## Plan 4. File Download Size Validation [HIGH]

**Problem:** In `client.ts`, `downloadFile()` reads the entire response into an in-memory `ArrayBuffer` (`responseType: "arraybuffer"` → `Buffer.from(...)`) without any size validation. A multi-gigabyte file will cause OOM since the full content is buffered in memory.

**Affected files:**
- `src/client.ts` — `downloadFile()` method
- `src/constants.ts` — limit constant

**Implementation steps:**

1. Add a `MAX_DOWNLOAD_SIZE` constant to `constants.ts` (e.g., 100 MB).
2. Before downloading, make a HEAD request to get `Content-Length`.
3. If size exceeds the limit — return an error with a clear message.
4. Switch from `responseType: "arraybuffer"` to `responseType: "stream"` and track received bytes during download, aborting if limit is exceeded.
5. Write streamed content to a temp file instead of buffering in memory.
6. Add tests: normal file passes, oversized file is rejected.

**Done criteria:** File downloads cannot cause OOM.

---

## Plan 5. Split tool-handlers.ts into Modules [HIGH]

**Problem:** `tool-handlers.ts` contains 2,306 lines — all 34+ handlers in a single file. Hard to navigate, test, and review.

**Affected files:**
- `src/tool-handlers.ts` — to be split
- New files in `src/handlers/`

**Implementation steps:**

1. Create `src/handlers/` directory with modules by category:
   ```
   src/handlers/
   ├── index.ts              — re-exports and registerAllTools()
   ├── repository-handlers.ts — list_repositories, list_branches, get_features, etc.
   ├── project-handlers.ts    — list/get/open/save/close projects, etc.
   ├── table-handlers.ts      — list/get/update/append/create tables
   ├── testing-handlers.ts    — start_test, get_test_results, execute_rule
   ├── deployment-handlers.ts — list/deploy/redeploy
   ├── history-handlers.ts    — project_history, file_history, revert
   └── trace-handlers.ts      — trace tools (beta)
   ```

2. Extract shared helpers (registry pattern, error handling) into `src/handlers/common.ts`.

3. Each module exports a `registerXxxHandlers(registry)` function.

4. `src/handlers/index.ts` calls all `register*` functions.

5. Update imports in `index.ts` and `server.ts`.

6. Ensure all existing tests pass without changes.

**Done criteria:** Each handler file < 400 lines, all tests pass.

---

## Plan 6. Replace `any` with Strict Types [MEDIUM]

**Problem:** 33 usages of `: any` across 5 files (formatters.ts — 15, client.ts — 7, mcp-proxy.ts — 6, types.ts — 4, tool-handlers.ts — 1). Plus 9 `eslint-disable no-explicit-any` comments. Reduces type safety.

**Affected files:**
- `src/formatters.ts` — highest count (15)
- `src/client.ts` — 7
- `src/mcp-proxy.ts` — 6
- `src/types.ts` — 4
- `src/tool-handlers.ts` — 1

**Implementation steps:**

1. **Phase 1 — formatters.ts** (highest impact):
   - Replace `any[]` in `formatRepositories`, `formatProjects`, `formatTables`, `formatDeployments`, `formatHistory` with concrete types from `types.ts` (`Repository[]`, `ProjectViewModel[]`, etc.).
   - Replace `formatGeneric(data: any)` with `formatGeneric(data: unknown)` using type guards.

2. **Phase 2 — client.ts:**
   - Type axios responses via generics: `axios.get<Repository[]>(...)`.
   - Replace `any` in catch blocks with `unknown` and type checks.

3. **Phase 3 — mcp-proxy.ts:**
   - Type API responses from proxy endpoints.

4. **Phase 4 — types.ts:**
   - Replace remaining `any` with `unknown` or concrete types.

5. Change ESLint rule `no-explicit-any` from `warn` to `error` after completion.

**Done criteria:** Zero `any` usages, ESLint rule set to `error`.

---

## Plan 7. Rate Limiting for HTTP Server [MEDIUM]

**Problem:** The HTTP server (`server.ts`) does not limit request rates. A single client can overload both the MCP server and the downstream OpenL Studio API.

**Affected files:**
- `src/server.ts`
- `package.json` — new dependency

**Implementation steps:**

1. Add `express-rate-limit` dependency.

2. Configure a global rate limiter:
   ```typescript
   import rateLimit from 'express-rate-limit';

   const limiter = rateLimit({
     windowMs: 1 * 60 * 1000, // 1 minute
     max: 100,                 // max requests per window
     standardHeaders: true,
     legacyHeaders: false,
     message: { error: 'Too many requests, please try again later' }
   });

   app.use(limiter);
   ```

3. For heavy endpoints (execute_rule, deploy) — add a separate stricter limiter.

4. Make parameters configurable via environment variables (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`).

5. Add tests: requests within the limit pass, excess requests receive 429.

**Done criteria:** Server is protected from overload, limits are configurable.

---

## Plan 8. In-Memory Prompt Caching [MEDIUM]

**Problem:** In `prompts-registry.ts`, prompt files (15 total) are read from disk on every `loadPromptContent()` call. Unnecessary I/O overhead.

**Affected files:**
- `src/prompts-registry.ts`

**Implementation steps:**

1. Add a `Map<string, string>` for caching prompt content.

2. On first `loadPromptContent(name)` call — read the file and store in the Map.

3. On subsequent calls — return from the Map.

4. Optional: add a `PROMPTS_CACHE=false` environment variable to disable caching in dev mode (for hot-reloading prompts).

5. Add a `clearPromptCache()` method for tests.

**Done criteria:** Each prompt is read from disk at most once.

---

## Plan 9. Extract Shared Code from index.ts and server.ts [MEDIUM]

**Problem:** `index.ts` and `server.ts` contain duplicated logic: MCP server initialization, tool registration, resource handling, and prompt handlers. Changes must be made in both files.

**Affected files:**
- `src/index.ts`
- `src/server.ts`
- New file `src/mcp-setup.ts`

**Implementation steps:**

1. Create `src/mcp-setup.ts` with a shared function:
   ```typescript
   export function setupMCPHandlers(server: Server, client: OpenLClient): void {
     // Register tool handlers
     // Register resource handlers
     // Register prompt handlers
   }
   ```

2. Extract shared functions:
   - `loadConfigFromEnv()` — load configuration from environment
   - `setupToolHandlers()` — register tools
   - `setupResourceHandlers()` — register resources
   - `setupPromptHandlers()` — register prompts

3. In `index.ts` and `server.ts`, call `setupMCPHandlers()`.

4. Ensure all tests pass.

**Done criteria:** Shared logic lives in one place, changes are made once.

---

## Plan 10. Structured Logging and Correlation IDs [LOW]

**Problem:** Logging via `console.error()` without structure. No correlation ID — impossible to trace request chains. Difficult to debug issues in production.

**Affected files:**
- `src/logger.ts` — primary changes
- All files with `console.error()` — migration

**Implementation steps:**

1. Extend `logger.ts`:
   - JSON format for production (`NODE_ENV=production`), human-readable for dev.
   - Fields: `timestamp`, `level`, `message`, `correlationId`, `sessionId`, `context`.

2. Add middleware in `server.ts` for `correlationId` generation using `res.locals` (type-safe without module augmentation):
   ```typescript
   app.use((req, res, next) => {
     res.locals.correlationId = req.headers['x-correlation-id'] || randomUUID();
     next();
   });
   ```
   Alternative: use `AsyncLocalStorage` for propagation through nested calls without passing context explicitly.

3. Pass `correlationId` through context to client and tool-handlers.

4. Replace all `console.error()` calls with `logger.info()`, `logger.error()`, etc.

5. Add basic metrics: request count, latency, error rate (via middleware).

**Done criteria:** All logs are structured, every request is traceable by correlationId.

---

## Plan 11. Remove Dead `tools.ts` and Sync Descriptions to `tool-handlers.ts` [MEDIUM]

**Problem:** `src/tools.ts` defines tool metadata (names, descriptions, schemas) but is **not imported anywhere** — it's dead code. Meanwhile, `tool-handlers.ts` is the actual tool registry used at runtime. The two files have diverged: 8 out of 25 shared tools have different descriptions, with `tools.ts` containing more detailed versions (local repo limitations, required fields, usage guidance). This causes confusion and risks stale documentation.

**Affected files:**
- `src/tools.ts` — to be deleted
- `src/tool-handlers.ts` — descriptions to be enriched
- `src/schemas.ts` — update header comment (currently says "Reference it in tools.ts")
- `AGENTS.md` — update code structure (lists `tools.ts`)
- `docs/development/contributing.md` — update code structure and "Add Metadata in tools.ts" section
- `docs/development/code-standards.md` — update file references and "add new tool" instructions
- `.specify/memory/` — update or remove stale references

**Implementation steps:**

1. Compare descriptions for all 8 diverged tools and merge useful details from `tools.ts` into `tool-handlers.ts`:
   - `openl_get_project` — add note about `repository: 'local'` support
   - `openl_open_project` — add branch/revision parameter guidance and local repo limitation
   - `openl_save_project` — add "(sends status CLOSED)" detail for closeAfterSave
   - `openl_close_project` — add "Does not work for repository 'local'" note
   - `openl_update_table` — add required fields list and in-memory modification note
   - `openl_list_deployments` — add usage guidance sentence
   - `openl_deploy_project` — add return value and validation requirement notes
   - `openl_create_project_branch` — add usage guidance sentence

2. Delete `src/tools.ts`.

3. Update all references to `tools.ts` in documentation and comments:
   - `src/schemas.ts` line 15: change "Reference it in tools.ts" → "Register it in tool-handlers.ts"
   - `AGENTS.md`: remove `tools.ts` from code structure tree
   - `docs/development/contributing.md`: replace "Add Metadata in tools.ts" with "Register in tool-handlers.ts"
   - `docs/development/code-standards.md`: update file list and "add new tool" instructions
   - `.specify/memory/`: update stale references (implementation-plan.md, constitution.md, task-list.md)

4. Verify build passes (`npm run build`).

**Done criteria:** Single source of truth for tool definitions, no dead code, no stale references to `tools.ts`, enriched descriptions in `tool-handlers.ts`.

---

## Plan 12. Version-Aware Tool Availability [HIGH]

**Problem:** OpenL Studio evolves across versions — newer API endpoints (e.g., trace API) don't exist in older Studio releases. Currently all tools are always exposed regardless of the connected Studio version. Calling an unsupported tool results in a confusing HTTP error. Users should see a clear message about which tools require a Studio upgrade.

**Backend support:** OpenL Studio exposes version info at `GET /public/info/openl.json`, returning `openl.version` (e.g., `6.1.0`), `openl.build.date`, `openl.build.number`.

**Affected files:**
- `src/client.ts` — new method to fetch Studio version
- `src/tool-handlers.ts` — add `minStudioVersion` to ToolDefinition, filter logic
- `src/constants.ts` — version constants
- `src/index.ts`, `src/server.ts` — pass version to tool listing

**Implementation steps:**

1. Add `getStudioVersion()` method to `OpenLClient`:
   ```typescript
   async getStudioVersion(): Promise<{ version: string; buildDate?: string }> {
     const response = await this.axiosInstance.get('/public/info/openl.json');
     return { version: response.data['openl.version'], buildDate: response.data['openl.build.date'] };
   }
   ```

2. Extend `ToolDefinition` with optional `minStudioVersion`:
   ```typescript
   interface ToolDefinition {
     // ... existing fields ...
     minStudioVersion?: string;  // e.g., "6.1.0" — minimum OpenL Studio version required
   }
   ```

3. Tag tools that require specific Studio versions:
   ```typescript
   registerTool({
     name: "openl_start_trace",
     minStudioVersion: "6.1.0",
     // ...
   });
   ```

4. Fetch Studio version once on first tool call (lazy init, cached):
   ```typescript
   private studioVersion: string | null = null;

   async getStudioVersionCached(): Promise<string | null> {
     if (this.studioVersion === null) {
       try {
         const info = await this.getStudioVersion();
         this.studioVersion = info.version;
       } catch { this.studioVersion = 'unknown'; }
     }
     return this.studioVersion;
   }
   ```

5. Modify `getAllTools()` to accept the detected version and annotate unavailable tools:
   - **Option A (recommended):** Include all tools but append a notice to the description of unavailable ones: `"⚠️ Requires OpenL Studio ≥6.1.0. Current: 6.0.2. Please upgrade."` — this way the LLM knows the tool exists and can inform the user.
   - **Option B:** Exclude unavailable tools from `tools/list` entirely — simpler but the user won't know what they're missing.

6. In tool handler execution, check version before calling the backend:
   ```typescript
   if (tool.minStudioVersion && !isVersionSatisfied(studioVersion, tool.minStudioVersion)) {
     return {
       content: [{ type: "text", text:
         `This tool requires OpenL Studio ≥${tool.minStudioVersion}. ` +
         `Connected Studio version: ${studioVersion}. Please upgrade OpenL Studio.`
       }],
       isError: true,
     };
   }
   ```

7. Add a semver comparison utility (lightweight, no dependency):
   ```typescript
   function isVersionSatisfied(current: string, required: string): boolean {
     const parse = (v: string) => v.replace(/-.*/, '').split('.').map(Number);
     const [c, r] = [parse(current), parse(required)];
     for (let i = 0; i < 3; i++) {
       if ((c[i] ?? 0) > (r[i] ?? 0)) return true;
       if ((c[i] ?? 0) < (r[i] ?? 0)) return false;
     }
     return true;
   }
   ```

8. Log Studio version at startup for diagnostics.

**Done criteria:** Tools tagged with `minStudioVersion` show a clear upgrade message when connected Studio is too old. Available tools work as before.

---

## Summary Table

| # | Plan | Priority | Complexity | Files |
|---|------|----------|------------|-------|
| 1 | TTL session cleanup | Critical | Medium | server.ts, new session-store.ts |
| 2 | TTL/LRU for client caches | Critical | Low | client.ts |
| 3 | Mutex for getClientForSession | Low | Low | server.ts |
| 4 | File download size validation | High | Low | client.ts, constants.ts |
| 5 | Split tool-handlers | High | High | tool-handlers.ts, new handlers/ dir |
| 6 | Replace `any` with types | Medium | Medium | formatters.ts, client.ts, mcp-proxy.ts, types.ts |
| 7 | Rate limiting | Medium | Low | server.ts, package.json |
| 8 | Prompt caching | Medium | Low | prompts-registry.ts |
| 9 | Extract shared code | Medium | Medium | index.ts, server.ts, new mcp-setup.ts |
| 10 | Structured logging | Low | High | logger.ts, all files |
| 11 | Remove dead tools.ts, sync descriptions | Medium | Low | tools.ts (delete), tool-handlers.ts |
| 12 | Version-aware tool availability | High | Medium | client.ts, tool-handlers.ts, constants.ts, index.ts, server.ts |

**Recommended order:** 1 → 2 → 12 → 4 → 9 → 5 → 11 → 8 → 7 → 6 → 3 → 10
