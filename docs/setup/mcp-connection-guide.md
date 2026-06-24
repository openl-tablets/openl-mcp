# MCP Server Connection Guide

Connect your AI client to the OpenL MCP server. The server is the npm package
[`openl-mcp`](https://www.npmjs.com/package/openl-mcp); your client
launches it on demand over stdio — nothing to install or build first.

There are two ways to launch it:

- **With Node.js** — `npx -y openl-mcp <openl-studio-url>`
- **Without Node.js** — run that same command inside the official Node image:
  `docker run --rm -i node:lts-alpine npx -y openl-mcp <openl-studio-url>`

Pick one and drop it into your client's config below.

## Do I need Node.js?

| Client | Node.js | Notes |
|--------|---------|-------|
| **Claude Code** | ✅ Built in | Claude Code itself runs on Node, so `npx` works out of the box. |
| **Claude Desktop** | Install it, or use Docker | The desktop app does not provide a `node` for MCP servers. |
| **Cursor** | Install it, or use Docker | |
| **VS Code (GitHub Copilot)** | Install it, or use Docker | VS Code bundles Node for itself, but `npx` is resolved from your PATH. |

Get Node.js (LTS, version 24+) from [nodejs.org](https://nodejs.org/). Prefer not
to install it? Use the [Docker option](#running-without-nodejs-docker) in any
client below — it needs only Docker.

## Create a Personal Access Token (PAT)

> Skip this if your OpenL Studio runs in single-user mode (e.g. the
> [compose demo](docker.md)) — it accepts unauthenticated requests.

1. Sign in to OpenL Studio.
2. Profile icon → **User Settings** → **Personal Access Tokens** → **Create Token**.
3. Name it (e.g. `Cursor MCP`), optionally set an expiry.
4. **Copy it now** — it is shown only once. Format: `openl_pat_<publicId>.<secret>`.

The token goes in the `env` block of each config below as
`OPENL_PERSONAL_ACCESS_TOKEN`. Never commit it.

## Claude Code

```bash
# With a token:
claude mcp add openl --env OPENL_PERSONAL_ACCESS_TOKEN=<your-token> \
  -- npx -y openl-mcp http://localhost:8080

# Single-user OpenL Studio (no token):
claude mcp add openl -- npx -y openl-mcp http://localhost:8080
```

Run `claude mcp list` to confirm `openl` shows as connected.

## Claude Desktop

Edit `claude_desktop_config.json`:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

Drop the `env` block for single-user mode. Quit and reopen Claude Desktop to apply.

## Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

Restart Cursor. **Settings → MCP** should show `openl` connected.

## VS Code (GitHub Copilot)

Requires GitHub Copilot with Agent mode. Create `.vscode/mcp.json` in your
workspace (or run **MCP: Open User Configuration** for a global one):

```json
{
  "servers": {
    "openl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

> A workspace `.vscode/mcp.json` is committed with your repo — keep the token out
> of it. Use VS Code [input variables](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
> or the user-level config for secrets.

Open the Copilot Chat **Agent** tools picker and enable the OpenL tools.

## Running without Node.js (Docker)

No Node.js on the machine? Run the package inside the official Node image: the
container starts, runs `npx`, speaks stdio to your client, and is removed on exit.
In **any** config above, replace the `command`/`args` with:

```json
"command": "docker",
"args": [
  "run", "--rm", "-i",
  "-e", "OPENL_PERSONAL_ACCESS_TOKEN",
  "node:lts-alpine",
  "npx", "-y", "openl-mcp", "http://host.docker.internal:8080"
]
```

Two differences from the npx form:

- **Use `host.docker.internal`, not `localhost`**, to reach an OpenL Studio on the
  host machine. On Linux, also add `"--add-host", "host.docker.internal:host-gateway"`
  to the args.
- For single-user mode, drop the `"-e", "OPENL_PERSONAL_ACCESS_TOKEN"` entries
  (and the `env` block). Otherwise keep both — `-e` forwards the token into the
  container.

For Claude Code: `claude mcp add openl -- docker run --rm -i node:lts-alpine npx -y openl-mcp http://host.docker.internal:8080`.

## Verify the connection

1. Your client's MCP panel lists **openl** as connected.
2. In chat, ask: `List repositories in OpenL Studio`.
3. The client calls an OpenL tool and returns the list.

Not connecting? See [Troubleshooting](../guides/troubleshooting.md).

## Connect to a shared HTTP server (optional)

Each config above launches its own stdio server — ideal for one user. To run a
single long-lived server that several clients share, start it in HTTP mode
(`--http`) and point clients at its `/mcp` URL. See [Docker Setup](docker.md) for
the compose stack and the standalone `docker run … --http` command.

## Additional Resources

- [Quick Start](../getting-started/quick-start.md) — get running in a few minutes
- [Docker Setup](docker.md) — run via Docker (no Node.js) and the compose demo
- [Authentication Guide](../guides/authentication.md) — Personal Access Tokens
- [Troubleshooting Guide](../guides/troubleshooting.md) — common issues
- [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) — official VS Code MCP reference
