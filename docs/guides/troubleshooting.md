# 🔍 Troubleshooting Guide

Common issues and fixes for the OpenL MCP Server.

## Table of Contents

- [See the server's logs](#see-the-servers-logs)
- [Quick checks](#quick-checks)
- [Common issues](#common-issues)
- [Docker / compose](#docker--compose)
- [Connecting to a remote OpenL Studio](#connecting-to-a-remote-openl-studio)
- [WebSocket wait issues (compile / trace status)](#websocket-wait-issues-compile--trace-status)

---

## See the server's logs

All MCP server logs go to **stderr**, so they never corrupt the JSON-RPC stream on stdout.

**Run it directly in a terminal** — the fastest way to see everything. Run the same
command your client runs:

```bash
# Auth is optional — set it only if your Studio requires it
export OPENL_PERSONAL_ACCESS_TOKEN="openl_pat_your-token"
npx -y openl-mcp-server http://localhost:8080
```

Press `Ctrl+C` to stop. For more detail set `DEBUG=1` (also `DEBUG_AUTH=true` for auth —
see [Debug PAT](debug-pat.md) — and `DEBUG_STOMP=true` for the WebSocket wait).

**Client log files:**

| Client | Where |
|--------|-------|
| Claude Code | `claude mcp list` shows status; start `claude --debug` for details |
| Claude Desktop | `~/Library/Logs/Claude/*.log` (macOS) |
| Cursor | `~/Library/Logs/Cursor/*.log` (macOS) |
| VS Code | Output panel → "GitHub Copilot Chat" / MCP server output |

Filter by log prefix — `[Config]`, `[Auth]`, `[Error]`:

```bash
tail -f ~/Library/Logs/Claude/*.log | grep -E "\[Error\]|\[Auth\]|\[Config\]"
```

## Quick checks

```bash
# 1. The package runs (downloads + prints the tool catalog)
npx -y openl-mcp-server --help

# 2. OpenL Studio is reachable
curl http://localhost:8080

# 3. The server connects to it — watch the startup logs
npx -y openl-mcp-server http://localhost:8080
```

A healthy start logs:

```
[Config] Resolving configuration (positional <url> / flags / environment)...
[Config] Authentication:
[Config]   - Personal Access Token: configured (hidden)
```

## Common issues

### Client doesn't list the server / "not connected"

1. Validate the config JSON — no trailing commas, right file
   (see the [Connection Guide](../setup/mcp-connection-guide.md)).
2. Confirm the package name is `openl-mcp-server` and the URL is correct.
3. Using `npx`? Make sure Node.js is installed (`node -v`) — or switch to the
   [Docker option](../setup/mcp-connection-guide.md#running-without-nodejs-docker).
4. Fully restart the client after editing the config.

### "Cannot connect to OpenL API"

1. `curl http://localhost:8080` — is Studio up?
2. Check the base URL (positional argument or `OPENL_BASE_URL`).
3. If the server runs in Docker, use `host.docker.internal`, not `localhost`.

### "Authentication failed" / 401

1. The token is correct, not expired, not revoked.
2. It starts with `openl_pat_`.
3. The user has the needed permissions, and Studio runs in OAuth2/SAML mode (PATs
   require it). See [Debug PAT](debug-pat.md).

### Tools don't appear in chat

1. The client shows the server **connected** in its MCP panel.
2. (VS Code / Copilot) enable the OpenL tools in the Agent tools picker.
3. Ask explicitly: "Use the OpenL tools to list repositories."

## Docker / compose

### Containers don't start

```bash
docker ps                       # is Docker running?
lsof -i :8080; lsof -i :3000    # ports free?
docker compose logs             # what failed?
```

### Port already in use

Change the published port in [`compose.yaml`](../../compose.yaml):

```yaml
ports:
  - "3001:3000"   # host:container
```

### Container can't reach OpenL Studio

Use `host.docker.internal` instead of `localhost`. On Linux, add
`--add-host=host.docker.internal:host-gateway` (or `extra_hosts` in compose).

## Connecting to a remote OpenL Studio

You don't need a remote MCP server. Run the MCP server **locally** (via `npx` or
Docker) and point it at the remote OpenL backend — stdio avoids the network and proxy
issues of a remote transport:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp-server", "https://openl.example.com"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>" }
    }
  }
}
```

If requests time out: check connectivity (`curl https://openl.example.com`), verify the
token, and raise `OPENL_TIMEOUT` (milliseconds) if the backend is slow.

## WebSocket wait issues (compile / trace status)

Some tools wait for the studio's asynchronous work over a STOMP WebSocket instead of polling: `openl_project_status` with `wait: true`, the `openl://status/...` resource, and `openl_get_trace_nodes` / `openl_export_trace` while a trace is running. See [WebSockets (STOMP)](../development/websockets.md) for how this works.

**`wait: true` returns before compilation finished, or trace wait errors with "session cookie"**
- The WebSocket must join the **same studio session** as the REST calls (compile/trace registries are session-scoped). The session cookie is issued by the studio on the first REST call; if the studio issues no session, the compile wait falls back to a snapshot and the trace wait reports that the websocket is unavailable.
- In CLI mode each invocation is a new process/session — pass `--cookie-jar <path>` to share the session between `openl_start_trace` and the subsequent read, and pass `tableId` to the read tool.

**Wait hangs until timeout, nothing arrives**
- The WS upgrade must carry an `Authorization` header (PAT). Anonymous WebSocket sessions cannot subscribe to user-routed topics in multi-user mode — the server logs a warning when this happens. Provide credentials.
- Verify the studio is reachable at `<base-url>/ws` (e.g. `http://<host>:8080/rest/ws`) — proxies must allow WebSocket upgrade on that path.

**Diagnosing**
- Set `DEBUG_STOMP=true` to log the WebSocket URL, CONNECT/SUBSCRIBE frames, and every inbound frame to stderr.

## Related Documentation

- [MCP Connection Guide](../setup/mcp-connection-guide.md) — per-client setup
- [Authentication Guide](authentication.md) — Personal Access Tokens
- [Debug PAT](debug-pat.md) — detailed auth logging
- [Quick Start Guide](../getting-started/quick-start.md)
