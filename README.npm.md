# openl-mcp-server

[Model Context Protocol](https://modelcontextprotocol.io/) server for [OpenL Studio](https://github.com/openl-tablets/openl-tablets) — the open-source Business Rules Management System.

Exposes OpenL Studio repositories, projects, rules tables, tests, and deployments as MCP tools and expert-guidance prompts, so Claude Desktop, Cursor, and any other MCP-compatible client can manage rules end-to-end.

## Install

Run ad-hoc with `npx` (recommended for MCP clients):

```bash
npx -y openl-mcp-server
```

Or install globally:

```bash
npm install -g openl-mcp-server
openl-mcp
```

**Requirements:** Node.js **≥ 24**.

## Configure

The server talks to an OpenL Studio instance over HTTP. Configure it with environment variables:

```bash
# Required
OPENL_BASE_URL=<your-openl-studio-host>

# Auth — pick one
OPENL_USERNAME=<your-username>
OPENL_PASSWORD=<your-password>
# …or Personal Access Token
OPENL_PERSONAL_ACCESS_TOKEN=<your-token>

# Optional
OPENL_TIMEOUT=60000
```

Full auth guide: [Authentication](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/authentication.md).

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp-server"],
      "env": {
        "OPENL_BASE_URL": "<your-openl-studio-host>",
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

For Cursor and other clients, see the [MCP Connection Guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/setup/mcp-connection-guide.md).

## What you get

- **25 active tools** for repositories, projects, rules tables, tests, and deployments (all prefixed `openl_`)
- **15 expert-guidance prompts** (`create_rule`, `deploy_project`, `run_test`, …) for complex OpenL Studio workflows
- **Type-safe validation** via Zod schemas
- **Multiple response formats** — `json`, `markdown`, `markdown_concise`, `markdown_detailed`

Details and tool reference: [Usage Examples](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/examples.md).

## Alternatives

Prefer containers? The same server is published as a Docker image:

- Docker Hub — `docker pull openltablets/openl-mcp:<X.Y.Z>` (tagged releases) or `:latest`
- GitHub Container Registry — `docker pull ghcr.io/openl-tablets/openl-mcp:latest` (nightly edge build, no tagged releases)

See the [Docker setup guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/setup/docker.md).

## Links

- Source & issues: <https://github.com/openl-tablets/openl-mcp>
- OpenL Studio: <https://openl-tablets.org/>
- MCP spec: <https://modelcontextprotocol.io/>

## License

LGPL-3.0 — follows the OpenL Studio project license.
