# OpenL MCP Server Improvement Plans

Deep codebase analysis results. Plans are grouped by priority.

---

## Plan 1. TTL-based Cleanup for Sessions and Transport Maps [CRITICAL]

**Problem:** In `http-server.ts`, `streamableHttpTransports` (and the associated `clientsBySession` entries) are cleaned up via `transport.onclose`. If that close callback doesn't fire (e.g., network drop, client process kill, or abrupt server termination), entries can remain indefinitely. During long-running Docker deployments, this leads to memory leaks.

**Affected files:**
- `src/http-server.ts` — primary changes
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

2. In `http-server.ts`, replace plain objects with `SessionStore`:
   ```typescript
   // Before:
   const clientsBySession: Record<string, OpenLClient> = {};
   const streamableHttpTransports: Record<string, StreamableHTTPServerTransport> = {};

   // After:
   const clientsBySession = new SessionStore<OpenLClient>({ ttlMs: 30 * 60 * 1000 });
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

**Problem:** Today, `getClientForSession()` in `http-server.ts` (line 89) is fully synchronous and runs to completion without `await`, so Node's event loop will not interleave two calls mid-function and duplicate clients for the same `sessionId` cannot be created within a single process. However, if `getClientForSession()` is later refactored to perform async work (e.g., network I/O, disk access) or is invoked across multiple workers/processes, two concurrent calls with the same `sessionId` could race, creating multiple clients and causing one to be dropped or leaked. We should future-proof this by explicitly deduplicating in-flight client creation.

**Affected files:**
- `src/http-server.ts`

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

## Plan 5. Split tool-handlers.ts into Modules [HIGH] — ✅ DONE

**Outcome:** The 3,744-line `tool-handlers.ts` was split into per-category modules under `src/handlers/`. The registry core (`registerTool` / `getAllTools` / `executeTool`) and the shared error handling now live in `src/handlers/common.ts`; the generic `isNotFoundError` / `isPlainObject` guards moved to `utils.ts`. Each category exposes a `registerXxxHandlers()` function and owns its own private helpers and module-level state (the trace active-table registry, the table-id alias registry, the structured-payload argument validation). `src/handlers/index.ts` is the sole registry entry point — it defines `registerAllTools()` (which calls every `register*`) and re-exports `getAllTools` / `executeTool`. `tool-handlers.ts` is gone.

Two design refinements landed with the move: the central name-keyed `TOOL_VALIDATION` map was replaced by an optional `validateArgs` callback carried on each tool (so validation travels with the tool), and `registerAllTools()` lost its unused server/client parameters — registration needs neither, since tools receive their client at call time via `executeTool` (this also removed a throwaway `Server` and two stub clients from the CLI).

Modules (with the registry core): `common.ts`, `repository-handlers.ts`, `project-handlers.ts`, `local-change-handlers.ts`, `testing-handlers.ts`, `file-handlers.ts`, `table-handlers.ts`, `trace-handlers.ts`, `deployment-handlers.ts`. The largest three (table, project, file) exceed the original <400-line target — that's verbose per-tool description text, not logic, and the categories were kept cohesive rather than split mid-category.

---

## Plan 6. Replace `any` with Strict Types [MEDIUM]

**Problem:** 33 usages of `: any` across 5 files (formatters.ts — 15, client.ts — 7, mcp-proxy.ts — 6, types.ts — 4, `handlers/` — 1). Plus 9 `eslint-disable no-explicit-any` comments. Reduces type safety.

**Affected files:**
- `src/formatters.ts` — highest count (15)
- `src/client.ts` — 7
- `src/mcp-proxy.ts` — 6
- `src/types.ts` — 4
- `src/handlers/` — 1

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

**Problem:** The HTTP server (`http-server.ts`) does not limit request rates. A single client can overload both the MCP server and the downstream OpenL Studio API.

**Affected files:**
- `src/http-server.ts`
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

3. For heavy endpoints (deploy, start tests) — add a separate stricter limiter.

4. Make parameters configurable via environment variables (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`).

5. Add tests: requests within the limit pass, excess requests receive 429.

**Done criteria:** Server is protected from overload, limits are configurable.

---

## Plan 8. In-Memory Prompt Caching [MEDIUM] — ✅ DONE

**Outcome:** Prompt bodies are now cached in memory, so each prompt file is read from disk exactly once. `loadPromptDefinitions()` already reads every prompt file at startup to build the registry; that same read now fills `promptBodyCache` (the frontmatter-stripped body, keyed by prompt name). `loadPromptContent()` serves the body from that cache and reads no files — argument substitution still runs on every call.

---

## Plan 9. Extract Shared Code from index.ts and http-server.ts [MEDIUM] — ✅ DONE

**Outcome:** The duplicated MCP wiring was extracted into `src/mcp-core.ts`. `createConfiguredServer(client)` builds a fully-configured `Server` — capabilities declared, tools registered, and every request handler wired via `registerMcpHandlers()` — and returns it together with its `ResourceSubscriptionManager`. Both entry points now build their server from it: `index.ts` attaches a stdio transport, and `http-server.ts` attaches a Streamable HTTP transport per session, so the MCP surface (tools, resources, prompts, completion, subscriptions) is defined once and the two transports can't drift. (The shared module landed as `mcp-core.ts` rather than the originally-proposed `mcp-setup.ts`; the transport-specific launch code — including `loadConfigFromEnv()` — lives in `stdio-server.ts` and `http-server.ts`, with `index.ts` reduced to a dispatcher.)

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

2. Add middleware in `http-server.ts` for `correlationId` generation using `res.locals` (type-safe without module augmentation):
   ```typescript
   app.use((req, res, next) => {
     res.locals.correlationId = req.headers['x-correlation-id'] || randomUUID();
     next();
   });
   ```
   Alternative: use `AsyncLocalStorage` for propagation through nested calls without passing context explicitly.

3. Pass `correlationId` through context to client and the tool handlers.

4. Replace all `console.error()` calls with `logger.info()`, `logger.error()`, etc.

5. Add basic metrics: request count, latency, error rate (via middleware).

**Done criteria:** All logs are structured, every request is traceable by correlationId.

---

## Plan 11. Remove Dead `tools.ts` and Sync Descriptions to `tool-handlers.ts` [MEDIUM] — ✅ DONE

**Outcome:** The dead `src/tools.ts` file (with its `TOOLS` registry and `TOOL_CATEGORIES` constant) has been deleted. `tool-handlers.ts` is now the single source of truth for tool definitions, and the useful description details that previously lived only in `tools.ts` were merged into it. Stale references to `tools.ts` in `schemas.ts`, `AGENTS.md`, and the development docs were updated to point at `tool-handlers.ts`.

---

## Plan 12. Version-Aware Tool Availability [HIGH]

**Problem:** OpenL Studio evolves across versions — newer API endpoints (e.g., trace API) don't exist in older Studio releases. Currently all tools are always exposed regardless of the connected Studio version. Calling an unsupported tool results in a confusing HTTP error. Users should see a clear message about which tools require a Studio upgrade.

**Backend support:** OpenL Studio exposes version info at `GET /public/info/openl.json`, returning `openl.version` (e.g., `6.1.0`), `openl.build.date`, `openl.build.number`.

**Affected files:**
- `src/client.ts` — new method to fetch Studio version
- `src/handlers/common.ts` — add `minStudioVersion` to ToolDefinition, filter logic
- `src/constants.ts` — version constants
- `src/mcp-core.ts` — pass version to the shared `tools/list` handler

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

| # | Plan | Priority | Complexity | Files | Status |
|---|------|----------|------------|-------|--------|
| 1 | TTL session cleanup | Critical | Medium | http-server.ts, new session-store.ts | Planned |
| 2 | TTL/LRU for client caches | Critical | Low | client.ts | Planned |
| 3 | Mutex for getClientForSession | Low | Low | http-server.ts | Planned |
| 4 | File download size validation | High | Low | client.ts, constants.ts | Planned |
| 5 | Split tool-handlers | High | High | handlers/ (split by category) | ✅ Done |
| 6 | Replace `any` with types | Medium | Medium | formatters.ts, client.ts, mcp-proxy.ts, types.ts | Planned |
| 7 | Rate limiting | Medium | Low | http-server.ts, package.json | Planned |
| 8 | Prompt caching | Medium | Low | prompts-registry.ts | ✅ Done |
| 9 | Extract shared code | Medium | Medium | mcp-core.ts | ✅ Done |
| 10 | Structured logging | Low | High | logger.ts, all files | Planned |
| 11 | Remove dead tools.ts, sync descriptions | Medium | Low | tools.ts (deleted), tool-handlers.ts | ✅ Done |
| 12 | Version-aware tool availability | High | Medium | client.ts, handlers/common.ts, constants.ts, mcp-core.ts | Planned |

**Recommended order:** 1 → 2 → 12 → 4 → 7 → 6 → 3 → 10  (Plans 5, 8, 9, and 11 already complete)
