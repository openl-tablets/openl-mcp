# OpenL Skills for Claude

Skills are pre-built assistants that teach Claude how to help you with specific OpenL tasks. Once installed, you can ask Claude to trace a calculation, investigate a wrong result, or debug a rule — and it will know exactly what to do.

## Available skills

| Skill | What it does |
|---|---|
| [openl-trace-investigation](./openl-trace-investigation/SKILL.md) | Investigates why OpenL produced an unexpected result — wrong premium, rejected claim, null value, or incorrect decision. Requires the OpenL MCP server to be running. |

## How to install a skill

**Step 1 — Download the skill folder**

On this page, navigate into the skill you want (e.g. `openl-trace-investigation`) and download the entire folder to your computer. You can do this by cloning the repository or asking your developer to download it for you.

**Step 2 — Place it in the right location**

Claude looks for skills in a specific folder on your computer:

- **Mac/Linux:** `~/.claude/skills/`
- **Windows:** `%USERPROFILE%\.claude\skills\`

Copy the downloaded skill folder (e.g. `openl-trace-investigation`) into that location. The result should look like:

```text
~/.claude/skills/
└── openl-trace-investigation/
    └── SKILL.md
```text

If the `.claude/skills/` folder does not exist yet, create it — or ask your developer to do this step.

**Step 3 — Use it**

Open Claude Code and either:
- Type `/<skill-name>` to start the skill directly (e.g. `/openl-trace-investigation`), or
- Describe your problem in plain language and Claude will pick up the relevant skill automatically.

## Requirements

These skills require the [OpenL MCP server](../README.md) to be running and connected to Claude Code. Contact your administrator if you are unsure whether it is set up.
