# Claude AI Agent Configuration

This document provides instructions for configuring Claude AI to work with OpenL MCP Server.

**👉 See [AGENTS.md](./AGENTS.md) for complete agent configuration guide.**

The AGENTS.md file contains:
- Complete agent capabilities and tools
- Security best practices for AI agents
- Configuration instructions for Claude Desktop and Cursor IDE
- Usage examples and workflows
- All prompts and expert guidance templates

## Quick Links

- **[AGENTS.md](./AGENTS.md)** - Complete agent configuration guide
- **[Setup Guide](docs/setup/mcp-connection-guide.md)** - Connect Claude Desktop to MCP server
- **[Quick Start](docs/getting-started/quick-start.md)** - Get started quickly

## Code Quality

- Keep the code clean at all times: no dead code (unused files, exports, functions, variables, or unreachable branches) and no unused dependencies. Remove them as soon as they become orphaned.
- Add a third-party library only when it brings significant benefit — that is, it substantially reduces the code we would otherwise write and maintain. Prefer reimplementing small or simple functionality over taking on a dependency.
- When a library is used, keep it on the latest version that is practical for the project.

## Documentation

- Keep all documentation up to date with every code change. When a change adds, removes, or alters tools, prompts, dependencies, configuration, or behavior, update the affected docs in the same change — never leave them for later.
- This covers every document, not just the README: `AGENTS.md`, the `README*.md` files, everything under `docs/`, the prompt files in `prompts/`, and the spec docs under `.specify/`.
- Remove obsolete information rather than letting it accumulate: no references to removed tools, prompts, or APIs, and no stale counts, examples, or links.

## Git Commits

- Commit every completed piece of work.
- Write a short, meaningful subject that answers *why* the change was made, not *what* changed — the "what" is already visible in the diff and history.
- The subject should explain the benefit to a user or a developer.
- Add an extended body only when the subject alone cannot convey the meaning gracefully.
- Do NOT add a `Co-Authored-By: Claude` trailer (or any co-author trailer) to commit messages.

## Pull Requests

- Before creating a pull request, add an entry to [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` (in the matching `### Added` / `### Fixed` / etc. section, following the Keep a Changelog format).
- Keep changelog entries short and to the point — describe the user-facing change, not the implementation. No deep technical details.
