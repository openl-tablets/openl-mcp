# openl-mcp-server

[Model Context Protocol](https://modelcontextprotocol.io/) server for [OpenL Studio](https://github.com/openl-tablets/openl-tablets) — the open-source Business Rules Management System.

Exposes OpenL Studio repositories, projects, rules tables, tests, and deployments as MCP tools and expert-guidance prompts, so Claude Desktop, Cursor, and any other MCP-compatible client can manage rules end-to-end.

## Install

Run ad-hoc with `npx` (recommended for MCP clients) — pass your OpenL Studio URL as the argument:

```bash
npx -y openl-mcp-server http://localhost:8080
```

Or install globally:

```bash
npm install -g openl-mcp-server
openl-mcp http://localhost:8080
```

> The base URL can also come from the `OPENL_BASE_URL` environment variable instead of the positional argument (the positional wins if both are set).

**Requirements:** Node.js **≥ 24** — or just Docker, see [No Node.js? Use Docker](#no-nodejs-use-docker).

## Configure

Point the server at your OpenL Studio instance with a **positional URL** (preferred) or the `OPENL_BASE_URL` environment variable:

```bash
# Base URL as the positional argument (preferred)
npx -y openl-mcp-server http://localhost:8080

# …or via the environment variable
OPENL_BASE_URL=http://localhost:8080 npx -y openl-mcp-server
```

Authentication is **optional** — OpenL Studio single-user mode accepts unauthenticated requests. To authenticate, set a Personal Access Token (env var or matching CLI flag):

```bash
# Personal Access Token
OPENL_PERSONAL_ACCESS_TOKEN=<your-token>   # or --token

# Optional
OPENL_TIMEOUT=60000              # or --timeout
```

Full auth guide: [Authentication](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/authentication.md).

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp-server", "<your-openl-studio-host>"],
      "env": {
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

The base URL is passed as the positional argument. Alternatively, drop it from `args` and set `OPENL_BASE_URL` in `env`. The `env` block holds auth and is optional — omit it for single-user servers that don't require credentials.

For Claude Code (`claude mcp add openl -- npx -y openl-mcp-server <url>`), Cursor, and VS Code, see the [MCP Connection Guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/setup/mcp-connection-guide.md).

## Use as a CLI (direct API calls, no MCP client)

The same binary can invoke any `openl_*` tool directly from the shell — useful for scripting, CI, and ad-hoc debugging without setting up an MCP client. CLI mode is **agent-first**: output defaults to markdown (LLM-friendly, same as the MCP server); pass `response_format: "json"` when you want to pipe into `jq`.

```bash
# Quick discovery (no config needed)
npx -y openl-mcp-server --help          # human catalog (tool titles)
npx -y openl-mcp-server --list-tools    # machine-readable JSON (name/title/schema)

# Single call — base URL as a positional argument (markdown by default).
# Tool names drop the openl_ prefix on the CLI (use list_repositories, not openl_list_repositories).
npx -y openl-mcp-server <host> list_repositories --token <pat>

# …or via env vars
OPENL_BASE_URL=<host> OPENL_PERSONAL_ACCESS_TOKEN=<pat> \
  npx -y openl-mcp-server list_repositories

# JSON for jq pipelines
npx -y openl-mcp-server <host> list_repositories '{"response_format":"json"}' --token <pat> | jq
```

**See [`README.cli.md`](https://github.com/openl-tablets/openl-mcp/blob/main/README.cli.md)** for the full CLI guide: configuration, all flags (`--base-url`, `--token`, `--timeout`, `--client-document-id`, `--cookie-jar`), argument-passing modes (`@file.json`, `--stdin`), session handling for trace flows, recipes, exit codes, Windows notes, and troubleshooting.

Run with just a `<url>` (and no tool name) — or with no arguments at all (falling back to `OPENL_BASE_URL`) — to start the MCP server on stdio.

## What you get

- **40 active tools** for repositories, projects, rules tables, tests, and deployments (all prefixed `openl_`)
- **14 expert-guidance prompts** (`create_rule`, `deploy_project`, `run_test`, …) for complex OpenL Studio workflows
- **Type-safe validation** via Zod schemas
- **Multiple response formats** — `json`, `markdown`, `markdown_concise`, `markdown_detailed`

Details and tool reference: [Usage Examples](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/examples.md).

## No Node.js? Use Docker

There's no custom image — run the package on the official Node image, with nothing
installed but Docker:

```bash
docker run --rm -i node:lts-alpine npx -y openl-mcp-server http://host.docker.internal:8080
```

Use this as the `command`/`args` in your MCP client config (use `host.docker.internal`
to reach an OpenL Studio on the host). For a one-command OpenL Studio + MCP stack, see
the [Docker setup guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/setup/docker.md).

## Links

- Source & issues: <https://github.com/openl-tablets/openl-mcp>
- OpenL Studio: <https://openl-tablets.org/>
- MCP spec: <https://modelcontextprotocol.io/>

## License

LGPL-3.0 — follows the OpenL Studio project license.
