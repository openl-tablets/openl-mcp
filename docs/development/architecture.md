# 🏗️ Architecture: How Everything Works Together

## Interaction Diagram

```text
┌─────────────────┐
│ Claude Desktop  │  ← You are here (AI assistant)
│   (Application) │
└────────┬────────┘
         │ MCP Protocol (stdio)
         │
         ▼
┌─────────────────┐
│   MCP Server    │  ← Standalone repository
│  (Node.js/TS)   │
└────────┬────────┘
         │ HTTP API (JSON)
         │ + WebSocket/STOMP (async waits: compile & trace status)
         ▼
┌─────────────────┐
│  OpenL Studio  │  ← Rules server
│   (Java/Jetty)  │     (port 8080)
└─────────────────┘
```

Most traffic is plain REST. The WebSocket channel is used only to **wait for the
studio's asynchronous work** (project compilation, trace execution) inside a single
tool call instead of polling — see [WebSockets (STOMP)](websockets.md) for what is
subscribed, why, and how authentication works.

## Components

### 1. Claude Desktop
- **What it is:** Application with Claude AI assistant
- **Where:** Installed on your Mac
- **Role:** Interface for communicating with AI

### 2. MCP Server
- **What it is:** Bridge between Claude and OpenL
- **Where:** Standalone repository (separate from OpenL Studio project)
- **Role:** 
  - Converts Claude commands to API requests to OpenL
  - Provides 52 tools for working with OpenL
  - Manages authentication

### 3. OpenL Studio
- **What it is:** Server for managing business rules
- **Where:** Running via Docker or locally
- **Role:** Stores and executes rules, projects, tables

## Data Flow

```text
1. You write in Claude: "List repositories"
   │
2. Claude → MCP Server: calls tool openl_list_repositories
   │
3. MCP Server → OpenL API: GET /repos
   │
4. OpenL → MCP Server: returns JSON with repositories
   │
5. MCP Server → Claude: formats response as markdown
   │
6. Claude → You: shows list of repositories
```

## Configuration Files

### Claude Desktop
```text
~/Library/Application Support/Claude/claude_desktop_config.json
```
Contains MCP server settings (command, arguments, environment variables)

### MCP Server
```text
dist/index.js          # Compiled server
src/                   # Source code
src/handlers/          # Per-category tool registry (registerTool/getAllTools/executeTool in common.ts)
docs/guides/quick-start.md  # Connect your AI client, step by step
```

### OpenL Studio
```text
compose.yaml                       # Docker Compose configuration
DEMO/start                         # Local startup script
```

## Startup Process

The MCP server is launched **by your AI client** over stdio (via `npx`, or Docker when
Node.js isn't installed) — you don't start it yourself. You only need OpenL Studio
running:

### Option 1: Docker
```bash
# Start OpenL Studio (compose.yaml also runs a shared MCP server)
docker compose up
```

### Option 2: Locally
```bash
cd DEMO && ./start
```

Then configure your client (see the [Quick Start](../guides/quick-start.md));
it spawns the MCP server on demand.

## Authentication

MCP Server authenticates with a **Personal Access Token** (optional — omit for OpenL Studio single-user mode):

```env
OPENL_PERSONAL_ACCESS_TOKEN=<your-token>
```

## Health Check

### Level 1: Is OpenL accessible?
```bash
curl http://localhost:8080/rest/repos
```

### Level 2: Is MCP Server configured?
```bash
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | grep openl
```

### Level 3: Does Claude see the server?
- Open Claude Desktop settings
- Check MCP server status

### Level 4: Does everything work?
In Claude: "List repositories in OpenL Studio"

## Common Issues

### Issue: Claude doesn't see MCP server
**Cause:** Invalid client config, or Node.js missing for `npx`
**Solution:** Check the client's MCP config (valid JSON, correct package name and URL); confirm `node -v`, or use the [Docker option](../guides/advanced.md#run-with-docker). Restart the client.

### Issue: "Cannot connect to OpenL API"
**Cause:** OpenL not running or inaccessible
**Solution:** Start `docker compose up` or `DEMO/start`

### Issue: "Authentication failed"
**Cause:** Incorrect or expired token
**Solution:** Check `OPENL_PERSONAL_ACCESS_TOKEN` in configuration

## Useful Commands

### MCP Server Commands
```bash
# Navigate to MCP Server repository
cd <path-to-mcp-server-repo>

# Build TypeScript
npm run build

# Run the server
npm start

# Run in development mode
npm run dev

# Run tests
npm test

# Run linting
npm run lint
```

### OpenL Studio Commands
```bash
# View OpenL logs (Docker)
docker compose logs -f studio

# Start OpenL via Docker
docker compose up

# Start OpenL locally (in OpenL Studio repository)
cd DEMO && ./start
```
