# Quick Start

Connect your AI assistant to OpenL Studio, so you can ask it to work with your OpenL projects in plain language.

Your **AI client** is the app you chat with — for example **Claude Desktop**, **Codex**, **VS Code (GitHub
Copilot)**, **Cursor**, or **Claude Code**. This guide works with all of them. Wherever you read "your AI client"
below, it means that app.

Your AI client starts the OpenL server for you in the background. You do not install or build anything yourself.

## What you will do

1. Check you have what you need (see below).
2. Create an access token (optional if local OpenL Demo is used).
3. Add the OpenL MCP server configuration to your AI client.
4. Send one test message.

This takes about 5 minutes.

## Before you start

You need:

1. **An AI client** — the app you chat with. This guide sets up Claude Desktop, Codex, VS Code (GitHub Copilot),
   Cursor, or Claude Code.
2. **Your OpenL Studio web address.** Open OpenL Studio in your web browser. The address shown on its home page —
   the one in the browser's address bar — is what you need, for example `http://localhost:8080/webstudio`. Copy it.
   No OpenL Studio yet? Start one with the
   [OpenL Tablets DEMO Setup Guide](https://openl-tablets.github.io/openl-tablets/user-guides/getting-started/demo-package/).
3. **Node.js 24 or newer** — the program that runs the OpenL server on your computer.
   **Claude Desktop** has Node.js built in, so skip this step if you use Claude Desktop. For every other AI client,
   check it in a terminal:
   ```bash
   node -v
   ```
   No version shown? Install it from [nodejs.org](https://nodejs.org/), or skip the install and
   [run the server with Docker](advanced.md#run-with-docker) instead.

## Step 1: Create an access token

> **Skip this step** if your OpenL Studio has no login screen (single-user mode). It accepts requests without a token.

1. Sign in to OpenL Studio.
2. Click your profile icon, then **User Settings → Personal Access Tokens → Create Token**.
3. Give it a name, for example `Claude`.
4. Copy the token now. You see it only once.

The token looks like this: `openl_pat_AbC123.dEf456`.

✅ **Checkpoint:** you have a token that starts with `openl_pat_`. Keep it for Step 2.

## Step 2: Connect your AI client to OpenL MCP Server

Find your AI client below and copy the whole configuration block. Then, in what you pasted:

- Replace `http://localhost:8080/webstudio` with your own OpenL Studio address (from **Before you start**).
- Replace `<your-token>` with the token from Step 1, or
  delete the `OPENL_PERSONAL_ACCESS_TOKEN` env variable definition, if the token is not required.

### Claude Desktop

Open this file (create it if it is missing):

| Your OS | File                                                              |
|---------|-------------------------------------------------------------------|
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |

Put this inside:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080/webstudio"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

Quit Claude Desktop and open it again.

### Codex

Open `~/.codex/config.toml` (create it if it is missing). Add this block:

```toml
[mcp_servers.openl]
command = "npx"
args = ["-y", "openl-mcp", "http://localhost:8080/webstudio"]

[mcp_servers.openl.env]
OPENL_PERSONAL_ACCESS_TOKEN = "<your-token>"
```

Restart Codex.

### VS Code (GitHub Copilot)

You need GitHub Copilot with Agent mode. Open `.vscode/mcp.json` in your project. Put this inside:

```json
{
  "servers": {
    "openl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080/webstudio"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

> `.vscode/mcp.json` is saved with your project. Keep the token out of it — put the token in a
> [user-level config](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) instead.

Open the Copilot Chat **Agent** tools menu and turn on the OpenL tools.

### Cursor

Open `~/.cursor/mcp.json` (for all projects) or `.cursor/mcp.json` (this project only). Put this inside:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080/webstudio"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

Restart Cursor. **Settings → MCP** shows `openl`.

### Claude Code

Run this in a terminal:

```bash
# With a Personal Access Token:
claude mcp add openl --env OPENL_PERSONAL_ACCESS_TOKEN=<your-token> \
  -- npx -y openl-mcp http://localhost:8080/webstudio

# No token (single-user Studio):
claude mcp add openl -- npx -y openl-mcp http://localhost:8080/webstudio
```

Check it: `claude mcp list` shows `openl` as connected.

✅ **Checkpoint:** your AI client lists `openl` as connected. Restart the client first if you have not already.

## Step 3: Test it

In your AI client's chat, type:

```
List repositories in OpenL Studio
```

✅ **Checkpoint:** your AI client runs an OpenL tool and shows your repositories. You are done. 🎉

## If something goes wrong

- **Your AI client does not show `openl`** — check the config has no extra comma, then fully restart the client.
- **"Cannot connect to OpenL"** — open your OpenL Studio address in a web browser to check it works, for example
  `http://localhost:8080/webstudio`.
- **`node` or `npx` not found** — install Node.js (see [Before you start](#before-you-start)), or use Claude Desktop,
  which has Node.js built in.
- **401 / "Authentication failed"** — your Studio needs a token. Add it (Step 1), or check that it has not expired.

More help: [Troubleshooting](troubleshooting.md).
