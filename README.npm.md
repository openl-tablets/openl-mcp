# openl-mcp

Let an AI assistant work with your [OpenL Studio](https://openl-tablets.org/)
business rules — ask Claude, Cursor, or VS Code Copilot in plain language to view,
edit, test, and deploy rules. This package is the connector (an
[MCP](https://modelcontextprotocol.io/) server) between your AI client and OpenL
Studio.

**Setting this up for Claude, Cursor, or VS Code? Follow the
[Quick Start](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/quick-start.md)**
— you paste one configuration block into your AI client; the client runs this
package for you via `npx`. The sections below are for manual and advanced use.

## What you get

- **Tools** covering OpenL Studio repositories, projects, files, rules tables,
  tests, an interactive rule debugger (tracing), and deployments (all prefixed `openl_`)
- **14 expert-guidance prompts** (`create_rule`, `deploy_project`, `run_test`, …) for complex OpenL Studio workflows
- **Multiple response formats** — `json`, `markdown`, `markdown_concise`, `markdown_detailed`

Details and tool reference: [Usage Examples](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/examples.md).

## Install & configure (manual use)

Run ad-hoc with `npx` — pass your OpenL Studio URL as the argument (this starts
the MCP server on stdio and waits for an MCP client; it is not meant to be used
interactively on its own):

```bash
npx -y openl-mcp http://localhost:8080
```

Or install globally: `npm install -g openl-mcp`, then `openl-mcp <url>`.

- The base URL can also come from the `OPENL_BASE_URL` environment variable
  (the positional argument wins if both are set).
- Authentication is **optional** — single-user OpenL Studio accepts
  unauthenticated requests. To authenticate, set
  `OPENL_PERSONAL_ACCESS_TOKEN=<your-token>` (or pass `--token`); create the
  token in OpenL Studio under **User Settings → Personal Access Tokens**.
- Other settings: `OPENL_TIMEOUT` / `--timeout`, and more in the
  [Advanced Guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/advanced.md#server-settings).

**Requirements:** Node.js **≥ 24** — or just Docker, see [No Node.js? Use Docker](#no-nodejs-use-docker).

## Use with Claude Desktop

Add to `claude_desktop_config.json` (in Claude Desktop: **Settings → Developer →
Edit Config**):

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "<your-openl-studio-url>"],
      "env": {
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

The base URL is passed as the positional argument. The `env` block holds auth —
omit it for single-user servers that don't require credentials.

For Claude Code (`claude mcp add openl -- npx -y openl-mcp <url>`), Cursor, and VS Code, see the [Quick Start](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/quick-start.md).

## Use as a CLI (direct API calls, no MCP client)

The same binary can invoke any tool directly from the shell — useful for
scripting, CI, and ad-hoc debugging:

```bash
npx -y openl-mcp --help                              # tool catalog, no config needed
npx -y openl-mcp <url> list_repositories --token <pat>   # one direct call
```

**See the [CLI Guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/cli.md)** for the full reference: flags, argument passing, output formats, exit codes, and recipes.

## No Node.js? Use Docker

There's no custom image — run the package on the official Node image, with nothing
installed but Docker:

```bash
docker run --rm -i node:lts-alpine npx -y openl-mcp http://host.docker.internal:8080
```

Use this as the `command`/`args` in your MCP client config (use `host.docker.internal`
to reach an OpenL Studio on the host). For a one-command OpenL Studio + MCP stack, see
the [Docker setup guide](https://github.com/openl-tablets/openl-mcp/blob/main/docs/guides/advanced.md#run-with-docker).

## Links

- Source & issues: <https://github.com/openl-tablets/openl-mcp>
- OpenL Studio: <https://openl-tablets.org/>
- MCP spec: <https://modelcontextprotocol.io/>

## License

LGPL-3.0 — follows the OpenL Studio project license.
