# Docker Setup for MCP Server

## Overview

MCP Server runs as a standalone HTTP application (Express) that provides MCP protocol access (SSE and Streamable HTTP transports) to OpenL Studio. It can be deployed as a Docker container that connects to any OpenL Studio instance.

## Architecture

```text
┌─────────────────────┐
│  AI Client          │  Claude Desktop / Cursor / VS Code
│  (MCP Client)       │
└────────┬────────────┘
         │ SSE / Streamable HTTP
         │ (port 3000)
         ▼
┌─────────────────────┐
│  MCP Server         │  Docker container
│  (Express + MCP SDK)│
└────────┬────────────┘
         │ HTTP API
         │
         ▼
┌─────────────────────┐
│  OpenL Studio       │  External or Docker container
│  (port 8080)        │
└─────────────────────┘
```

**Key points:**
- MCP Server does NOT store credentials — authentication is passed from the AI client via headers or query parameters
- `OPENL_BASE_URL` is configured on the server side (tells MCP Server where OpenL Studio is)
- The AI client provides the authentication token per session

---

## Quick Start

### Option A: Full Stack (OpenL Studio + MCP Server)

Use `compose.studio.yaml` to run both OpenL Studio and MCP Server together:

```bash
docker compose -f compose.studio.yaml up -d
```

This starts:
- **OpenL Studio** at `http://localhost:8080` (image from GHCR)
- **MCP Server** at `http://localhost:3000` (image from GHCR)

OpenL Studio runs in single-user mode — no authentication is needed.

Verify:
```bash
# Check MCP Server health
curl http://localhost:3000/health

# Check OpenL Studio
curl http://localhost:8080
```

### Option B: MCP Server Only (connect to existing OpenL Studio)

Use `compose.yaml` when you already have OpenL Studio running elsewhere:

```bash
# Set the URL of your OpenL Studio instance
export OPENL_BASE_URL=http://host.docker.internal:8080

docker compose up -d
```

`host.docker.internal` resolves to the host machine from inside Docker. Replace with your OpenL Studio URL if it runs on a different host.

Verify:
```bash
curl http://localhost:3000/health
```

---

## Connecting AI Clients

After starting the Docker container, configure your AI client to connect.

### Cursor / VS Code (direct HTTP)

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

### Claude Desktop (requires [Node.js 24+](https://nodejs.org/) and mcp-remote stdio proxy)

Claude Desktop only supports stdio transport, so `mcp-remote` is needed as a bridge:

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
        "http://localhost:3000/mcp/sse",
        "--header",
        "Authorization: Token <your-pat-token>"
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

> **Note:** When using `compose.studio.yaml` (single-user mode), authentication headers are not required.

For detailed client configuration, see [MCP Connection Guide](mcp-connection-guide.md).

---

## Environment Variables

MCP Server uses the following environment variables:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `OPENL_BASE_URL` | OpenL Studio API URL | **Yes** | — |
| `PORT` | HTTP server port | No | `3000` |
| `NODE_ENV` | Environment mode | No | `production` |

> **Authentication is NOT configured via environment variables.** Credentials are passed from the AI client per session via `Authorization` header or query parameters. See [Authentication Guide](../guides/authentication.md) for details.

---

## Docker Compose Files

### `compose.studio.yaml` — Full Stack

Runs OpenL Studio and MCP Server together. Best for getting started quickly.

```yaml
# Key services:
# - studio: OpenL Studio (port 8080)
# - mcp-server: MCP Server (port 3000), connects to studio internally
```

### `compose.yaml` — MCP Server Only

Runs just the MCP Server. Requires `OPENL_BASE_URL` to point to an existing OpenL Studio instance.

```bash
# Connect to OpenL Studio on the host machine
OPENL_BASE_URL=http://host.docker.internal:8080 docker compose up -d

# Connect to a remote OpenL Studio
OPENL_BASE_URL=https://openl.example.com docker compose up -d
```

The container port can be changed via `MCP_PORT`:
```bash
MCP_PORT=3001 docker compose up -d
# MCP Server will be available at http://localhost:3001
```

---

## Building from Source

By default, `compose.yaml` builds the image locally from the Dockerfile. To use a pre-built image instead:

```bash
MCP_IMAGE=ghcr.io/openl-tablets/openl-studio-mcp:latest docker compose up -d
```

---

## Local Development (without Docker)

```bash
# Install dependencies
npm install

# Build
npm run build

# Start HTTP server
export OPENL_BASE_URL="http://localhost:8080"
npm run start:http
```

### Development Mode with Auto-rebuild

```bash
# Terminal 1: Watch for changes and rebuild
npm run watch

# Terminal 2: Start server
export OPENL_BASE_URL="http://localhost:8080"
npm run start:http
```

---

## HTTP API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
```

### MCP Protocol (SSE)
```text
GET  /mcp/sse              — Establish SSE connection
POST /mcp/messages          — Send messages to MCP server
POST /mcp/sse              — Streamable HTTP transport
```

### REST API (for debugging)
```bash
# List all tools
curl http://localhost:3000/tools | jq

# Get tool info
curl http://localhost:3000/tools/openl_list_repositories | jq

# Execute tool
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "openl_list_repositories", "arguments": {}}'
```

---

## Troubleshooting

### MCP Server doesn't start

```bash
# Check container status
docker compose logs mcp-server

# Verify OPENL_BASE_URL is set (for compose.yaml)
docker compose exec mcp-server env | grep OPENL
```

### Cannot connect to OpenL Studio

```bash
# Check that OpenL Studio is reachable from the container
docker compose exec mcp-server wget -qO- http://studio:8080/health || echo "Not reachable"

# For compose.yaml (external OpenL Studio), verify the URL
docker compose exec mcp-server wget -qO- $OPENL_BASE_URL || echo "Not reachable"
```

Common causes:
- OpenL Studio not running — check with `curl http://localhost:8080`
- Wrong `OPENL_BASE_URL` — must be reachable from inside the container (use `host.docker.internal` for host machine)
- Network/firewall issues — ensure the port is accessible

### Port 3000 is occupied

Change the external port:
```bash
MCP_PORT=3001 docker compose up -d
```

### AI client cannot connect to MCP Server

1. Verify MCP Server is running: `curl http://localhost:3000/health`
2. Check that the URL in client config matches the port
3. For Claude Desktop: ensure `mcp-remote` is installed (`npm install -g mcp-remote`)
4. Restart the AI client after configuration changes

### View logs

```bash
# Follow logs in real-time
docker compose logs -f mcp-server

# Last 100 lines
docker compose logs --tail=100 mcp-server
```

For more troubleshooting, see [Troubleshooting Guide](../guides/troubleshooting.md).

---

## Additional Resources

- [Quick Start Guide](../getting-started/quick-start.md) — Get started quickly
- [MCP Connection Guide](mcp-connection-guide.md) — Detailed client setup (Cursor, Claude Desktop, VS Code)
- [Authentication Guide](../guides/authentication.md) — Authentication methods
- [Troubleshooting Guide](../guides/troubleshooting.md) — Common issues and solutions
