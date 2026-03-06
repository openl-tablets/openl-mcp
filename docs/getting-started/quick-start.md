# Quick Start: Running OpenL Studio with MCP Server

This guide will help you start OpenL Studio and MCP Server for working with Claude Desktop, Cursor IDE, or VS Code Copilot.

## What You Need

1. **OpenL Studio** — Business rules server (port 8080)
2. **MCP Server** — Bridge between AI clients and OpenL Studio (port 3000)
3. **AI Client** — Claude Desktop, Cursor IDE, or VS Code

---

## Method 1: Docker Compose (Recommended)

The easiest way — runs OpenL Studio and MCP Server together with a single command.

### Prerequisites

- Docker and Docker Compose installed

### Step 1: Start OpenL Studio + MCP Server

You only need a local copy of [`compose.studio.yaml`](../../compose.studio.yaml).

```bash
docker compose -f compose.studio.yaml up -d
```

This starts:
- **OpenL Studio** at `http://localhost:8080` (image: `ghcr.io/openl-tablets/webstudio:x`)
- **MCP Server** at `http://localhost:3000` (image: `ghcr.io/openl-tablets/openl-studio-mcp:latest`)

Wait 1-2 minutes for everything to start.

### Step 2: Verify

```bash
# Check MCP Server
curl http://localhost:3000/health
# Should return: {"status":"ok",...}

# Check OpenL Studio
open http://localhost:8080
```

### Step 3: Connect AI Client

OpenL Studio runs in single-user mode with `compose.studio.yaml`, so no authentication is needed.

**Cursor** (direct HTTP connection):

```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "url": "http://localhost:3000/mcp/sse",
      "transport": "sse"
    }
  }
}
```

**VS Code / GitHub Copilot** (`settings.json`):

```json
{
  "github.copilot.chat.mcp.servers": {
    "openl-mcp-server": {
      "type": "http",
      "url": "http://localhost:3000/mcp/sse"
    }
  }
}
```

**Claude Desktop** (requires [Node.js 24+](https://nodejs.org/) and `mcp-remote` stdio proxy):

```bash
# Install mcp-remote if not installed
npm install -g mcp-remote
```

```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "command": "<path-to-node>",
      "args": [
        "<path-to-mcp-remote>",
        "http://localhost:3000/mcp/sse"
      ]
    }
  }
}
```

Find your paths:
```bash
which node         # e.g., /Users/username/.nvm/versions/node/v24.0.0/bin/node
which mcp-remote   # e.g., /Users/username/.nvm/versions/node/v24.0.0/bin/mcp-remote
```

For detailed client-specific instructions, see [MCP Connection Guide](../setup/mcp-connection-guide.md).

### Step 4: Test Connection

In your AI client chat, try:

```
List repositories in OpenL Studio
```

The AI should use MCP tools and show the list of repositories.

---

## Method 2: Connect to Existing OpenL Studio

If you already have OpenL Studio running (locally or on a remote server), you can run just the MCP Server.

### Prerequisites

- Docker and Docker Compose installed
- OpenL Studio accessible at a known URL
- Personal Access Token (PAT) created in OpenL Studio UI — see [MCP Connection Guide](../setup/mcp-connection-guide.md#create-a-personal-access-token-pat)

### Step 1: Start MCP Server

Use [`compose.yaml`](../../compose.yaml) from the project root:

```bash
# Set the URL of your OpenL Studio instance
export OPENL_BASE_URL=http://host.docker.internal:8080

docker compose up -d
```

> `host.docker.internal` resolves to the host machine from inside Docker. Replace with your OpenL Studio URL if it runs elsewhere.

### Step 2: Verify

```bash
curl http://localhost:3000/health
# Should return: {"status":"ok",...}
```

### Step 3: Connect AI Client

Since OpenL Studio uses authentication, you need to pass your PAT token.

**Cursor / VS Code:**

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

**Claude Desktop** (requires [Node.js 24+](https://nodejs.org/) and `mcp-remote`):

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

For complete setup details, see [MCP Connection Guide](../setup/mcp-connection-guide.md) and [Docker Setup](../setup/docker.md).

### Step 4: Test Connection

In your AI client chat, try:

```
List repositories in OpenL Studio
```

---

## Troubleshooting

### OpenL Studio is not accessible

```bash
# Check container status
docker compose -f compose.studio.yaml ps

# View OpenL Studio logs
docker compose -f compose.studio.yaml logs studio
```

### MCP Server doesn't appear in AI client

1. Check MCP Server is running:
   ```bash
   curl http://localhost:3000/health
   ```
2. Verify your AI client configuration (JSON must be valid — no trailing commas)
3. Completely restart your AI client after configuration changes

### Authentication failed

1. Verify your PAT token is correct and not expired
2. Check the `Authorization` header format — should be `Token <your-pat-token>`
3. Try logging into OpenL Studio via browser with the same credentials

### Docker containers don't start

```bash
# Check that Docker is running
docker ps

# Check if ports are already in use
lsof -i :8080
lsof -i :3000

# View logs
docker compose -f compose.studio.yaml logs
```

For more details, see [Troubleshooting Guide](../guides/troubleshooting.md).

---

## Readiness Checklist

- [ ] OpenL Studio is running at [http://localhost:8080](http://localhost:8080)
- [ ] MCP Server health check passes: `curl http://localhost:3000/health`
- [ ] AI client is configured and restarted
- [ ] MCP server shows "Connected" in AI client settings
- [ ] AI client can execute: "List repositories in OpenL Studio"

---

## Useful Commands

```bash
# Stop everything
docker compose -f compose.studio.yaml down

# View OpenL Studio logs
docker compose -f compose.studio.yaml logs -f studio

# View MCP Server logs
docker compose -f compose.studio.yaml logs -f mcp-server

# Restart MCP Server only
docker compose -f compose.studio.yaml restart mcp-server
```

---

## Next Steps

- [MCP Connection Guide](../setup/mcp-connection-guide.md) — Detailed setup for Cursor, Claude Desktop, VS Code
- [Docker Setup](../setup/docker.md) — Advanced Docker configuration
- [Authentication Guide](../guides/authentication.md) — Authentication methods
- [Usage Examples](../guides/examples.md) — How to use MCP tools
- [Troubleshooting](../guides/troubleshooting.md) — Common issues and solutions
