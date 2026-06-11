# 🔌 WebSockets (STOMP): Why and How the MCP Server Uses Them

OpenL Studio performs its heavy work **asynchronously**: project compilation runs in the
background after an edit, and a trace execution is queued and runs after `POST /trace`
returns `202 Accepted`. The REST API only exposes snapshots of that work — `GET /status`
returns whatever the compile state is *right now*, and trace reads return `409 Conflict`
for as long as the trace is still running.

That model is fine for a human in a browser, but it breaks LLM agents: **an agent cannot
sleep between tool calls**. Every immediate retry of a "not ready yet" response burns one
of its limited reasoning steps, and a cold project compile takes tens of seconds — enough
to exhaust an agent's entire step budget on polling (see EPBDS-16089).

The studio publishes the *transitions* of that asynchronous work over a STOMP WebSocket.
The MCP server subscribes to those topics so that **the waiting happens inside a single
tool call**: the agent calls a tool once and gets the final result, while the server
blocks on a real completion event instead of polling.

## What uses WebSockets

| Feature | Trigger | Topic |
|---|---|---|
| `openl_project_status` with `wait: true` | blocks until `compileState` is terminal (`ok`/`warnings`/`errors`), emitting MCP progress notifications per compiled module | project status topic |
| `openl://status/{projectId}` MCP resource subscriptions | pushes `notifications/resources/updated` to subscribed MCP clients on every status change (long-lived subscription with reconnect) | project status topic |
| `openl_get_trace_nodes` / `openl_export_trace` (default `wait: true`) | on `409 Conflict` (trace still running) waits for the trace's terminal event, then reads the result | trace status topic |

Everything else in the server is plain REST. WebSockets are used **only to wait for
asynchronous studio work** — never to transfer the actual data (results are always
fetched over REST after the completion event).

## Topics

Both topics are published per user via Spring's `convertAndSendToUser`
(`ProjectSocketNotificationService` in the studio), so subscriptions use the `/user`
prefix and path segments are URL-encoded:

| Topic | Payload |
|---|---|
| `/user/topic/projects/{projectId}/status`<br>`/user/topic/projects/{projectId}/branches/{branch}/status` (branch repos) | `ProjectStatusViewModel` JSON — `compileState` (`idle`/`compiling`/`ok`/`warnings`/`errors`), compilation messages/modules/tests counters, pending changes |
| `/user/topic/projects/{projectId}/tables/{tableId}/trace/status` | plain `ExecutionStatus` name (`PENDING`, `STARTED`, `COMPLETED`, `INTERRUPTED`) or `{"status":"ERROR","message":"..."}` JSON on failure |

Two properties of these topics shape the implementation:

- **Transitions only, no replay.** A subscriber receives nothing about events that fired
  before it subscribed. The server therefore always re-checks over REST immediately
  *after* subscribing — this closes the race where the work completed between the
  initial snapshot/409 and the SUBSCRIBE frame.
- **The trace topic is per-table**, while the trace *read* endpoints only take a
  `projectId`. `openl_start_trace` records which table the trace was started for; a
  caller in a different process (e.g. a separate CLI invocation) passes the optional
  `tableId` argument to the read tools instead.

## Connection and authentication

- **Endpoint:** the WebSocket URL is derived from the configured base URL —
  `http(s)://host/rest` → `ws(s)://host/rest/ws`. The `/rest/ws` path (rather than the
  studio UI's `/web/ws`) deliberately routes the handshake through the REST security
  filter chain, so the authenticated principal propagates to the WS session — required
  for `/user/topic/...` subscriptions to be authorized in multi-user mode.
- **Credentials ride on the HTTP upgrade request, not on STOMP frames:**
  - `Cookie: JSESSIONID=...` — the studio session. This matters beyond auth: the
    compile registry and the trace result registry are **session-scoped**, so the WS
    subscription must join the same session the REST calls created.
  - `Authorization: Basic ...` / `Token openl_pat_...` — without it the WS session is
    anonymous and the studio rejects subscriptions to user-routed destinations (the
    server logs a warning and the wait can only end by timeout).
- **Lifecycle:** one subscription per tool call, torn down when the call returns. Only
  the `openl://status/...` resource holds a long-lived subscription (with reconnect and
  automatic re-SUBSCRIBE).

## Behavior when the WebSocket is unavailable

| Scenario | Compile wait (`openl_project_status wait:true`) | Trace wait (`openl_get_trace_nodes`/`openl_export_trace`) |
|---|---|---|
| Studio issued no session cookie | falls back to the latest REST snapshot | error explaining the websocket wait is unavailable (the trace registry is session-scoped, so a foreign session could never see the result anyway) |
| No `Authorization` header | warning logged; wait likely ends by timeout | same |
| Timeout (`timeoutMs` / `waitTimeoutMs`, default 120 s, cap 600 s) | returns the last-seen status (no error) | error stating the trace is still running server-side, with recovery options (`waitTimeoutMs`, `openl_cancel_trace`) |
| Studio reports trace `ERROR` | n/a | error with the studio's failure message |

## CLI mode notes

Each CLI invocation is a separate process and, by default, a separate studio session.
For the trace flow (`openl_start_trace` → `openl_get_trace_nodes`) across separate runs:

- pass `--cookie-jar <path>` so both calls share the JSESSIONID (the trace result lives
  in that session), and
- pass `tableId` to the read call (the in-process "which table was traced" memory does
  not survive between CLI runs).

## Source map

| Module | Responsibility |
|---|---|
| [`src/stomp-client.ts`](../../src/stomp-client.ts) | the only place that opens WebSockets: URL derivation, auth headers, connect/error/abort lifecycle; generic `subscribeTopic` (raw frames) + `subscribeProjectStatus` (status JSON) + destination builders |
| [`src/wait-for-compilation.ts`](../../src/wait-for-compilation.ts) | compile wait orchestration: REST seed → subscribe → race-close re-fetch → terminal frame / timeout / abort |
| [`src/wait-for-trace.ts`](../../src/wait-for-trace.ts) | trace wait orchestration: optimistic read → on 409 subscribe → race-close re-read → terminal frame → final read |
| [`src/resource-subscriptions.ts`](../../src/resource-subscriptions.ts) | long-lived status subscriptions backing the `openl://status/...` MCP resource |

Both wait modules expose an injectable subscriber (`subscribeImpl` parameter) as a test
seam — unit tests drive the orchestration with fake STOMP frames and never touch the
network (`tests/wait-for-compilation.test.ts`, `tests/wait-for-trace.test.ts`).

## Debugging

Set `DEBUG_STOMP=true` to log the WebSocket URL construction, CONNECT/SUBSCRIBE frames,
every inbound frame, reconnects, and disconnect causes to stderr. Errors are always
logged regardless of the flag.
