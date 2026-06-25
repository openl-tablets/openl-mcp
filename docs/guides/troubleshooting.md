# Troubleshooting

Common problems and how to fix them.

## See the server's logs

All MCP server logs go to **stderr**, so they never corrupt the JSON-RPC stream on stdout.

**Run it directly in a terminal** — the fastest way to see everything. Run the same command your client runs:

```bash
# Auth is optional — set it only if your Studio requires it
export OPENL_PERSONAL_ACCESS_TOKEN="openl_pat_your-token"
npx -y openl-mcp http://localhost:8080
```

Press `Ctrl+C` to stop. For more detail set `DEBUG=1` (or `DEBUG_AUTH=true` for auth, `DEBUG_STOMP=true` for the
WebSocket wait).

**Client log files:**

| Client         | Where                                                              |
|----------------|--------------------------------------------------------------------|
| Claude Code    | `claude mcp list` shows status; start `claude --debug` for details |
| Claude Desktop | `~/Library/Logs/Claude/*.log` (macOS)                              |
| Cursor         | `~/Library/Logs/Cursor/*.log` (macOS)                              |
| VS Code        | Output panel → "GitHub Copilot Chat" / MCP server output           |

Filter by log prefix — `[Config]`, `[Auth]`, `[Error]`:

```bash
tail -f ~/Library/Logs/Claude/*.log | grep -E "\[Error\]|\[Auth\]|\[Config\]"
```

## Quick checks

```bash
# 1. The package runs (downloads + prints the tool catalog)
npx -y openl-mcp --help

# 2. OpenL Studio is reachable
curl http://localhost:8080

# 3. The server connects to it — watch the startup logs
npx -y openl-mcp http://localhost:8080
```

A healthy start logs:

```
[Config] Resolving configuration (positional <url> / flags / environment)...
[Config] Authentication:
[Config]   - Personal Access Token: configured (hidden)
```

## Common issues

### Client doesn't list the server / "not connected"

1. Validate the config JSON — no trailing commas, right file (see the [Quick Start](quick-start.md)).
2. Confirm the package name is `openl-mcp` and the URL is correct.
3. Using `npx`? Make sure Node.js is installed (`node -v`) — or switch to the
   [Docker option](advanced.md#run-with-docker).
4. Fully restart the client after editing the config.

### "Cannot connect to OpenL API"

1. `curl http://localhost:8080` — is Studio up?
2. Check the base URL (positional argument or `OPENL_BASE_URL`).
3. If the server runs in Docker, use `host.docker.internal`, not `localhost`.

### "Authentication failed" / 401

1. The token is correct, not expired, not revoked.
2. It starts with `openl_pat_`.
3. The user has the needed permissions, and Studio runs in OAuth2/SAML/AD mode (PATs require it).

Set `DEBUG_AUTH=true` to log the failing request URL and the API error code.

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

Use `host.docker.internal` instead of `localhost`. On Linux, add `--add-host=host.docker.internal:host-gateway`
(or `extra_hosts` in compose).

## Connecting to a remote OpenL Studio

You don't need a remote MCP server. Run the MCP server **locally** (via `npx` or Docker) and point it at the remote
OpenL backend — stdio avoids the network and proxy issues of a remote transport:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "https://openl.example.com"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>" }
    }
  }
}
```

If requests time out: check connectivity (`curl https://openl.example.com`), verify the token, and raise
`OPENL_TIMEOUT` (milliseconds) if the backend is slow.
