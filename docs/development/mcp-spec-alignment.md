# MCP Specification Alignment Plan (2026-07-28)

How the upcoming MCP specification revision affects this server, and the phased
plan to align with it. Sources: the
[release-candidate announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
and the [draft changelog](https://modelcontextprotocol.io/specification/draft/changelog).

**Timeline:** the release candidate was locked on May 21, 2026; the final
specification publishes on **July 28, 2026**. Tier-1 SDKs (TypeScript included)
are expected to ship support within the ten-week validation window, i.e. around
the publication date. Nothing breaks on day one: the current `2025-11-25`
protocol keeps working, and every deprecation carries a minimum twelve-month
window. The plan below is about landing the changes deliberately, not urgently.

---

## Where this server stands today

Verified against the current codebase (`@modelcontextprotocol/sdk` ^1.29.0,
protocol `2025-11-25`):

- **Transports:** stdio (single session) and Streamable HTTP at `/mcp` with
  `Mcp-Session-Id` sessions (`src/http-server.ts`). The legacy HTTP+SSE
  transport was never provided.
- **Capabilities:** `tools` and `prompts` only. Resources were removed
  entirely; roots, sampling, and MCP logging were never adopted — diagnostics
  already go to `stderr`, which is exactly the migration the new spec suggests.
- **Sessions carry two things** on the HTTP transport: the per-session
  `OpenLClient` built from the `Authorization` header captured **at
  `initialize` time**, and — through that client's cookie (`JSESSIONID`) — the
  affinity that the trace/debug tools require.
- **Long-running work** (`openl_project_status` `wait: true`, trace
  resume/step) blocks inside the tool call and emits `notifications/progress`
  on the request's own response stream.
- **Error codes:** the MCP-custom `-32002` (resource not found) is not used
  anywhere; the transport-level `-32000` responses sit in the range the new
  error-code policy grandfathers as implementation-defined.
- **Tool list** is deterministic (fixed registration order) and static per
  build; input schemas are plain JSON Schema objects with no draft-specific
  keywords.

## What does NOT affect us

Recorded so future readers don't re-derive it:

| Change | Why it's a no-op here |
|---|---|
| Roots / Sampling / Logging deprecated | Never adopted; logging already on `stderr` |
| HTTP+SSE transport reclassified Deprecated | Never provided |
| `-32002` → `-32602` resource error | No resources, code never emitted |
| SSE resumability / `Last-Event-ID` removed | Never used |
| `includeContext` sampling values deprecated | No sampling |
| Deterministic `tools/list` ordering (SHOULD) | Already deterministic |
| JSON Schema 2020-12 `$ref`/composition bounds | Schemas are plain; nothing to bound |

---

## Phase 0 — Now (spec-independent hardening)

These follow the authorization-hardening SEPs and need no SDK upgrade.

### P0.1 Validate `iss` in the login callback (SEP-2468) [HIGH]

`openl-mcp login` (`src/login.ts`) runs an OAuth Authorization Code + PKCE flow
and validates `state`, but ignores the `iss` parameter of the authorization
response. RFC 9207 / SEP-2468 make validating a present `iss` a client MUST —
it defends exactly our shape (one CLI, many possible Studio deployments/IdPs)
against mix-up attacks. Keycloak sends `iss` on current versions.

- In the loopback callback, when `iss` is present, compare it (trailing-slash
  normalized) to the configured `--issuer` / `OPENL_OAUTH_ISSUER`; abort on
  mismatch. Absent `iss` stays accepted (older IdPs).
- Tests: mismatched `iss` aborts before the code exchange; matching and absent
  `iss` proceed.

### P0.2 Record the issuer with the cached credential (SEP-2352 spirit) [LOW]

The token cache (`src/token-cache.ts`) keys entries by Studio base URL. Store
the issuer that produced the PAT alongside it. The PAT itself is a resource
credential (not an AS credential), so this is provenance today — but it becomes
load-bearing the moment we cache anything issued by the IdP (see P2.3, refresh
tokens), which SEP-2352 requires to be keyed by issuer and never replayed
against a different one.

### P0.3 State the protocol version in docs [LOW]

Docs describe the HTTP transport as "MCP spec 2025-11-25" in passing. Make the
supported protocol revision explicit in `docs/guides/advanced.md` and this
document, so the Phase 1 upgrade is a visible, documented switch.

---

## Phase 1 — The stateless protocol core (on SDK support, ~Aug–Sep 2026)

Triggered by the TypeScript SDK shipping `2026-07-28` support (likely a major
version). Client adoption will lag, so the HTTP transport must serve **both**
protocols during the transition — sessionful `2025-11-25` clients and stateless
`2026-07-28` clients — for as long as the SDK's negotiation supports it.

### P1.1 Rebuild the HTTP transport around per-request auth [HIGH]

SEP-2567/2575 remove `initialize` and `Mcp-Session-Id`. Everything in
`src/http-server.ts` that pivots on sessions goes:

- No more "capture `Authorization` at initialize": extract credentials from
  **every** request and resolve the `OpenLClient` per request.
- Replace the session-keyed maps (`streamableHttpTransports`,
  `clientsBySession`) with a client pool keyed by **credential fingerprint**
  (hash of base URL + token), with TTL eviction and a size cap. This subsumes
  the session-TTL design of [improvement-plans Plan 1](improvement-plans.md)
  for the stateless path (Plan 1 still applies to the legacy-session path while
  it exists).
- `GET /mcp` (server SSE stream) and `DELETE /mcp` (session termination)
  disappear on the new path. The replacement, `subscriptions/listen`, is
  opt-in for unsolicited notifications — we emit none (no `listChanged`), so we
  do **not** implement it. Request-scoped `notifications/progress` explicitly
  survives on the request's own response stream, so the STOMP-wait pattern
  (`wait: true`) is unaffected.
- `server/discover` (now a server MUST) and the required
  `Mcp-Method`/`Mcp-Name` headers come with the SDK; our `cors()` default
  reflects requested headers, so preflight keeps working — verify in the
  integration tests.

### P1.2 Make trace-session affinity explicit [HIGH]

The trace tools ride on the per-client `JSESSIONID` cookie, which today lives
as long as the MCP session. Statelessly:

- Within one server process, the credential-keyed client pool (P1.1) preserves
  affinity naturally: same token → same `OpenLClient` → same Studio session.
  Document that trace requires the pool entry to outlive the debug session
  (TTL ≥ Studio's ~10-minute debug-session reaper).
- Across **replicas** there is no affinity to inherit — consecutive stateless
  requests may land on different instances holding different Studio cookies.
  Short term: document single-replica (or sticky-routing) as a requirement for
  the trace tools. Long term: ask OpenL Studio for token-addressable debug
  sessions — the spec's own recommendation is server-minted **handles passed
  as ordinary tool arguments**, i.e. `openl_start_trace` returns a
  `traceSessionId` the other trace tools accept, with the studio resolving it
  regardless of which HTTP session carries the call.

### P1.3 Emit `ttlMs`/`cacheScope` on list results (SEP-2549) [MEDIUM]

The new spec **requires** both fields on `tools/list` and `prompts/list`
results. Ours are static per build: a generous `ttlMs` (e.g. one hour) and
`cacheScope: "private"` (responses ride authenticated requests). Interaction
with [improvement-plans Plan 12](improvement-plans.md) (version-aware tool
descriptions): descriptions would then vary per connected Studio — still
deployment-stable, so cacheable, but pick the TTL with that in mind. Note the
new spec's premise that list endpoints no longer vary per connection — any
future per-caller tool shaping is off the table; per-deployment shaping is fine.

### P1.4 Schema opportunities, not obligations [LOW]

`inputSchema` may now use any JSON Schema 2020-12 keywords. Candidates where we
flatten unions today (e.g. `openl_start_trace`'s `testRanges` | `inputJson`
alternatives, row/column `cells` shapes) could become explicit `oneOf`. Only
adopt once the major clients demonstrably accept composed schemas — hand-rolled
flat schemas were a deliberate compatibility choice.

---

## Phase 2 — Authorization direction (H2 2026)

The hardening SEPs are mostly client obligations, but they signal where MCP
authorization is heading: HTTP servers are expected to speak the standard OAuth
resource-server dance, and static/manual token plumbing becomes the fallback.

### P2.1 Standard MCP OAuth for the HTTP transport [HIGH, larger effort]

Today the HTTP transport requires the client to be configured with an
`Authorization: Token|Bearer <PAT>` header — impossible for OAuth-only clients
(claude.ai connectors) and manual for the rest. The deployment already has
everything needed: `openl-mcp login` proves the IdP issues bearers that the
Studio REST API accepts in oauth2 mode (that is how the PAT is minted). Plan:

- Return `401` + `WWW-Authenticate` with resource metadata; serve RFC 9728
  `/.well-known/oauth-protected-resource` pointing at the deployment's IdP
  (the same issuer `login` uses).
- Accept `Bearer <IdP access token>`: validate `iss`/`aud`/`exp` against the
  IdP's JWKS, then pass it upstream (Studio already accepts it). The PAT header
  path stays for CI and non-OAuth deployments.
- Result: OAuth-capable MCP clients connect with zero manual token plumbing;
  the browser-login CLI remains for stdio.

### P2.2 Be CIMD-ready, don't invest in DCR [MEDIUM]

The draft **deprecates Dynamic Client Registration** in favor of
[Client ID Metadata Documents](https://modelcontextprotocol.io/specification/draft/basic/authorization/client-registration#client-id-metadata-documents).
Consequences: don't build anything that assumes DCR; for P2.1, document how a
deployment registers OAuth clients in its IdP today, and track
Keycloak's CIMD support. If the CLI ever needs registration beyond the fixed
`openl-cli` client, SEP-837 applies (`application_type: native`).

### P2.3 Silent PAT renewal via refresh tokens (SEP-2207) [MEDIUM]

The 90-day PAT expiry currently ends in a hard 401 and a manual re-login.
Optionally request `offline_access` during `login`, cache the refresh token
keyed by issuer (P0.2 makes that natural, per SEP-2352), and re-mint the PAT
when it nears expiry. Weigh the security trade-off: a long-lived refresh token
on disk vs. a shorter-lived PAT — consider making it opt-in.

---

## Phase 3 — Extensions (opportunistic; watch client adoption)

### P3.1 Tasks extension (`io.modelcontextprotocol/tasks`) [MEDIUM]

Long-running work — test runs, deployments, compile waits — maps onto the
redesigned Tasks extension (poll `tasks/get`, no unsolicited streams, handles
returned without per-request opt-in). Our test tools already use a
start-then-fetch handle shape, so the mapping is natural. Adopt when the SDK
and at least one major client support it; the STOMP-backed blocking `wait`
stays as the portable fallback.

### P3.2 MCP Apps extension [LOW, exploratory]

Server-rendered HTML in sandboxed iframes. Natural fits: an Excel-like table
grid view (colors/merges from `openl_get_table` `styles=true`), a trace-stack
visualizer. Revisit once the extension stabilizes and flagship clients render
it.

---

## Watch triggers

| Trigger | Unblocks |
|---|---|
| TS SDK release with `2026-07-28` support (expected ~end of July 2026) | Phase 1 |
| Major MCP clients (Claude Code/Desktop, Cursor, VS Code) speaking the stateless protocol | Retiring the legacy-session path |
| claude.ai / client demand for the HTTP transport | P2.1 priority |
| Keycloak CIMD support | P2.2 |
| Tasks extension shipping in SDK + a flagship client | P3.1 |

## Summary

| # | Plan | Phase | Priority | Effort |
|---|------|-------|----------|--------|
| P0.1 | `iss` validation in login | Now | High | Low |
| P0.2 | Issuer recorded in token cache | Now | Low | Low |
| P0.3 | Protocol version stated in docs | Now | Low | Low |
| P1.1 | Stateless HTTP, credential-keyed client pool | SDK | High | High |
| P1.2 | Explicit trace-session affinity / handles | SDK | High | Medium |
| P1.3 | `ttlMs`/`cacheScope` on list results | SDK | Medium | Low |
| P1.4 | JSON Schema 2020-12 adoption | SDK+clients | Low | Low |
| P2.1 | Standard OAuth on the HTTP transport | H2 2026 | High | High |
| P2.2 | CIMD-ready client registration story | H2 2026 | Medium | Low |
| P2.3 | Refresh-token PAT renewal | H2 2026 | Medium | Medium |
| P3.1 | Tasks extension for long-running work | Adoption | Medium | Medium |
| P3.2 | MCP Apps views | Adoption | Low | High |

**Recommended order:** P0.1 → P0.2 → P0.3 now; Phase 1 as one upgrade effort
when the SDK lands; P2.1 planned against client demand; the rest on their
triggers.
