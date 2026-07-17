# OpenL MCP Server

Let an AI assistant work with your OpenL Studio business rules. Connect Claude
(Desktop or Code), Cursor, or VS Code to [OpenL Studio](https://openl-tablets.org/),
then ask in plain language to view, edit, test, and deploy rules.

## Get started (about 5 minutes)

1. **Copy your OpenL Studio address** from your browser's address bar (for example
   `http://localhost:8080`).
2. **Create a Personal Access Token** in OpenL Studio (**User Settings → Personal
   Access Tokens**). Skip this if your Studio has no login screen.
3. **Follow the [Quick Start](docs/guides/quick-start.md)** — paste one
   configuration block into your AI client and send a test message.

Nothing to install — your AI client downloads and starts the server for you
(published on npm as [`openl-mcp`](https://www.npmjs.com/package/openl-mcp);
no Node.js on your machine? use the
[Docker option](docs/guides/advanced.md#run-with-docker)).

## Documentation

- 🚀 [Quick Start](docs/guides/quick-start.md) — connect Claude Code, Claude Desktop, Cursor, or VS Code
- 📖 [Usage Examples](docs/guides/examples.md) — what to ask once connected, and what the tools cover
- ⚙️ [Advanced Guide](docs/guides/advanced.md) — all server settings, authentication, Docker, shared HTTP mode
- 🖥️ [CLI Guide](docs/guides/cli.md) — use the same binary as a shell tool (no MCP client needed)
- 🐛 [Troubleshooting](docs/guides/troubleshooting.md) — common issues and solutions
- 🗂️ [Full documentation index](docs/README.md) — including developer docs

## Tools and prompts

The server gives the AI client tools covering OpenL Studio repositories, projects,
files, rules tables, tests, an interactive rule debugger (tracing), and
deployments — see [Usage Examples](docs/guides/examples.md). It also ships 14
expert guidance prompts for complex workflows (e.g. `create_rule`,
`deploy_project`) — see [prompts/](./prompts/).

## Configuration

End users: the [Quick Start](docs/guides/quick-start.md) covers everything.
All server settings (base URL, token, timeout, HTTP mode, debug logging) are in
the [Advanced Guide](docs/guides/advanced.md#server-settings).

## Development

```bash
npm run build          # Build TypeScript
npm test               # Run all tests
npm run lint           # Check code quality
npm run watch          # Dev mode with auto-rebuild
```

See the [Contributing Guide](docs/development/contributing.md) for development
guidelines, [Architecture](docs/development/architecture.md) for how the code is
organized, and the [Testing Guide](docs/development/testing.md) for test suites.

## License

LGPL-3.0 - GNU Lesser General Public License v3.0 (follows OpenL Studio project license).
