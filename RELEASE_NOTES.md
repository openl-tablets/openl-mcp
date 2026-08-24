# Release Notes - OpenL MCP Server

This document provides an overview of all OpenL MCP Server releases. For detailed release notes, see the version-specific files in the [docs/release-notes/](docs/release-notes/) folder.

---

## Latest Release

### [Version 1.2.0](docs/release-notes/v1.2.0.md) - August 24, 2026

**Highlights:**
- 🧩 Interactive rule debugger replaces the old trace tools: breakpoints, step in/out/over, live frame inspection, and cell watching across a whole run
- 🌿 Branch and merge management: repository-wide merge-target discovery, read-only BASE/OURS/THEIRS conflict inspection, and confirmed branch/project deletion
- 🔗 Table dependency graph with datatype/vocabulary relationships, filterable by project layer
- ▶️ Run a table directly with a bounded, deduplicated workflow (`openl_run_table`)
- ✅ Markdown test results now identify the failing test unit with expected vs. actual values
- ⚠️ **Breaking**: tool responses default to structured JSON instead of Markdown; tables are exposed only as `RawSource`; two tool signatures require a stable `projectId`; `openl_resolve_merge_conflicts` is removed; browser-based login/logout and the credential cache are removed (PAT-only auth)
- 🔐 Optional server-side tool allow-list (`OPENL_MCP_TOOLS`) and OAuth2 Bearer-scheme passthrough (`OPENL_MCP_PRESERVE_AUTH_SCHEME`)
- 🏷️ `openl_get_version` ties a running server to its exact build (commit, branch/tag, build time)

Built on MCP TypeScript SDK v2.0.0 with negotiation for the modern 2026-07-28 protocol (legacy 2025-06-18 retained). 74 tools, up from 56 in v1.1.0 — 23 added, 5 removed.

**Upgrading from v1.1.0 requires code changes** — see the [Breaking Changes and Migration Notes](docs/release-notes/v1.2.0.md#breaking-changes--read-first) before you upgrade.

[Read Full Release Notes →](docs/release-notes/v1.2.0.md)

---

## All Releases

### Version 1.2.0 - August 24, 2026
Interactive rule debugger, branch/merge management, table dependency graph, and several breaking changes (structured JSON by default, RawSource-only tables, PAT-only auth).
[View Details →](docs/release-notes/v1.2.0.md)

### Version 1.1.0 - July 6, 2026
Major update with 52 tools, CLI mode, simplified deployment, Streamable HTTP transport, and automatic table ID resolution.
[View Details →](docs/release-notes/v1.1.0.md)

### Version 1.0.0 - February 23, 2026
Initial stable release with complete MCP integration, 40 tools, and multi-client support.
[View Details →](docs/release-notes/v1.0.0.md)

---

## Upcoming Releases

### Next release (tracking [EPBDS-16132](https://jira.eisgroup.com/browse/EPBDS-16132))

v1.2.0 delivered most of this epic's scope. What's left:

1. **Installable plugin packaging** - agent onboarding, skills, and MCP server configuration bundled as a single distributable unit for AI coding agents (Claude Code, Microsoft 365 Copilot, and others)
2. **Auto-generated `AGENTS.md`** - generate project guidance from project structure instead of writing it by hand
3. **Tracing skill packaging** - package the new interactive debugger workflow as a bundled skill

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
