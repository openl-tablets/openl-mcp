# Quick Start

Get an AI client talking to OpenL Studio in a few minutes. You need:

1. **An MCP client** — Claude Code, Claude Desktop, Cursor, or VS Code (GitHub Copilot)
2. **Access to OpenL Studio** — your own instance, or start one (Step 1 below)
3. **Node.js**, *or* Docker — `npx` runs the server if Node.js is installed
   ([nodejs.org](https://nodejs.org/), v24+); otherwise Docker runs it for you.
   Claude Code already has Node.js; the desktop/IDE clients need it installed or
   use the Docker option. See [Do I need Node.js?](../setup/mcp-connection-guide.md#do-i-need-nodejs)

---

## Step 1: Have OpenL Studio running

Already have one? Note its URL (e.g. `http://localhost:8080`) and skip ahead.

Otherwise start one in single-user mode (no login required):

```bash
docker run --rm -p 8080:8080 ghcr.io/openl-tablets/webstudio:x
```

Open `http://localhost:8080` to confirm it's up.

## Step 2: Connect your AI client

Your client launches the MCP server itself over stdio — point it at the Studio URL
from Step 1. Two examples; the [Connection Guide](../setup/mcp-connection-guide.md)
covers all four clients (and the Docker option if you don't have Node.js).

**Claude Code:**

```bash
claude mcp add openl -- npx -y openl-mcp http://localhost:8080
```

**Cursor** — add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"]
    }
  }
}
```

> Authenticating against a multi-user Studio? Add `OPENL_PERSONAL_ACCESS_TOKEN` —
> see [Create a PAT](../setup/mcp-connection-guide.md#create-a-personal-access-token-pat).

Restart the client (Claude Code picks it up immediately).

## Step 3: Try it

In your client's chat:

```
List repositories in OpenL Studio
```

The client should call an OpenL tool and show the repositories. 🎉

---

## Alternative: full-stack demo in one command

Want OpenL Studio **and** the MCP server with nothing installed but Docker? Grab
[`compose.yaml`](../../compose.yaml) and run:

```bash
docker compose up -d
```

This starts OpenL Studio (`http://localhost:8080`) and a shared MCP server in HTTP
mode (`http://localhost:3000/mcp`). Connect clients to that `/mcp` URL over HTTP —
see [Docker Setup](../setup/docker.md#standalone-http-server). Stop with
`docker compose down`.

---

## Troubleshooting

- **Client doesn't list `openl`** — check the JSON is valid (no trailing commas) and
  fully restart the client.
- **"Cannot connect to OpenL"** — confirm the URL: `curl http://localhost:8080`. From
  a Docker-launched server, use `host.docker.internal` instead of `localhost`.
- **401 Unauthorized** — the Studio needs a token; add `OPENL_PERSONAL_ACCESS_TOKEN`.

More: [Troubleshooting Guide](../guides/troubleshooting.md).

## Next Steps

- [MCP Connection Guide](../setup/mcp-connection-guide.md) — all four clients in detail
- [Docker Setup](../setup/docker.md) — run without Node.js, compose, shared HTTP server
- [Authentication Guide](../guides/authentication.md) — Personal Access Tokens
- [Usage Examples](../guides/examples.md) — what you can do with the tools
