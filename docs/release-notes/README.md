# Release Notes

This folder contains release notes for OpenL MCP Server versions.

## Structure

Each version has its own file containing the complete release notes:

```
release-notes/
├── README.md                    # This file
├── v1.0.0.md                    # Release notes for 1.0.0
├── v1.1.0.md                    # Release notes for 1.1.0
└── ...
```

## File Naming Convention

`v{major}.{minor}.{patch}.md` - One file per release version
- Examples: `v1.0.0.md`, `v1.1.0.md`, `v2.0.0.md`

## File Contents

Each release notes file contains:

| Section | Purpose |
|---------|---------|
| **Version Header** | Release version, date, and brief overview |
| **New Features** | Comprehensive list of new capabilities |
| **Improvements** | Enhancements to existing functionality |
| **Fixed Bugs** | Issues resolved in this release |
| **Updated Libraries** | Dependency version updates |
| **Known Issues** | Known problems and limitations |
| **Migration Notes** | Upgrade instructions from previous versions |
| **Documentation & Resources** | Links to guides and external resources |

## Template

Each release notes file should follow this structure:

```markdown
# Release Notes - OpenL MCP Server v{version}

**Released**: {Month Day, Year}  
**MCP Protocol**: {version}+  
**Node.js**: ≥{version}  

Brief overview of the release highlighting the most significant changes and new capabilities.

---

## New Features

### {Feature Category Name}

Description and list of new features...

### {Another Feature Category}

...

---

## Improvements

List of enhancements to existing functionality...

---

## Fixed Bugs

List of resolved issues with links to GitHub issues where applicable...

---

## Updated Libraries

### Core Runtime Dependencies

- **{Library Name}** v{version} - Description
- ...

### Testing & Development

- **{Library Name}** v{version} - Description
- ...

---

## Known Issues

### {Category}

- **{Issue Title}** - Description and workaround if available
- ...

---

## Migration Notes

### From {Previous Version}

Step-by-step upgrade instructions...

### Breaking Changes

List of breaking changes that require user action...

---

## Documentation & Resources

Links to relevant documentation...

---

*For the latest updates and releases, visit the [GitHub repository](https://github.com/openl-tablets/openl-mcp).*
```

## Formatting Guidelines

- **Do not generalize** technical details — preserve specific language and details for accuracy
- Use **fenced code blocks** with language identifiers for syntax highlighting (e.g., `json`, `bash`, `typescript`)
- Include **code snippets verbatim**, preserving formatting and indentation
- Use **inline code formatting** for:
  - Tool names: `openl_list_projects`
  - Class names, method names, configuration properties
  - File paths and environment variables
- Use **tables** for structured data (library updates, tool lists, comparison data)
- Use **bold** or *italics* sparingly to emphasize key points
- Do **not use bold** in heading titles
- Use **official product names** with correct casing:
  - OpenL Studio, OpenL Tablets
  - Model Context Protocol (MCP)
  - Claude Desktop, Cursor IDE, VS Code Copilot
  - TypeScript, Node.js, Express
  - Jest, ESLint, Zod, axios

## Links and References

- Link to **GitHub issues** using full URLs: `https://github.com/openl-tablets/openl-mcp/issues/{number}`
- Link to **GitHub releases** using tags: `https://github.com/openl-tablets/openl-mcp/releases/tag/v{version}`
- Use **relative paths** for internal documentation:
  - `../guides/quick-start.md`
  - `../development/architecture.md`
- Include **MCP Protocol specification** links: `https://modelcontextprotocol.io/`
- Reference **OpenL Tablets** resources: `https://openl-tablets.org/`

## Version History

### Current Versions

| Version | Release Date | Highlights |
|---------|--------------|------------|
| [1.1.0](v1.1.0.md) | July 6, 2026 | Surgical table edits, smarter traces, clearer errors, simpler IT setup |
| [1.0.0](v1.0.0.md) | February 23, 2026 | Initial stable release with 40 tools, multi-client support |

### Upcoming Versions

| Version | Planned Date | Expected Features |
|---------|--------------|-------------------|
| 1.2.0 | Q3 2026 | Table dependencies, branch management, batch operations |

## Contributing

When adding release notes for a new version:

1. **Create a new file**: `v{version}.md` (e.g., `v1.1.0.md`)
2. **Copy the template** structure from the most recent version
3. **Add content** following the formatting guidelines above
4. **Update this README** with the new version in the version history table
5. **Update root [RELEASE_NOTES.md](../../RELEASE_NOTES.md)** with links to the new version
6. **Review for accuracy** before committing
7. **Include links** to relevant GitHub issues/PRs where applicable
8. **Test all links** to ensure they work correctly

## Best Practices

- **Be specific**: Include exact version numbers, dates, and technical details
- **Be complete**: Document all significant changes, not just highlights
- **Be clear**: Write for multiple audiences (developers, business analysts, operations)
- **Be consistent**: Follow the template and formatting guidelines
- **Be helpful**: Include examples, code snippets, and migration instructions where needed
- **Be accurate**: Verify all technical information before publishing

---

*For questions or suggestions about release notes, please open an issue or discussion in the [GitHub repository](https://github.com/openl-tablets/openl-mcp).*
