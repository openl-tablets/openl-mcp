# Quick Start

Connect your AI assistant to OpenL Studio. This works with **Claude Code**, **Claude Desktop**, **Cursor**, and
**VS Code (GitHub Copilot)**.

Your AI client starts the server for you. You do not install or build anything first.

## What you will do

1. Check you have three things (see below).
2. Create an access token.
3. Add the server to your AI client.
4. Send one test message.

This takes about 5 minutes.

## Before you start

You need three things:

1. **An AI client** — Claude Code, Claude Desktop, Cursor, or VS Code with GitHub Copilot.
2. **An URL of the running OpenL Studio** — for example `http://localhost:8080/webstudio` or `https://studio.example.com/`.
   No OpenL Studio yet? Bring one up with the [OpenL Tablets DEMO](https://openl-tablets.github.io/openl-tablets/user-guides/getting-started/demo-package/).
3. **Node.js 24 or newer.** Check it in a terminal:
   ```bash
   node -v
   ```
   No version shown? Install it from [nodejs.org](https://nodejs.org/).

> **Do not want to install Node.js?** Run the server with Docker instead. See
> [Run with Docker](advanced.md#run-with-docker), then come back to Step 2. (Claude Code already includes Node.js,
> so you can skip this note.)

## Step 1: Create an access token

> **Skip this step** if your OpenL Studio has no login screen (single-user mode). It accepts requests without a token.

1. Sign in to OpenL Studio.
2. Click your profile icon, then **User Settings → Personal Access Tokens → Create Token**.
3. Give it a name, for example `Claude`.
4. Copy the token now. You see it only once.

The token looks like this: `openl_pat_AbC123.dEf456`.

> **Prefer the browser?** On OAuth2 deployments you can skip the copy/paste and run
> `openl-mcp login <openl-url> --issuer <idp-realm-url>` — it signs you in, mints a token, and
> caches it so the server authenticates automatically. See [Advanced → Sign in from the browser](advanced.md#sign-in-from-the-browser-openl-mcp-login).

✅ **Checkpoint:** you have a token that starts with `openl_pat_`. Keep it for Step 2.

## Step 2: Add the server to your client

Find your client below and copy the whole block. Then:

- Replace `http://localhost:8080` with your OpenL Studio URL.
- Replace `<your-token>` with the token from Step 1.
- **No login (single-user)?** Remove the `env` part (or the `--env` flag).

### Claude Code

Run this in a terminal:

```bash
# With a login token:
claude mcp add openl --env OPENL_PERSONAL_ACCESS_TOKEN=<your-token> \
  -- npx -y openl-mcp http://localhost:8080

# No login (single-user Studio):
claude mcp add openl -- npx -y openl-mcp http://localhost:8080
```

Check it: `claude mcp list` shows `openl` as connected.

### Claude Desktop

Open this file (create it if it is missing):

| Your OS | File |
|---------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Put this inside:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

Quit Claude Desktop and open it again.

### Cursor

Open `~/.cursor/mcp.json` (for all projects) or `.cursor/mcp.json` (this project only). Put this inside:

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

Restart Cursor. **Settings → MCP** shows `openl`.

### VS Code (GitHub Copilot)

You need GitHub Copilot with Agent mode. Open `.vscode/mcp.json` in your project. Put this inside:

```json
{
  "servers": {
    "openl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openl-mcp", "http://localhost:8080"],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

> `.vscode/mcp.json` is saved with your project. Keep the token out of it — put the token in a
> [user-level config](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) instead.

Open the Copilot Chat **Agent** tools menu and turn on the OpenL tools.

✅ **Checkpoint:** restart the client. It lists `openl` as connected.

## Step 3: Test it

In your client's chat, type:

```
List repositories in OpenL Studio
```

✅ **Checkpoint:** the client runs an OpenL tool and shows your repositories. You are done. 🎉

## If something goes wrong

- **Client does not show `openl`** — check the config has no extra comma, then fully restart the client.
- **"Cannot connect to OpenL"** — check the URL works in a browser: `http://localhost:8080`.
- **401 / "Authentication failed"** — your Studio needs a token. Add it (Step 1), or check that it has not expired.

More help: [Troubleshooting](troubleshooting.md).
