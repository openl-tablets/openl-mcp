# MCP Specification Alignment

How the current MCP specification revision, `2026-07-28`, affects this server,
what has already landed, and what is left.

Normative sources — cite these, not the draft:

- [the `2026-07-28` specification](https://modelcontextprotocol.io/specification/2026-07-28)
  and its [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Security Best Practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)
  for the authorization rules P2.1 has to satisfy
- [Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)
  for the `ttlMs`/`cacheScope` obligation in P1.3

Historical context only: the
[release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and
the [release-candidate announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).

**Status.** The `2026-07-28` specification is published, the TypeScript SDK
shipped v2 support, and this server **already negotiates and serves it** —
`EPBDS-16385` upgraded the SDK, made the modern HTTP path stateless, and kept
legacy 2025 clients on their sessionful transport. The protocol switch that the
first version of this plan treated as its long pole is done.

What remains is one conformance gap (`ttlMs`/`cacheScope`, [P1.3](#p13-emit-ttlmscachescope-on-list-results-sep-2549)),
the trace-affinity consequence of statelessness ([P1.2](#p12-trace-session-affinity-under-statelessness)),
and the authorization direction ([P2.1](#p21-standard-mcp-oauth-for-the-http-transport)) — which
the `OPENL_MCP_PRESERVE_AUTH_SCHEME` passthrough now makes concrete rather than
speculative. Item IDs are kept stable across revisions of this document because
the code references them (see `src/http-server.ts`, the passthrough rationale).

Nothing breaks for existing clients: legacy 2025 stays served, and every
deprecation in the new revision carries a minimum twelve-month window.

---

## Where this server stands today

Verified against `main` (`@modelcontextprotocol/node` and
`@modelcontextprotocol/server` 2.0.0):

- **Protocol:** modern `2026-07-28` **and** legacy 2025, both transports. Stdio
  negotiates once per connection and pins one server/client pair
  (`src/stdio-server.ts`). HTTP routes per request: `isLegacyRequest` sends
  sessionful clients to `NodeStreamableHTTPServerTransport`, everything else to
  `createMcpHandler` with `legacy: "reject"` (`src/http-server.ts`).
  Negotiation is covered in `tests/http-server.test.ts`.
- **Modern HTTP is stateless by construction:** credentials are read from
  **every** request and a **fresh** `OpenLClient` is built for it. That is a
  deliberate isolation decision, not a placeholder — see
  [P1.1](#p11-stateless-http-landed--and-why-not-a-client-pool).
- **Legacy HTTP keeps sessions:** one `Mcp-Session-Id` → one transport → one
  `OpenLClient` with its own Studio cookie jar, including anonymous sessions.
  `legacyTransports` is written only from `onsessioninitialized`, and an unknown
  session id answers `404` so a compliant client re-initializes.
- **Capabilities:** `tools` and `prompts` only (`src/mcp-core.ts`). Resources
  were removed entirely; roots, sampling and MCP logging were never adopted —
  diagnostics go to `stderr`, which is what the new spec suggests. We emit no
  `listChanged` and no unsolicited notifications of any kind.
- **`tools/list` is deterministic** (fixed registration order) and static per
  build, optionally narrowed by the `OPENL_MCP_TOOLS` allow-list — so the list
  varies per **deployment**, never per caller. Input schemas are plain JSON
  Schema objects; the only 2020-12 keywords in use are `contentEncoding` /
  `contentMediaType` on base64 `blob` parameters.
- **Long-running work** (`openl_project_status` `wait: true`, trace
  resume/step) blocks inside the tool call and emits `notifications/progress`
  on the request's own response stream — which the new revision explicitly
  preserves.
- **CORS/preflight:** a hand-rolled `mcpCorsMiddleware` with an exact-origin
  allowlist and an explicit request-header allowlist that already includes
  `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version`.
- **Error codes:** the MCP-custom `-32002` is not emitted anywhere; the
  transport-level `-32000` responses sit in the range the new error-code policy
  grandfathers as implementation-defined.
- **Authentication is explicit-token-only by default.**
  `OPENL_PERSONAL_ACCESS_TOKEN` / `--token`, or anonymous (single-user Studio).
  The browser sign-in flow and the credential cache were **removed** (CHANGELOG,
  Unreleased → Removed), so this server holds no OAuth client and mints nothing.
  It does, however, take the **caller's** credential per request on the HTTP
  transport, and `OPENL_MCP_PRESERVE_AUTH_SCHEME` (off by default) forwards an
  inbound `Bearer` to Studio as received — the documented exception, and the
  subject of [P2.1](#p21-standard-mcp-oauth-for-the-http-transport).

## What does NOT affect us

Recorded so future readers don't re-derive it:

| Change | Why it's a no-op here |
|---|---|
| Roots / Sampling / Logging deprecated | Never adopted; logging already on `stderr` |
| HTTP+SSE transport reclassified Deprecated | Removed in 1.1.0 |
| `-32002` → `-32602` resource error | No resources, code never emitted |
| SSE resumability / `Last-Event-ID` removed | Never used |
| `includeContext` sampling values deprecated | No sampling |
| Deterministic `tools/list` ordering (SHOULD) | Already deterministic |
| `subscriptions/listen` for unsolicited notifications | We emit none; opt-in, so not implemented |
| `server/discover` (server MUST) | Provided by the SDK's serving entry; we register nothing |
| Required `Mcp-Method` / `Mcp-Name` headers | Validated by the SDK (presence and header/body consistency) before dispatch; nothing to add |
| JSON Schema 2020-12 `$ref`/composition bounds | Schemas are flat; nothing to bound |

## Closed without implementing

- **P0.1 — validate `iss` in the login callback (SEP-2468).** Dropped as filed:
  the `openl-mcp login` OAuth flow it hardened was removed together with the
  credential cache, so there is no client-side authorization response left to
  validate. The requirement did not disappear — it moved to the resource-server
  side and is folded into
  [P2.1](#p21-standard-mcp-oauth-for-the-http-transport) (`iss` / `aud` / `exp`
  against the IdP's JWKS).
- **P0.2 — record the issuer with the cached credential (SEP-2352).** Dropped as
  filed: no credential cache exists. If
  [P2.1](#p21-standard-mcp-oauth-for-the-http-transport) or
  [P2.3](#p23-silent-credential-renewal-sep-2207) ever reintroduces a store for
  AS-issued credentials, SEP-2352 applies then — keyed by issuer, never replayed
  against another.
- **P0.3 — state the protocol revision in the docs.** Done:
  `docs/guides/advanced.md` says that `--http` serves both `2026-07-28` and
  legacy 2025, and cross-links this document.

---

## Remaining work

### P1.3 Emit `ttlMs`/`cacheScope` on list results (SEP-2549)

**Open — the only known conformance gap, and the cheapest item here.** The
revision *requires* caching hints on every `resultType: "complete"` list
result, and we serve the revision today; the handlers in `src/mcp-core.ts`
return neither field.

- Both lists are static per build, so a generous `ttlMs` (order of an hour) and
  `cacheScope: "private"` (responses ride authenticated requests) fit.
- The obligation also covers **`server/discover`**, which the SDK generates
  rather than us. Verify whether the SDK already emits the hints there; if it
  does not, the gap is not closable from `mcp-core.ts` alone and belongs
  upstream.
- `OPENL_MCP_TOOLS` narrows the list per deployment, not per caller, so it stays
  cacheable. **Keeping shaping deployment-only is our decision, not a protocol
  constraint:** the revision removes connection-scoped variation, but
  `cacheScope: "private"` explicitly allows a result to vary by authorization
  context ("MUST NOT be shared across authorization contexts"). We prefer one
  list per deployment because it keeps the list auditable and cacheable at the
  gateway. Per-deployment shaping — including
  [improvement-plans F6](improvement-plans.md) (version-aware tool
  availability) — fits that choice; pick the TTL with F6 in mind.

### P1.1 Stateless HTTP: landed — and why *not* a client pool

**Landed** (`EPBDS-16385`). Recorded here because the earlier plan proposed the
opposite design and the rejection is load-bearing.

The modern path builds a fresh `OpenLClient` per request. The alternative — a
pool keyed by a credential fingerprint, to preserve Studio-session affinity —
was rejected:

- **Anonymous deployments have no fingerprint.** Single-user Studio is a
  first-class mode; with no credential, every caller collapses into one pool
  entry. That is exactly the cross-caller leak `EPBDS-16385` fixed when it gave
  each anonymous legacy session its own client.
- **A shared PAT is not a shared workspace.** Studio allows one debug session
  per user, and `openl_start_trace` terminates the previous one. Pooling by
  token turns an isolated failure into two agents silently killing each other's
  trace.

Consequence: per-request isolation stays, and affinity is solved upstream —
[P1.2](#p12-trace-session-affinity-under-statelessness).

Legacy-path session debt is tracked in `improvement-plans.md`, not here:
**B6** (TTL and a session cap — the leak-on-failed-initialize half is fixed) and
**B7** (session auth fixed at `initialize`; its case-insensitive-scheme and
`404`-on-unknown-session halves are already done). Both apply only while the
legacy path exists.

### P1.2 Trace-session affinity under statelessness

**Open, external half.** The trace, test-result and merge-conflict flows keep
state in Studio's HTTP session, carried by the `JSESSIONID` cookie on one
`OpenLClient`. Statelessly there is no such continuity — and across replicas
there never can be, since consecutive requests may land on instances holding
different Studio cookies.

- **Short term (in place):** `docs/guides/advanced.md` tells users to run these
  workflows over stdio or a legacy 2025 connection, where one Studio session
  stays pinned. This is a documented limitation, not a silent failure.
- **Target:** server-minted **handles passed as ordinary tool arguments** —
  the specification's own recommendation. `openl_start_trace` returns a
  `traceSessionId` the other trace tools accept, and Studio resolves it
  regardless of which HTTP session carries the call. This needs a studio-side
  API and runs on that team's timeline; filing and tracking that request is the
  actionable half on our side.
- Do **not** close the gap with a client pool — see
  [P1.1](#p11-stateless-http-landed--and-why-not-a-client-pool).

### P1.4 Schema opportunities, not obligations

**Open, low priority.** `inputSchema` may now use any JSON Schema 2020-12
keywords. Candidates where we flatten unions today — `openl_start_trace`'s
`testRanges` | `inputJson` alternatives, the row/column `cells` shapes — could
become explicit `oneOf`. Flat hand-rolled schemas were a deliberate
compatibility choice; adopt only once the major clients demonstrably accept
composed schemas, per client, with an explicit go/no-go.

### P2.1 Standard MCP OAuth for the HTTP transport

**Open, largest remaining item — and no longer hypothetical.**
`OPENL_MCP_PRESERVE_AUTH_SCHEME` (off by default) forwards an inbound `Bearer`
credential to Studio unexamined so that an OAuth-capable client can reach Studio
through this server at all. That is token passthrough, which the specification
forbids ("MCP servers MUST NOT accept any tokens that were not explicitly issued
for the MCP server"). The flag is deliberately opt-in and logs itself precisely
because this item is what retires it.

- Return `401` with `WWW-Authenticate` and serve RFC 9728
  `/.well-known/oauth-protected-resource` pointing at the deployment's IdP.
- Accept `Bearer <IdP access token>` and validate `iss` / `aud` / `exp` against
  the IdP's JWKS — this is where the former P0.1 requirement now lives. The
  explicit-PAT path stays for CI and non-OAuth deployments.
- **Open design decision — how the upstream call is authenticated.** Validating
  the inbound token and then forwarding *that same token* to Studio is not a
  fix: the specification's passthrough rule has two halves, accepting a token
  not issued for this server **and** forwarding an unmodified token downstream
  (the confused-deputy case). Validating `aud` closes only the first. Three
  candidates, to be decided before implementation:
  - a **separate upstream credential** the deployment gives this server (a
    service-account PAT), so the inbound token authenticates the caller and
    never leaves;
  - **token exchange** (RFC 8693) at the IdP: trade the inbound token for one
    whose audience is Studio;
  - declare Studio and this server **one resource** with a shared audience,
    which makes the forward legitimate by definition — cheapest, but it has to
    be an explicit, written decision with the IdP configured to match, not an
    accident of deployment.
- `OPENL_MCP_PRESERVE_AUTH_SCHEME` is retired only once that decision lands and
  is implemented; until then it stays opt-in and self-announcing. Validation
  alone does **not** make it redundant.
- Testing needs an IdP: add Keycloak to `compose.yaml` (absent today) for
  authorization integration tests.
- Result: OAuth-capable clients (claude.ai connectors among them) connect with
  no manual token plumbing.

### P2.2 Be CIMD-ready, don't invest in DCR

**Open, docs-only by design.** The revision deprecates Dynamic Client
Registration in favour of
[Client ID Metadata Documents](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#client-id-metadata-documents).
Build nothing that assumes DCR; for P2.1, document how a deployment registers
its OAuth client in its IdP today, and track Keycloak's CIMD support.

### P2.3 Silent credential renewal (SEP-2207)

**Open, but currently moot.** With authentication explicit-token-only, an
expiring PAT is the user's to rotate and there is nothing on disk to refresh.
Revisit only if P2.1 introduces a server-side credential store, or if browser
sign-in returns: then `offline_access` plus a refresh token cached **per issuer**
(SEP-2352) is the shape, weighed against keeping a long-lived refresh token on
disk — opt-in if adopted at all.

### P3.1 Tasks extension (`io.modelcontextprotocol/tasks`)

**Open, opportunistic.** Long-running work — test runs, deployments, compile
waits — maps onto the redesigned Tasks extension (poll `tasks/get`, no
unsolicited streams, handles returned without per-request opt-in). Our test
tools already use a start-then-fetch handle shape, so the mapping is natural,
and it composes with [P1.2](#p12-trace-session-affinity-under-statelessness):
both replace connection state with handles. Adopt when the SDK and at least one
major client support it; the STOMP-backed blocking `wait` stays as the portable
fallback.

### P3.2 MCP Apps extension

**Open, exploratory.** Server-rendered HTML in sandboxed iframes. Natural fits:
an Excel-like grid view (colours/merges from `openl_get_table` `styles=true`), a
trace-stack visualizer. Revisit once the extension stabilizes and flagship
clients render it.

---

## Schedule

Ordered steps with gates, not calendar dates: each step starts when the previous
one lands or its external gate opens.

| Step | Work | Gate |
|---|---|---|
| 1 | **P1.3**: `ttlMs`/`cacheScope` on both list results, with tests. Closes the conformance gap on a revision we already serve. | — |
| 2 | **P1.2**, our half: file and track the studio-side request for token-addressable debug sessions; verify the documented stdio/legacy guidance against a real modern-HTTP client. | — |
| 3 | **P2.1 design**: authorization flow, resource metadata, and the JWKS validation boundary; add Keycloak to `compose.yaml` with authorization integration tests. | — (parallel to 1–2) |
| 4 | **P2.1 implementation**: `401` + `WWW-Authenticate`, `/.well-known/oauth-protected-resource`, JWKS bearer validation. PAT path preserved; `OPENL_MCP_PRESERVE_AUTH_SCHEME` deprecated. | Step 3 |
| 5 | **P2.2** CIMD-readiness docs; **P1.4** schema audit with per-client go/no-go criteria. | — |
| 6 | **P1.2** handle-based trace API on our side. | Studio ships token-addressable debug sessions |
| 7 | **P3** spikes: Tasks design + prototype if implementable in the SDK (P3.1); timeboxed MCP Apps spike (P3.2). Docs sweep, release prep. | Everything above |

**Committed to the original September 2026 target:** steps 1–3 — all
SDK-independent, none blocked externally. Steps 4–7 depend on an IdP test
harness, the studio team, and client adoption respectively, and are explicitly
post-target; if the target must cover step 4, that is a scoping decision to take
deliberately rather than by omission.

### Risks and fallbacks

- **The SDK gate is closed for core `2026-07-28` conformance** — the long pole
  of the previous revision of this plan (a TypeScript SDK shipping
  `2026-07-28`) resolved with v2, and the protocol switch already landed. The
  extensions remain SDK-gated: P3.1 waits on Tasks support, and P1.3's
  `server/discover` half may too.
- **Statelessness versus session-bound Studio flows** is the live architectural
  tension. The mitigation is documentation plus handles, never a shared client
  pool ([P1.1](#p11-stateless-http-landed--and-why-not-a-client-pool)).
- **Studio-side token-addressable debug sessions** run on the studio team's
  timeline. Until then the documented stdio/legacy path is the answer.
- **Client adoption can't be forced** (P1.4 composed schemas, P3 extensions).
  The deliverable for these is the audit/design/spike plus explicit flip
  criteria — not defaults that flagship clients would reject.
- **Keycloak CIMD support** is external; P2.2 stays docs-only.

## Summary

| # | Item | Step | Priority | Effort | Status |
|---|------|------|----------|--------|--------|
| P0.1 | `iss` validation in the login callback | — | — | — | Dropped (feature removed; folded into P2.1) |
| P0.2 | Issuer recorded with the cached credential | — | — | — | Dropped (no credential cache) |
| P0.3 | Protocol revision stated in the docs | — | Low | Low | ✅ Done |
| P1.1 | Stateless modern HTTP, per-request client | — | High | High | ✅ Done (`EPBDS-16385`); pool design rejected |
| P1.2 | Trace-session affinity via handles | 2, 6 | High | Medium | Documented limitation; API request open |
| P1.3 | `ttlMs`/`cacheScope` on list results | 1 | **High** | Low | Open — conformance gap |
| P1.4 | JSON Schema 2020-12 audit | 5 | Low | Low | Open |
| P2.1 | Standard OAuth on the HTTP transport | 3, 4 | High | High | Open — upstream-credential decision first |
| P2.2 | CIMD-ready client registration story | 5 | Medium | Low | Open (docs-only) |
| P2.3 | Silent credential renewal | — | Low | Medium | Moot while auth is token-only |
| P3.1 | Tasks extension design + spike | 7 | Medium | Medium | Open |
| P3.2 | MCP Apps timeboxed spike | 7 | Low | High | Open |
