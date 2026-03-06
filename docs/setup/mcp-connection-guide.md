# MCP Server Connection Guide

Step-by-step guide for connecting AI clients to the OpenL MCP server.

## Quick Jump

- [Prerequisites](#prerequisites)
- [Create a Personal Access Token](#create-a-personal-access-token-pat)
- [Cursor IDE](#cursor-ide)
- [Claude Desktop](#claude-desktop)
- [VS Code / GitHub Copilot](#vs-code--github-copilot)
- [Verify Connection](#verify-connection)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **[Node.js 24+](https://nodejs.org/)** — required for Claude Desktop (uses `mcp-remote` stdio proxy)
- **`mcp-remote`** — install with `npm install -g mcp-remote` (required for Claude Desktop)
- **AI Client** — [Cursor IDE](https://cursor.com), [Claude Desktop](https://claude.ai/download), or [VS Code](https://code.visualstudio.com/) with GitHub Copilot
- **MCP Server running** — see [Quick Start](../getting-started/quick-start.md) or [Docker Setup](docker.md)

Verify Node.js and mcp-remote paths (needed for Claude Desktop):
```bash
which node         # e.g., /Users/username/.nvm/versions/node/v24.0.0/bin/node
which mcp-remote   # e.g., /Users/username/.nvm/versions/node/v24.0.0/bin/mcp-remote
```

---

## Create a Personal Access Token (PAT)

> **Skip this step** if you use `compose.studio.yaml` (single-user mode — no authentication needed).

PAT is a secure way to authenticate without using a password.

1. Open OpenL Studio in your browser and sign in
2. Click the profile icon (top right) → **User Settings**
3. Go to **Personal Access Tokens** → **Create Token**
4. Enter a descriptive name (e.g., `Cursor MCP`, `Claude Desktop MCP`)
5. (Optional) Set expiration date (recommended: 90 days)
6. **Copy the token immediately** — it is shown only once!
   - Format: `openl_pat_<publicId>.<secret>`
   - Store in a password manager

**Security:**
- Don't commit tokens to Git
- Use different tokens for different environments
- Delete and rotate tokens regularly

---

## Cursor IDE

Cursor supports direct HTTP connection to MCP servers (no proxy needed).

### Remote MCP Server

**Via Cursor UI** (Settings → MCP Servers → Add):

```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "url": "https://<your-openl-server>/mcp/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Token <your-pat-token>"
      }
    }
  }
}
```

**Via configuration file:**

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Cursor/User/settings.json` |
| Windows | `%APPDATA%\Cursor\User\settings.json` |
| Linux | `~/.config/Cursor/User/settings.json` |

Add the `mcpServers` section to the file.

### Docker MCP Server

```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "url": "http://localhost:3000/mcp/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Token <your-pat-token>"
      }
    }
  }
}
```

For `compose.studio.yaml` (single-user mode), omit the `headers` section.

For remote Docker, use HTTPS to protect your token in transit (e.g., `https://<docker-host>/mcp/sse` with TLS termination via a reverse proxy). Only use plain `http://localhost` for true localhost connections on the same machine.

### Transport Options

Cursor supports two transports:
- `"transport": "sse"` — Server-Sent Events (GET requests), standard for most cases
- `"transport": "streamablehttp"` — Streamable HTTP (POST requests), useful for certain proxy/firewall configurations

After configuration, **restart Cursor** completely.

---

## Claude Desktop

Claude Desktop only supports stdio transport. Use `mcp-remote` as a proxy bridge to connect to HTTP-based MCP servers.

**Requirements:** [Node.js 24+](https://nodejs.org/) and `mcp-remote` (`npm install -g mcp-remote`).

### Configuration File Location

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Create the file if it doesn't exist.

### Remote MCP Server

```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "command": "<path-to-node>",
      "args": [
        "<path-to-mcp-remote>",
        "https://<your-openl-server>/mcp/sse",
        "--header",
        "Authorization: Token <your-pat-token>"
      ]
    }
  }
}
```

### Docker MCP Server

```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "command": "<path-to-node>",
      "args": [
        "<path-to-mcp-remote>",
        "http://localhost:3000/mcp/sse",
        "--header",
        "Authorization: Token <your-pat-token>"
      ]
    }
  }
}
```

For `compose.studio.yaml` (single-user mode), omit `"--header"` and `"Authorization: Token ..."` from args.

For remote Docker, use HTTPS to protect your token in transit (e.g., `https://<docker-host>/mcp/sse` with TLS termination via a reverse proxy). Only use plain `http://localhost` for true localhost connections on the same machine.

**Replace paths:**
- `<path-to-node>` → output of `which node`
- `<path-to-mcp-remote>` → output of `which mcp-remote`

After configuration, **quit and reopen Claude Desktop** (`Cmd+Q` / `Alt+F4`).

---

## VS Code / GitHub Copilot

VS Code supports two approaches for connecting to MCP servers.

### Approach A: HTTP Transport (remote or Docker MCP Server)

For connecting to an MCP server that's already running (remote or in Docker).

**Prerequisites:** VS Code 1.108.1+ with GitHub Copilot, Agent mode enabled.

Open `settings.json` (`Cmd/Ctrl + Shift + P` → `Preferences: Open User Settings (JSON)`):

**Remote MCP Server:**
```json
{
  "github.copilot.chat.mcp.servers": {
    "openl-mcp-server": {
      "type": "http",
      "url": "https://<your-openl-server>/mcp/sse",
      "headers": {
        "Authorization": "Token <your-pat-token>"
      }
    }
  }
}
```

**Docker MCP Server:**
```json
{
  "github.copilot.chat.mcp.servers": {
    "openl-mcp-server": {
      "type": "http",
      "url": "http://localhost:3000/mcp/sse",
      "headers": {
        "Authorization": "Token <your-pat-token>"
      }
    }
  }
}
```

**Last resort:** if your client does not support custom headers, you can pass the token via query parameter. **This is less secure** — query parameters may be logged, cached, or exposed in server logs. Always prefer the `Authorization` header above.

```json
"url": "http://localhost:3000/mcp/sse?OPENL_PERSONAL_ACCESS_TOKEN=<your-pat-token>"
```

After configuration, reload VS Code (`Cmd/Ctrl + Shift + P` → `Developer: Reload Window`).

### Approach B: Stdio Transport via Docker (standalone)

For running MCP server directly from Docker without a separate `docker compose` setup. VS Code launches a Docker container and communicates via stdin/stdout.

**Prerequisites:** VS Code 1.99+ with GitHub Copilot, Docker installed and running.

#### Step 1: Create an environment file

Create `~/.mcp/.env` (or `%USERPROFILE%\.mcp\.env` on Windows):

```bash
mkdir -p ~/.mcp
chmod 700 ~/.mcp
```

```env
# OpenL Studio API base URL (required)
# Use host.docker.internal to reach OpenL on the host machine (macOS/Windows)
OPENL_BASE_URL=http://host.docker.internal:8080

# Personal Access Token (required)
OPENL_PERSONAL_ACCESS_TOKEN=<your-pat-token>
```

Restrict permissions: `chmod 600 ~/.mcp/.env`. Never commit this file to Git.

> On Linux, add `--add-host=host.docker.internal:host-gateway` to the Docker args below.

#### Step 2: Configure MCP in VS Code

Create `.vscode/mcp.json` in your project (workspace config) or use `Cmd/Ctrl + Shift + P` → `MCP: Open User Configuration` (global config):

```json
{
  "servers": {
    "openl": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--pull=always",
        "--env-file",
        "/Users/<username>/.mcp/.env",
        "ghcr.io/openl-tablets/openl-mcp:latest",
        "node",
        "dist/index.js"
      ]
    }
  }
}
```

Replace `/Users/<username>/.mcp/.env` with the absolute path to your env file.

> `node dist/index.js` overrides the default container command to use stdio transport instead of HTTP server.

#### Step 3: Start and trust

1. Save `mcp.json`
2. VS Code will ask to **trust** the MCP server — review the command and confirm
3. Start via `MCP: List Servers` or the Start action in `mcp.json` editor

#### Using a local image (for development)

```bash
docker build -t openl-mcp:local .
```

In `mcp.json`, replace the image name with `openl-mcp:local` and remove `--pull=always`.

---

## Verify Connection

### Cursor IDE

1. Open Settings (`Cmd/Ctrl + ,`) → MCP Servers → status should show **Connected**
2. In chat, try: `List repositories in OpenL Studio`

### Claude Desktop

1. Open Settings (gear icon or `Cmd + ,`) → MCP Servers → status should show **Connected**
2. In chat, try: `What OpenL Studio tools are available?`

### VS Code

1. Check MCP server status: `MCP: List Servers` from Command Palette
2. Open Copilot Chat in **Agent** mode
3. Open the **tools** picker and ensure OpenL tools are enabled
4. Try: `List OpenL design repositories`

---

## Troubleshooting

### MCP Server Not Connecting

1. **Check paths** (Claude Desktop): run `which node` and `which mcp-remote`, ensure paths in config match exactly
2. **Check JSON syntax**: no trailing commas, valid JSON
3. **Check token**: copied completely, not expired, not revoked
4. **Network**: `curl https://<your-openl-server>/mcp/sse` should respond (not "connection refused")
5. **Restart**: completely close and reopen the AI client

### 401 Unauthorized

- Token format should be `openl_pat_<publicId>.<secret>` (copied in full)
- Authorization header: `Token <your-pat-token>` (note the space after "Token")
- Check token hasn't expired in OpenL Studio UI → User Settings → Personal Access Tokens

### Docker Container Not Reachable

```bash
# Check container is running
docker ps | grep mcp-server

# Check health
curl http://localhost:3000/health

# Check port
lsof -i :3000
```

If container is not running:
```bash
docker compose logs mcp-server
docker compose restart mcp-server
```

### ENOTFOUND / DNS Error

- Check VPN is connected (if required)
- Verify DNS: `nslookup <your-openl-server>`
- For Docker stdio: use `host.docker.internal` instead of `localhost` in env file

### mcp-remote Not Found

```bash
npm install -g mcp-remote
which mcp-remote

# If not found, check npm global path:
npm config get prefix
# Add <prefix>/bin to your PATH
```

### Client-Specific Logs

| Client | How to view logs |
|--------|-----------------|
| Cursor | `tail -f ~/Library/Logs/Cursor/*.log` |
| Claude Desktop | `tail -f ~/Library/Logs/Claude/*.log` |
| VS Code | Output panel → select "GitHub Copilot Chat" |

---

## Additional Resources

- [Quick Start](../getting-started/quick-start.md) — Get started with Docker Compose
- [Docker Setup](docker.md) — Docker configuration details
- [Authentication Guide](../guides/authentication.md) — Authentication methods (Basic Auth, PAT)
- [Troubleshooting Guide](../guides/troubleshooting.md) — More common issues and solutions
- [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) — Official VS Code MCP documentation
