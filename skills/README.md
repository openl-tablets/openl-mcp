# Skills

This directory contains Claude Code skills for working with OpenL Tablets via the OpenL MCP server.

## What are skills?

Skills are reusable instruction sets for Claude Code. When installed, they can be invoked explicitly with `/skill-name` or triggered automatically when your prompt matches the skill's description.

## Installation

Each skill lives in its own subdirectory. To install a skill, copy its directory to your local Claude skills folder:

```bash
# Install globally (available in all projects)
cp -r skills/openl-trace-investigation ~/.claude/skills/

# Or install per-project (available in this project only)
cp -r skills/openl-trace-investigation .claude/skills/
```

Then invoke it in Claude Code:

```
/openl-trace-investigation
```

Or just describe your problem — Claude will trigger the skill automatically when relevant.

## Available skills

| Skill | Description |
|---|---|
| [openl-trace-investigation](./openl-trace-investigation/SKILL.md) | Investigate and debug OpenL Tablets rule execution — wrong results, unexpected nulls, failed lookups, incorrect decisions. Requires the `openl-mcp-server` MCP tool to be connected. |

## Requirements

Skills in this directory require the [OpenL MCP server](../README.md) to be running and connected to Claude Code.
