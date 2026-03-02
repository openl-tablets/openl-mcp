# OpenL Studio MCP Server

Model Context Protocol server for [OpenL Studio](https://github.com/openl-tablets/openl-tablets) Business Rules Management System.

Built with MCP SDK v1.26+ featuring type-safe validation (Zod) and comprehensive OpenL Studio integration.

## Quick Links

- 🚀 [Quick Start](docs/getting-started/quick-start.md) - Get up and running in 5 minutes
- ⚙️ [MCP Connection Guide](docs/setup/mcp-connection-guide.md) - Configure Claude Desktop, Cursor, or Docker
- 📖 [Usage Examples](docs/guides/examples.md) - Learn how to use MCP tools
- 🔐 [Authentication](docs/guides/authentication.md) - Authentication setup
- 🐛 [Troubleshooting](docs/guides/troubleshooting.md) - Common issues and solutions
- 👨‍💻 [Contributing](docs/development/contributing.md) - Development guide

## Quick Start

### Run OpenL Studio + MCP with Docker

You only need a local copy of `compose.studio.yaml`.

```bash
docker compose -f compose.studio.yaml up -d
```

This starts:
- OpenL Studio image from GHCR: `ghcr.io/openl-tablets/webstudio:x`
- MCP image from GHCR: `ghcr.io/openl-tablets/openl-studio-mcp:latest`
- OpenL Studio at `http://localhost:8080`
- MCP server at `http://localhost:3000`

For a fast setup, use [Method 1 (Docker Compose, recommended) in the Quick Start guide](docs/getting-started/quick-start.md#-method-1-docker-compose-recommended).

## Documentation Structure

### Getting Started
- [Quick Start](docs/getting-started/quick-start.md) - Get up and running quickly

### Setup Guides
- [MCP Connection Guide](docs/setup/mcp-connection-guide.md) - Complete guide for connecting Cursor and Claude Desktop to MCP server (Remote and Docker)
- [Docker Setup](docs/setup/docker.md) - Running MCP server in Docker (technical details)

### Guides
- [Usage Examples](docs/guides/examples.md) - Practical examples of using MCP tools
- [Authentication Guide](docs/guides/authentication.md) - All authentication methods (Basic Auth, Personal Access Token)
- [Troubleshooting Guide](docs/guides/troubleshooting.md) - Common issues, debugging, and solutions

### Development
- [Contributing Guide](docs/development/contributing.md) - How to contribute to the project
- [Architecture](docs/development/architecture.md) - System architecture and design
- [Testing Guide](docs/development/testing.md) - Testing strategy and how to run tests
- [Code Standards](docs/development/code-standards.md) - Best practices and coding standards
- [Tool Review](docs/development/tool-review.md) - Technical review of MCP tools vs OpenL API

### Reference
- [Enable Disabled Tools](docs/reference/enable-disabled-tools.md) - How to enable temporarily disabled tools

## OpenL Studio Concepts

OpenL Studio uses **dual versioning**: Git-based commits (temporal) and dimension properties (business context). Supports multiple table types: Decision Tables (Rules, SimpleRules, SmartRules, Lookups), Spreadsheet Tables, and others (Method, Datatype, Test, etc.).

See [prompts/create_rule.md](./prompts/create_rule.md) for detailed table type guidance.

## Tools

The MCP server provides 25 active tools for managing OpenL Studio repositories, projects, rules, and deployments. All tools are prefixed with `openl_` and versioned (v1.0.0+).

**Categories:**
- **Repository Management** (4 tools) - List repositories, branches, features
- **Project Management** (12 active + 2 disabled = 14 total) - List, open, save, branch projects, test execution
- **Rules & Tables** (5 active + 1 disabled = 6 total) - List, get, update, append, create tables
- **Deployment** (4 tools) - List, deploy, redeploy projects

**Note:** 6 additional tools are temporarily disabled pending implementation fixes.

See [Usage Examples](docs/guides/examples.md) for detailed tool usage and [Enable Disabled Tools](docs/reference/enable-disabled-tools.md) for tool reference.

## Prompts

15 expert guidance templates for complex OpenL Studio workflows. Prompts provide contextual assistance, best practices, and step-by-step instructions directly in Claude Desktop or MCP Inspector.

**Available prompts:** local_projects, create_rule, create_rule_decision_tables, create_rule_spreadsheet, create_test, update_test, run_test, execute_rule, append_table, datatype_vocabulary, dimension_properties, deploy_project, get_project_errors, file_history, project_history.

**Usage:** Request prompts in Claude Desktop (e.g., "Use the create_rule prompt") or access via MCP Inspector. See [prompts/create_rule.md](./prompts/create_rule.md) for detailed content.

## Configuration

### Environment Variables

```bash
# Required
OPENL_BASE_URL=<your-base-url>

# Auth Method 1: Basic Auth
OPENL_USERNAME=<your-username>
OPENL_PASSWORD=<your-password>

# Auth Method 2: Personal Access Token
OPENL_PERSONAL_ACCESS_TOKEN=<your-token>

# Optional
OPENL_TIMEOUT=60000
```

See [Authentication Guide](docs/guides/authentication.md) for detailed auth setup.

### Claude Desktop / Cursor Configuration

See [MCP Connection Guide](docs/setup/mcp-connection-guide.md) for client-specific configuration instructions.

## Key Features

- **Type-Safe**: Zod schemas with strict validation and TypeScript inference
- **Multiple Auth Methods**: Basic Auth and Personal Access Token (PAT)
- **4 Response Formats**: json, markdown, markdown_concise, markdown_detailed
- **Pagination Support**: Metadata for all list operations
- **AI Prompts**: 15 expert guidance templates
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
openl-studio-mcp/
├── src/                    # Source code (TypeScript)
├── tests/                  # Jest test suites
├── prompts/                # AI assistant guidance (OpenL-specific)
├── dist/                   # Compiled output
├── docs/                   # Documentation
│   ├── getting-started/    # Quick start and installation
│   ├── setup/              # Client setup guides
│   ├── guides/             # Usage guides and examples
│   ├── development/        # Developer documentation
│   └── reference/          # Reference materials
└── README.md               # This file
```

## Additional Documentation

- [Documentation Index](docs/README.md) - Complete documentation navigation
- [Debug Personal Access Token](docs/guides/debug-pat.md) - PAT debugging guide
- 🚀 [Quick Start](docs/getting-started/quick-start.md) - Get up and running in 5 minutes
- ⚙️ [MCP Connection Guide](docs/setup/mcp-connection-guide.md) - Configure Claude Desktop, Cursor, or Docker
- 📖 [Usage Examples](docs/guides/examples.md) - Learn how to use MCP tools
- 🔐 [Authentication](docs/guides/authentication.md) - Authentication setup
- 🐛 [Troubleshooting](docs/guides/troubleshooting.md) - Common issues and solutions
- 👨‍💻 [Contributing](docs/development/contributing.md) - Development guide

## Resources

- [OpenL Studio](https://github.com/openl-tablets/openl-tablets)
- [OpenL Documentation](https://openl-tablets.org/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

LGPL-3.0 - GNU Lesser General Public License v3.0 (follows OpenL Studio project license).
