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
         │ + WebSocket/STOMP (async waits: compile status)
         ▼
┌─────────────────┐
│  OpenL Studio  │  ← Rules server
│   (Java/Jetty)  │     (port 8080)
└─────────────────┘
```

Most traffic is plain REST. The WebSocket channel is used only to **wait for the
studio's asynchronous work** (project compilation) inside a single
tool call instead of polling — see [WebSockets (STOMP)](websockets.md) for what is
subscribed, why, and how authentication works.

The MCP boundary uses the TypeScript SDK v2. Stdio negotiates modern
`2026-07-28` or legacy 2025 once per connection. Streamable HTTP serves modern
requests statelessly and routes legacy clients to isolated session transports;
each legacy MCP session owns its own OpenL client and Studio cookie jar. Browser
origins are accepted only from the `MCP_ALLOWED_ORIGINS` allowlist.

Tool arguments remain JSON. Binary write parameters therefore use a base64
`blob` string advertised with JSON Schema 2020-12 `contentEncoding` and
`contentMediaType`. Arbitrary binary reads use a lossless JSON TextContent
envelope containing base64 `content` plus MIME and byte-range metadata. This
avoids a client interoperability failure where non-image embedded blobs such as
XLSX and ZIP are sent to an image decoder and rejected.

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
  - Provides 74 tools for working with OpenL
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
5. MCP Server → Claude: returns JSON by default; explicit `response_format` may request Markdown
   │
6. Claude → You: shows list of repositories
```

### Table content boundary

All table-content operations cross the MCP boundary as Studio's `RawSource`
representation. `openl_get_table` always requests `raw=true`; create, update, and
append schemas accept only raw cell matrices. This is an intentional architecture
constraint, not a temporary API limitation.

Do not add Studio's typed `EditableTableView`/`AppendTableView` variants to MCP.
Those views cover only a subset of table features and can lose cells, layout,
styles, merged regions, and uncommon table constructs during a read-modify-write
cycle. Semantic table kinds remain visible in summary metadata and are encoded in
the raw OpenL grid, while raw action tools provide safe narrow edits.

Studio's raw table API exposes cell styles only on reads (`styles=true`). Its
write endpoints ignore style fields, so MCP write schemas intentionally reject
`style` instead of reporting a formatting change that did not happen. Full-table
updates must start from a raw read without styles.

## Build identity

The package version alone cannot identify a running server: every nightly tarball
built between two releases carries the same `package.json` version, and a locally
built tree may add uncommitted changes on top of it. So the version is paired with
build metadata captured from git at build time.

- `npm run build` ends with `dist/generate-build-info.js`, which writes
  `build-info.json` at the package root: commit, commit date, branch or tag,
  whether the tree was modified, and the build timestamp.
- Like the `guides/` bundle it is a build artifact — git-ignored in this
  repository, listed in `package.json` `files` so it ships in the npm package.
- `src/build-info.ts` reads it once per process and derives the **build id**:
  `<version>+<short-commit>`, suffixed `.dirty` for a modified tree,
  `<version>+unknown` when the build could not read git, and the bare version when
  no metadata shipped at all (`build.source: "unavailable"`).
- Every diagnostics surface reports that one identity: the `openl_get_version`
  tool, `openl-mcp --version`, the stdio startup log line, the HTTP `/health`
  probe, and the HTTP startup log line.
- Only the package version, public repository coordinates, and the Node/OS
  identity are reported — never configuration, credentials, base URLs, or build
  paths. A missing or malformed artifact degrades to "unavailable" and never
  blocks startup, so an unbuilt source checkout still runs.

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

### Level 0: Which build is running?
```bash
npx -y openl-mcp --version    # openl-mcp 1.1.0 (build a1b2c3d, built 2026-08-19T07:30:00.000Z)
```
The build id — version plus the commit the package was built from — identifies the
exact running code; quote it in bug reports. `openl_get_version` returns the same
identity through MCP, `/health` over the HTTP transport, and the stdio server logs
it at startup. See [Build identity](#build-identity).

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
