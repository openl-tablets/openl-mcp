# Advanced Guide

For power users: server settings, authentication, running with Docker, and the command-line mode. New here?
Start with the [Quick Start](quick-start.md).

## Server settings

The server needs one thing — the OpenL Studio URL. Everything else is optional.

### Base URL

Pass it as the positional `<url>`, with `--base-url`, or via `OPENL_BASE_URL`. Precedence:
**positional `<url>` > `--base-url` > `OPENL_BASE_URL`**.

```bash
npx -y openl-mcp http://localhost:8080          # positional (preferred)
OPENL_BASE_URL=http://localhost:8080 npx -y openl-mcp
```

### Environment variables and flags

Each environment variable has a matching flag that overrides it. Both are read in every run mode — stdio, HTTP, and CLI.

| Environment variable          | Flag                         | Purpose                                 |
|-------------------------------|------------------------------|-----------------------------------------|
| `OPENL_BASE_URL`              | `<url>` / `--base-url <url>` | OpenL Studio URL (required)             |
| `OPENL_PERSONAL_ACCESS_TOKEN` | `--token <pat>`              | Personal Access Token                   |
| `OPENL_TIMEOUT`               | `--timeout <ms>`             | Timeout to REST API, `30000` by default |
| `PORT`                        | `--http <port>`              | HTTP port, `3000` by default            |

### Transports

- **stdio** (default) — the MCP client launches the server; one server per client.
  This is what the [Quick Start](quick-start.md) sets up.
- **HTTP** (`--http` flag) — one long-lived server that several clients share.
  See [Shared HTTP server](#shared-http-server).

### Response format

Every tool accepts `response_format`: `markdown` (default), `json`, `markdown_concise`, `markdown_detailed`.

### Debug logging

All logs go to **stderr**. Set a flag to `true` to turn it on.

| Variable       | Logs                                                         |
|----------------|--------------------------------------------------------------|
| `DEBUG`        | General verbose logging                                      |
| `DEBUG_AUTH`   | Auth detail (adds the failing URL and error code on a `401`) |
| `DEBUG_STOMP`  | The STOMP WebSocket wait (compile status)                    |
| `DEBUG_COOKIE` | Session-cookie handling                                      |

## Authentication

The server runs with or without a token:

- **Single-user OpenL Studio** — no token needed.
- **Multi-user OpenL Studio** — use a **Personal Access Token (PAT)**.

The token always lives **with the client**, never inside the server.

### Create a token

You create a PAT in the OpenL Studio UI; your Studio must use **OAuth2, SAML, or AD** login. Steps are in
[Quick Start → Step 1](quick-start.md#step-1-create-an-access-token).

- Format: `openl_pat_<publicId>.<secret>`.
- Shown **once** — copy it right away.
- Revoke or expire it any time from the UI.

### Sign in from the browser (`openl-mcp login`)

For OAuth2 deployments you can skip the manual copy/paste and let the CLI sign you in:

```bash
openl-mcp login <openl-url> --issuer <idp-realm-url> [--client-id openl-cli]
```

This runs an OAuth 2.0 Authorization Code + PKCE flow (RFC 7636) over a loopback
redirect (RFC 8252): your browser opens, you approve, and the CLI mints a PAT and
caches it at `~/.config/openl-mcp/credentials.json` (mode `0600`), keyed per Studio
URL. The server then picks it up automatically — no `env` token needed.

- `--issuer` is your identity provider's realm URL (e.g. `https://idp.example.com/realms/openlstudio`); also settable via `OPENL_OAUTH_ISSUER`. `--client-id` defaults to `openl-cli` (`OPENL_OAUTH_CLIENT_ID`). Your IdP must register that client as a public client with PKCE and a loopback redirect (`http://127.0.0.1/*`), and issue tokens whose audience Studio accepts.
- Precedence when the server starts: an explicit `OPENL_PERSONAL_ACCESS_TOKEN` / `--token` wins; otherwise a cached login token is used; otherwise the request is anonymous.
- `openl-mcp logout [<openl-url>]` removes the cached token (all servers if the URL is omitted).
- Run `openl-mcp login --no-browser` on a headless host to print the URL instead of opening a browser.

### Where the token goes

**stdio clients** — in the `env` block that launches the server:

```json
"env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
```

**Shared HTTP server** — on the request header (`Bearer` is accepted too):

```text
Authorization: Token <your-token>
```

### Keep it safe

- **Never put the token in the server** — not in `compose.yaml`, host environment, Git, or logs.
- **Use HTTPS** for any remote Studio.
- **Rotate and revoke** tokens you no longer use.

### When auth fails

A `401` usually means the token is wrong, expired, or revoked, or the Studio is not in OAuth2/SAML/AD mode.
Set `DEBUG_AUTH=true` to log the failing URL and error code.

## Run with Docker

There is **no custom MCP image** — Docker just runs the npm package on the official `node:lts-alpine` image when
you don't want to install Node.js.

**Claude Desktop / Cursor** (`mcp.json`):

```json
{
  "mcpServers": {
    "openl": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "OPENL_PERSONAL_ACCESS_TOKEN",
        "node:lts-alpine",
        "npx", "-y", "openl-mcp", "http://host.docker.internal:8080"
      ],
      "env": { "OPENL_PERSONAL_ACCESS_TOKEN": "<your-token>" }
    }
  }
}
```

For **VS Code**, use the same `command`/`args`/`env` under `"servers"` with `"type": "stdio"`
(see [Quick Start](quick-start.md#vs-code-github-copilot)).

Two differences from the plain `npx` setup:

- **Use `host.docker.internal`, not `localhost`**, so the container can reach a Studio on your machine. On Linux,
  also add `"--add-host", "host.docker.internal:host-gateway"`.
- **Single-user Studio?** Drop the `-e OPENL_PERSONAL_ACCESS_TOKEN` parts and the `env` block.

### Full-stack demo

Run OpenL Studio **and** the MCP server together with [`compose.yaml`](../../compose.yaml):

```bash
docker compose up -d
```

- OpenL Studio → `http://localhost:8080` (single-user mode)
- MCP server → `http://localhost:3000/mcp` (HTTP transport)

```bash
curl http://localhost:3000/health    # {"status":"ok",...}
docker compose logs -f openl-mcp      # follow the MCP server logs
docker compose down                   # stop everything
```

### Shared HTTP server

To run one long-lived server several clients share, start it with `--http` and publish the port:

```bash
docker run --rm -it -p 3000:3000 node:lts-alpine npx -y openl-mcp http://host.docker.internal:8080 --http
```

Clients then connect to `http://localhost:3000/mcp` with the HTTP transport:

```json
{
  "servers": {
    "openl": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Token <your-token>" }
    }
  }
}
```

Omit `headers` for a single-user Studio. For remote access, put the server behind TLS and use `https://…/mcp` so
the token isn't sent in the clear.

In `--http` mode the server uses the MCP **Streamable HTTP** transport (MCP spec 2025-11-25).
It does not support deprecated SSE transport. The path to the next protocol revision
(2026-07-28) is planned in the [MCP Spec Alignment Plan](../development/mcp-spec-alignment.md).

### Docker tips

- **Container can't reach the Studio** — use `host.docker.internal`, not `localhost` (on Linux add
  `--add-host=host.docker.internal:host-gateway`).
- **Port in use** — change the published port, e.g. `-p 3001:3000`.
- **First start is slow** — `npx` downloads the package on each fresh container (later runs reuse the image layer
  but re-fetch the package).

## CLI mode

The same binary doubles as a command-line tool for direct API calls — handy for scripting, CI/CD, or debugging one
call without an MCP client. Give it a tool name (or a discovery flag) and it runs in CLI mode; give it nothing (or
just a URL) and it starts the stdio server.

```bash
# Discover (no config needed)
npx -y openl-mcp --help                       # human catalog
npx -y openl-mcp --list-tools | jq '.[].name' # machine-readable

# One call — markdown by default
npx -y openl-mcp http://localhost:8080 list_repositories --token <your-token>

# JSON for jq pipelines
npx -y openl-mcp http://localhost:8080 \
  list_projects '{"status":"OPENED","response_format":"json"}' \
  --token <your-token> | jq '.data[].name'
```

Key points:

- **Tool names drop the `openl_` prefix** — `list_repositories`, not `openl_list_repositories`.
- Pass arguments as inline JSON, `@file.json`, or `--stdin`.
- Output is **markdown** by default; request `response_format: "json"` to pipe into `jq`.
- Auth: `--token` or `OPENL_PERSONAL_ACCESS_TOKEN` (omit for a single-user server).
- Exit codes follow `sysexits.h` (e.g. `77` = auth failure, `78` = bad config) so CI can tell apart don't-retry
  from might-retry failures.

Full reference — every flag, argument-passing modes, recipes, exit codes, and cross-platform notes:
**[CLI Guide](cli.md)**.
