# Release Notes - OpenL MCP Server

## [Version 1.0.0](https://github.com/openl-tablets/openl-mcp/releases/tag/v1.0.0) - February 23, 2026

The OpenL MCP Server enables **natural language interaction with OpenL Studio** through AI assistants like Claude Desktop, Cursor IDE, and VS Code Copilot. This initial release brings 25 production-ready tools, 15 expert guidance prompts, and comprehensive MCP protocol support to business rules management.

Built on the Model Context Protocol (MCP) v1.26.0, the server acts as a bridge between AI assistants and OpenL Studio's REST API, transforming complex business rules operations into simple conversational commands. Business analysts, QA teams, and operations staff can now create rules, run tests, and deploy to production using plain English - no programming required.

---

## New Features

### 25 Production-Ready MCP Tools

The server provides comprehensive OpenL Studio access through 25 tools organized into four functional categories:

**Repository Management (4 tools)**
- `openl_list_repositories` - List all design repositories with metadata
- `openl_list_branches` - List Git branches with current branch indicator
- `openl_list_repository_features` - Get repository capabilities
- `openl_repository_project_revisions` - Get project revision history

**Project Management (12 tools)**
- `openl_list_projects` - List and filter projects with pagination
- `openl_get_project` - Get comprehensive project details
- `openl_open_project` - Open project for editing with branch/revision support
- `openl_save_project` - Save changes to Git with validation
- `openl_close_project` - Close project with save/discard safety checks
- `openl_create_project_branch` - Create new Git branches
- `openl_list_project_local_changes` - View workspace history
- `openl_restore_project_local_change` - Restore previous versions
- `openl_start_project_tests` - Execute project tests
- `openl_get_test_results_summary` - Get brief test summary
- `openl_get_test_results` - Get detailed test results with pagination
- `openl_get_test_results_by_table` - Filter test results by table

**Rules & Tables Management (5 tools)**
- `openl_list_tables` - List all tables with filtering
- `openl_get_table` - Get table structure and data
- `openl_update_table` - Replace entire table
- `openl_append_table` - Add fields/rows incrementally
- `openl_create_project_table` - Create new tables programmatically

**Deployment (4 tools)**
- `openl_list_deploy_repositories` - List deployment repositories
- `openl_list_deployments` - List active deployments
- `openl_deploy_project` - Deploy to production
- `openl_redeploy_project` - Redeploy with new version

### 15 Expert Guidance Prompts

Built-in templates provide contextual assistance for complex OpenL workflows:

**Local Projects**
- `local_projects` - Working with repository 'local' (no open/save/close; table/rule/test tools only)

**Table Creation & Management**
- `create_rule` - Comprehensive guide for all table types
- `create_rule_decision_tables` - Detailed decision table guide
- `create_rule_spreadsheet` - Complete spreadsheet guide with formulas
- `datatype_vocabulary` - Custom datatype definitions
- `append_table` - Incremental table updates

**Testing & Validation**
- `create_test` - Test table creation guide
- `update_test` - Test modification guide
- `run_test` - Test execution workflow
- `execute_rule` - Rule execution guide

**Advanced Features**
- `dimension_properties` - Context-based versioning
- `file_history` - File version history
- `project_history` - Project audit trail

**Deployment & Quality**
- `deploy_project` - Deployment workflow
- `get_project_errors` - Error analysis

### MCP Resources

Read-only access to OpenL data via URI scheme:
- `openl://repositories` - All design repositories
- `openl://projects` - All projects
- `openl://projects/{projectId}` - Project details
- `openl://projects/{projectId}/tables` - Project tables
- `openl://projects/{projectId}/tables/{tableId}` - Table data
- `openl://projects/{projectId}/history` - Git history
- `openl://projects/{projectId}/files/{filePath}` - File download
- `openl://deployments` - All deployments

### Multi-Client Support

Seamless integration with three AI platforms:

**Claude Desktop**
- stdio transport for native integration
- Remote access via `mcp-remote` proxy
- Configuration via `claude_desktop_config.json`

**Cursor IDE**
- stdio, HTTP SSE, and streamablehttp transports
- Direct HTTP SSE for remote servers
- Configuration via MCP settings

**VS Code Copilot**
- HTTP transport with Agent mode requirement
- Header or query parameter authentication
- Configuration via `settings.json`

### Flexible Authentication

**Personal Access Token (PAT)** - Recommended for production
- User-generated revocable tokens
- Token format: `openl_pat_<publicId>.<secret>`
- Header format: `Authorization: Token <pat-token>`

### Response Formatting

Four output formats for different use cases:
- `json` - Structured data for programmatic processing
- `markdown` - Human-readable formatted output (default)
- `markdown_concise` - Brief 1-2 paragraph summaries
- `markdown_detailed` - Comprehensive details with metadata

### Security Features

- **Automatic credential redaction** in logs and error messages
- **Request tracking** via Client Document ID for audit trails
- **Input validation** using Zod schemas with strict type checking
- **Full TypeScript type safety** eliminating runtime type errors
- **Environment variable storage** for secure credential management
- **HTTPS/TLS support** for encrypted connections

---

## Improvements

*This is the initial release - no previous version to compare against.*

---

## Fixed Bugs

*This is the initial release - no bugs to fix from previous versions.*

---

## Updated Libraries

### Core Runtime Dependencies

- **@modelcontextprotocol/sdk** v1.26.0 - Model Context Protocol implementation
- **TypeScript** 5.7.2 - Language and type system
- **Node.js** ≥24.0.0 - JavaScript runtime (LTS version)
- **axios** v1.13.5 - HTTP client with retry logic
- **Zod** v4.3.5 - Runtime schema validation
- **Express** v5.2.1 - HTTP server for SSE/streamablehttp

### Testing & Development

- **Jest** v30.2.0 - Testing framework with ES modules support
- **ESLint** v9.17.0 - Code linting with TypeScript parser
- **TypeScript Compiler** - Build tooling with source maps

---

## Known Issues

### Platform Limitations

- **Node.js 24+ Required** - Earlier versions not supported (use nvm to install Node.js 24)
- **Claude Desktop Transport** - Only supports stdio (requires `mcp-remote` for remote servers)
- **Large Responses** - Automatic truncation at 25,000 characters with pagination guidance
- **Session Management** - Some endpoints require project to be opened first

### Temporarily Disabled Tools (6)

The following tools are defined but not yet enabled pending full implementation:
- `openl_upload_file` - Upload Excel files to projects
- `openl_download_file` - Download Excel files from projects
- `openl_execute_rule` - Execute rules with test data
- `openl_get_file_history` - View Git history for specific files
- `openl_get_project_history` - View Git history for entire project
- `openl_revert_version` - Revert to previous Git commit

**Status**: Planned for v1.1.0 release in Q2 2026

---

## Migration Notes

### From Beta/Pre-release

This is the **initial stable release (v1.0.0)** - no migration required.

If you were using development or beta versions:

1. **Update dependencies**: Run `npm install` to get latest versions
2. **Check environment variables**: Ensure `OPENL_BASE_URL` is configured correctly
3. **Update client configurations**: Follow the [MCP Connection Guide](docs/setup/mcp-connection-guide.md) for your AI client
4. **Review authentication**: Consider switching to Personal Access Tokens for production

### Breaking Changes

None. This is the first stable release.

---

## What Can You Do?

### Natural Language Commands

Instead of navigating complex interfaces, simply describe what you want:

- *"Show me all premium calculation rules for auto insurance"*
- *"In the Auto rating calculation, reduce the maximum allowed Vehicle Discount cap by 5 percentage points."*
- *"Create a test case for high-risk drivers in California"*
- *"Deploy the latest underwriting rules to production"*
- *"Find all rules that use customer age"*

### Key Benefits

**⚡ Faster Development** - Create and modify rules 3-5x faster using natural language instead of manual editing

**🎯 Easier Testing** - Test rules by describing scenarios in plain language without creating Excel files

**🔍 Better Understanding** - Ask questions about existing rules and get instant explanations

**🚀 Safer Deployments** - Review changes, run tests, and deploy with confidence using conversational commands

**📊 Instant Insights** - Get reports and analysis without learning query languages

### Who Should Use This

**Perfect for:**
- Business Analysts - Create and modify rules without developer help
- QA Teams - Test rules conversationally and get instant results
- Product Owners - Review rule changes and understand impact quickly
- Operations Teams - Deploy rules and monitor production safely
- Subject Matter Experts - Work directly with rules using business language

**Use Cases:**
- Insurance - Underwriting rules, premium calculations, risk assessment
- Banking - Loan approval, fraud detection, compliance rules
- Healthcare - Eligibility determination, claims processing, care pathways
- Retail - Pricing rules, promotion logic, inventory management
- Any Industry - Decision automation, policy enforcement, business logic

---

## Getting Started

### Prerequisites

1. **OpenL Studio Server** - Version 6.0.0 or later
2. **AI Assistant** - Claude Desktop, Cursor IDE, or VS Code with Copilot
3. **Node.js** - Version 24 or later (for non-Docker installations)

### Quick Installation

For complete setup instructions, see the [MCP Connection Guide](docs/setup/mcp-connection-guide.md).


## What's Next

### Planned for v1.1.0 (Q2 2026)

**New Capabilities (5)**
1. **Rule Execution Testing** (`openl_execute_rule`) - Test any rule instantly with custom data
2. **Rule Tracing** (`openl_trace_rule_execution`) - Step-by-step decision path debugging
3. **Dependency Analysis** (`openl_get_table_dependencies`) - Visualize table relationships
4. **Branch Management** (`openl_delete_project_branch`) - Delete obsolete branches safely
5. **Enhanced Project Listing** - Project dependencies in `openl_list_projects`

**Re-enabled Tools (5)**
- `openl_upload_file` - Upload Excel files
- `openl_download_file` - Download Excel files
- `openl_get_file_history` - File-level Git history
- `openl_get_project_history` - Project-level Git history
- `openl_revert_version` - Revert to previous commits

**Total Tool Count**: 25 active tools

---

## Documentation & Resources

### Essential Guides
- [Quick Start Guide](docs/getting-started/quick-start.md) - 5-minute setup
- [MCP Connection Guide](docs/setup/mcp-connection-guide.md) - Cursor, Claude Desktop, VS Code setup
- [Usage Examples](docs/guides/examples.md) - Common workflows
- [Troubleshooting Guide](docs/guides/troubleshooting.md) - Solutions to common issues
- [Authentication Guide](docs/guides/authentication.md) - Security best practices

### Technical Documentation
- [Architecture](docs/development/architecture.md) - System design
- [Contributing Guide](docs/development/contributing.md) - Development workflow
- [Testing Guide](docs/development/testing.md) - Test strategy
- [Tool Review](docs/development/tool-review.md) - API analysis

### External Resources
- [GitHub Repository](https://github.com/openl-tablets/openl-mcp) - Source code
- [OpenL Tablets](https://github.com/openl-tablets/openl-tablets) - Main project
- [MCP Specification](https://modelcontextprotocol.io/) - Protocol docs
- [GitHub Discussions](https://github.com/openl-tablets/openl-mcp/discussions) - Community support

---

## Support

### Getting Help

**For MCP Server issues:**
1. Check the [Troubleshooting Guide](docs/guides/troubleshooting.md)
2. Search [existing issues](https://github.com/openl-tablets/openl-mcp/issues)

**For OpenL Tablets questions:**
- [OpenL Documentation](https://openl-tablets.org/)
- [OpenL Forum](https://github.com/openl-tablets/openl-tablets/discussions)


## About This Release

**Released**: February 23, 2026  
**Version**: 1.0.0  
**License**: LGPL-3.0  
**MCP Protocol**: 1.26.0+  
**Node.js**: ≥24.0.0  

Built by the OpenL Tablets community to bring AI-powered automation to business rules development, testing, and deployment.

---

*For the latest updates and releases, visit the [GitHub repository](https://github.com/openl-tablets/openl-mcp).*
