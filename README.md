# OpenL MCP Server

Model Context Protocol server for [OpenL Studio](https://github.com/openl-tablets/openl-tablets) Business Rules Management System.

Built with MCP SDK v1.29+ featuring type-safe validation (Zod) and comprehensive OpenL Studio integration.

## Quick Links

- 🚀 [Quick Start](docs/guides/quick-start.md) - Connect Claude Code, Claude Desktop, Cursor, or VS Code in ~5 minutes
- ⚙️ [Advanced Guide](docs/guides/advanced.md) - Settings, authentication, Docker, and CLI mode
- 🖥️ [CLI Guide](docs/guides/cli.md) - Use the same binary as a shell tool (no MCP client needed)
- 📖 [Usage Examples](docs/guides/examples.md) - Learn how to use MCP tools
- 🐛 [Troubleshooting](docs/guides/troubleshooting.md) - Common issues and solutions
- 👨‍💻 [Contributing](docs/development/contributing.md) - Development guide

## npm Distribution

The MCP server is published as an npm package: [`openl-mcp`](https://www.npmjs.com/package/openl-mcp) — stdio transport via `npx` for Claude Code / Claude Desktop / Cursor / VS Code. No Node.js? Run it on the official Docker image instead — see the [Advanced Guide](docs/guides/advanced.md#run-with-docker).

The same binary also doubles as a **CLI** for direct API calls without an MCP client (`npx -y openl-mcp <tool> '<json-args>'`) — see the [CLI Guide](docs/guides/cli.md) for the full reference.

For npm package details see [README.npm.md](README.npm.md).

## Documentation Structure

### Getting Started
- [Quick Start](docs/guides/quick-start.md) - Connect your AI client (Claude Code, Claude Desktop, Cursor, VS Code)

### Guides
- [Usage Examples](docs/guides/examples.md) - Practical examples of using MCP tools
- [Advanced Guide](docs/guides/advanced.md) - Settings, authentication, Docker, and CLI mode
- [CLI Guide](docs/guides/cli.md) - Use the same binary as a shell tool (no MCP client needed)
- [Troubleshooting Guide](docs/guides/troubleshooting.md) - Common issues, debugging, and solutions

### Development
- [Contributing Guide](docs/development/contributing.md) - How to contribute to the project
- [Architecture](docs/development/architecture.md) - System architecture and design
- [Testing Guide](docs/development/testing.md) - Testing strategy and how to run tests
- [Code Standards](docs/development/code-standards.md) - Best practices and coding standards
- [Tool Review](docs/development/tool-review.md) - Technical review of MCP tools vs OpenL API

## OpenL Studio Concepts

OpenL Studio uses **dual versioning**: Git-based commits (temporal) and dimension properties (business context). Supports multiple table types: Decision Tables (Rules, SimpleRules, SmartRules, Lookups), Spreadsheet Tables, and others (Method, Datatype, Test, etc.).

See [prompts/create_rule.md](./prompts/create_rule.md) for detailed table type guidance.

## Tools

The MCP server provides 58 tools for managing OpenL Studio repositories, projects, rules, tables, tests, traces, and deployments. All tools are prefixed with `openl_` and versioned (v1.0.0+).

**Categories:**
- **Guidance** - Agent onboarding (`openl_get_started`), per-project AGENTS.md context (`openl_get_project_agent_context`), and the official OpenL reference documentation embedded at build time (`openl_list_guides` / `openl_get_guides`)
- **Repository Management** - List repositories, branches, features, and revisions
- **Project Management** - List, open, save, close, create, and branch projects; track local changes
- **Files** - Read, write, search, copy, move, and delete project files
- **Rules & Tables** - List, get, update, append, create, and delete tables; apply single raw-source edits (insert/delete/update/merge a row, column, or cell)
- **Tests** - Start tests and retrieve results (full, summary, or by table)
- **Tracing** - Interactive rule debugger: start a session, step into/over/out, set breakpoints, run to a stop, inspect live frame variables and decision-table outcomes, profile a whole run
- **Deployment** - List deploy repositories and deployments; deploy and redeploy projects

See [Usage Examples](docs/guides/examples.md) for detailed tool usage.

## Prompts

14 expert guidance templates for complex OpenL Studio workflows. Prompts provide contextual assistance, best practices, and step-by-step instructions directly in Claude Desktop or MCP Inspector.

**Available prompts:** local_projects, create_rule, create_rule_decision_tables, create_rule_spreadsheet, create_test, update_test, run_test, append_table, datatype_vocabulary, dimension_properties, deploy_project, validate_after_edit, project_agents_md, project_history.

**Usage:** Request prompts in Claude Desktop (e.g., "Use the create_rule prompt") or access via MCP Inspector. See [prompts/create_rule.md](./prompts/create_rule.md) for detailed content.

## Configuration

### Base URL

Pass the OpenL Studio base URL as a **positional argument** (preferred), or set `OPENL_BASE_URL`:

```bash
# Positional argument (preferred) — starts the stdio MCP server
openl-mcp http://localhost:8080
npx -y openl-mcp http://localhost:8080

# …or via the environment variable
OPENL_BASE_URL=http://localhost:8080 openl-mcp
```

The positional URL takes precedence over `OPENL_BASE_URL` if both are set.

### Environment Variables

```bash
# Base URL (or pass it as the positional argument above)
OPENL_BASE_URL=<your-base-url>

# Auth is optional (single-user mode accepts unauthenticated requests).
# Personal Access Token
OPENL_PERSONAL_ACCESS_TOKEN=<your-token>

# Optional
OPENL_TIMEOUT=60000
```

See the [Advanced Guide](docs/guides/advanced.md#authentication) for authentication and all settings.

### Client configuration

See the [Quick Start](docs/guides/quick-start.md) for client-specific configuration (Claude Code, Claude Desktop, Cursor, VS Code).

## Key Features

- **Type-Safe**: Zod schemas with strict validation and TypeScript inference
- **Personal Access Token Auth**: PAT-based authentication (or none, for single-user mode)
- **4 Response Formats**: json, markdown, markdown_concise, markdown_detailed
- **Pagination Support**: Metadata for all list operations
- **AI Prompts**: 14 expert guidance templates
- **Comprehensive Tests**: Full test suite covering core functionality

## Development

```bash
npm run build          # Build TypeScript
npm test               # Run all tests
npm run lint           # Check code quality
npm run watch          # Dev mode with auto-rebuild
```

See [Contributing Guide](docs/development/contributing.md) for development guidelines and [Testing Guide](docs/development/testing.md) for test suites.

## Project Structure

```
openl-mcp/
├── src/                    # Source code (TypeScript)
├── tests/                  # Jest test suites
├── prompts/                # AI assistant guidance (OpenL-specific)
├── dist/                   # Compiled output
├── docs/                   # Documentation
│   ├── guides/             # User guides: setup, usage, auth, troubleshooting, Docker
│   └── development/        # Developer documentation
└── README.md               # This file
```

## More Documentation

- [Documentation Index](docs/README.md) - Full navigation map

## Resources

- [OpenL Studio](https://github.com/openl-tablets/openl-tablets)
- [OpenL Documentation](https://openl-tablets.org/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

LGPL-3.0 - GNU Lesser General Public License v3.0 (follows OpenL Studio project license).
