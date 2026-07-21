# Release Notes - OpenL MCP Server

This document provides an overview of all OpenL MCP Server releases. For detailed release notes, see the version-specific files in the [docs/release-notes/](docs/release-notes/) folder.

---

## Latest Release

### [Version 1.1.0](docs/release-notes/v1.1.0.md) - July 6, 2026

**Highlights:**
- 🚀 52 production-ready tools (up from 40) with 11 new raw table-source action tools
- 🖥️ CLI mode for direct tool execution from shell without MCP client
- 📦 Simplified deployment via `npx` - no custom Docker image required
- 🔄 Streamable HTTP transport (MCP spec 2025-11-25) replaces legacy HTTP+SSE
- 🎯 Automatic table ID resolution after relocating edits
- ⏱️ Server-side trace waiting eliminates polling in agent workflows
- 🛡️ Pre-write validation and detailed error messages for better agent recovery
- 🔐 Removed Basic Auth and query-parameter credentials (PAT only)
- 📊 Enhanced project creation with atomic clone mode
- 🐛 Zero npm audit vulnerabilities

Built on Model Context Protocol v1.29.0, this release focuses on improving the agent experience with automatic error recovery, seamless multi-step operations, and comprehensive table manipulation capabilities.

[Read Full Release Notes →](docs/release-notes/v1.1.0.md)

---

## All Releases

### Version 1.1.0 - July 6, 2026
Major update with 52 tools, CLI mode, simplified deployment, Streamable HTTP transport, and automatic table ID resolution.  
[View Details →](docs/release-notes/v1.1.0.md)

### Version 1.0.0 - February 23, 2026
Initial stable release with complete MCP integration, 40 tools, and multi-client support.  
[View Details →](docs/release-notes/v1.0.0.md)

---

## Upcoming Releases

### Planned for v1.2.0 (Q3 2026)

**New Capabilities:**
1. **Table Dependencies** (`openl_get_table_dependencies`) - Visualize relationships and impact analysis
2. **Branch Management** (`openl_delete_project_branch`) - Clean up obsolete branches safely
3. **Project Dependencies** - Enhanced `openl_list_projects` with dependency graph
4. **Batch Operations** - Multi-table edits in single transaction

---

## Documentation & Resources

### Essential Guides
- [Quick Start Guide](docs/guides/quick-start.md) - 5-minute setup
- [Run with Docker](docs/guides/advanced.md#run-with-docker) - No Node.js required
- [Usage Examples](docs/guides/examples.md) - Common workflows
- [Troubleshooting Guide](docs/guides/troubleshooting.md) - Solutions to common issues

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

---

*For the latest updates and releases, visit the [GitHub repository](https://github.com/openl-tablets/openl-mcp).*
