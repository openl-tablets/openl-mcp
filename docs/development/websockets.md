# 🔌 WebSockets (STOMP): Why and How the MCP Server Uses Them

OpenL Studio performs project compilation **asynchronously**: it runs in the background
after an edit, and the REST API only exposes snapshots of that work — `GET /status`
returns whatever the compile state is *right now*.

That model is fine for a human in a browser, but it breaks LLM agents: **an agent cannot
sleep between tool calls**. Every immediate retry of a "not ready yet" response burns one
of its limited reasoning steps, and a cold project compile takes tens of seconds — enough
to exhaust an agent's entire step budget on polling (see EPBDS-16089).

The studio publishes the *transitions* of that asynchronous work over a STOMP WebSocket.
The MCP server subscribes to the compile-status topic so that **the waiting happens inside
a single tool call**: the agent calls a tool once and gets the final result, while the
server blocks on a real completion event instead of polling.

> [!Note]
> The interactive trace debugger (`openl_trace_*`) does **not** use WebSockets. Its only
> asynchronous command, `openl_resume_trace`, waits inside the tool call by polling the
> lightweight `GET /trace/status` endpoint (the poll also serves as the session
> keepalive), and every other trace command is synchronous.

## What uses WebSockets

| Feature | Trigger | Topic |
|---|---|---|
| `openl_project_status` with `wait: true` | blocks until `compileState` is terminal (`ok`/`warnings`/`errors`), emitting MCP progress notifications per compiled module | project status topic |

Everything else in the server is plain REST. WebSockets are used **only to wait for
asynchronous studio work** — never to transfer the actual data (results are always
fetched over REST after the completion event).

## Topic

The topic is published per user via Spring's `convertAndSendToUser`
(`ProjectSocketNotificationService` in the studio), so subscriptions use the `/user`
prefix and path segments are URL-encoded:

| Topic | Payload |
|---|---|
| `/user/topic/projects/{projectId}/status`<br>`/user/topic/projects/{projectId}/branches/{branch}/status` (branch repos) | `ProjectStatusViewModel` JSON — `compileState` (`idle`/`compiling`/`ok`/`warnings`/`errors`), compilation messages/modules/tests counters, pending changes |

One property of the topic shapes the implementation:

- **Transitions only, no replay.** A subscriber receives nothing about events that fired
  before it subscribed. The server therefore always re-checks over REST immediately
  *after* subscribing — this closes the race where the work completed between the
  initial snapshot and the SUBSCRIBE frame.

## Connection and authentication

- **Endpoint:** the WebSocket URL is derived from the configured base URL —
  `http(s)://host/rest` → `ws(s)://host/rest/ws`. The `/rest/ws` path (rather than the
  studio UI's `/web/ws`) deliberately routes the handshake through the REST security
  filter chain, so the authenticated principal propagates to the WS session — required
  for `/user/topic/...` subscriptions to be authorized in multi-user mode.
- **Credentials ride on the HTTP upgrade request, not on STOMP frames:**
  - `Cookie: JSESSIONID=...` — the studio session. This matters beyond auth: the
    compile registry is **session-scoped**, so the WS subscription must join the same
    session the REST calls created.
  - `Authorization: Basic ...` / `Token openl_pat_...` — without it the WS session is
    anonymous and the studio rejects subscriptions to user-routed destinations (the
    server logs a warning and the wait can only end by timeout).
- **Lifecycle:** one subscription per tool call, torn down when the call returns.

## Behavior when the WebSocket is unavailable

| Scenario | Compile wait (`openl_project_status wait:true`) |
|---|---|
| Studio issued no session cookie | falls back to the latest REST snapshot |
| No `Authorization` header | warning logged; wait likely ends by timeout |
| Timeout (`timeoutMs`, default 120 s) | returns the last-seen status (no error) |

## Source map

| Module | Responsibility |
|---|---|
| [`src/stomp-client.ts`](../../src/stomp-client.ts) | the only place that opens WebSockets: URL derivation, auth headers, connect/error/abort lifecycle; `subscribeProjectStatus` (status JSON) + the destination builder |
| [`src/stomp-waits.ts`](../../src/stomp-waits.ts) | the wait orchestration. `waitForCompilation`: REST seed → subscribe → race-close re-fetch → terminal frame / timeout / abort, on top of `awaitTerminal` (bounded, abortable, self-cleaning wait for one out-of-band value) |

The wait exposes an injectable subscriber (`subscribeImpl` parameter) as a test
seam — unit tests drive the orchestration with fake STOMP frames and never touch the
network (`tests/stomp-waits.compilation.test.ts`).

## Debugging

Set `DEBUG_STOMP=true` to log the WebSocket URL construction, CONNECT/SUBSCRIBE frames,
every inbound frame, and disconnect causes to stderr. Errors are always
logged regardless of the flag.
