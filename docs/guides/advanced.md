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

Most environment variables have a matching flag that overrides them, and are read in every run mode — stdio, HTTP, and CLI — except where the table notes otherwise (e.g. `MCP_MAX_BODY_SIZE` applies to the HTTP transport only).

| Environment variable          | Flag                         | Purpose                                              |
|-------------------------------|------------------------------|------------------------------------------------------|
| `OPENL_BASE_URL`              | `<url>` / `--base-url <url>` | OpenL Studio URL (required)                          |
| `OPENL_PERSONAL_ACCESS_TOKEN` | `--token <pat>`              | Personal Access Token                                |
| `OPENL_TIMEOUT`               | `--timeout <ms>`             | Timeout to REST API, `30000` by default              |
| `PORT`                        | `--http <port>`              | HTTP port, `3000` by default                         |
| `MCP_MAX_BODY_SIZE`           | —                            | Max HTTP request-body size, `5mb` by default (HTTP transport only; e.g. a large trace `inputJson`) |

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

The token is the only credential the server understands: an explicit
`OPENL_PERSONAL_ACCESS_TOKEN` / `--token` when present, otherwise requests are
anonymous (single-user Studio). A blank/whitespace token is treated as absent, so an
empty setting never sends an empty credential. (Browser sign-in — `openl-mcp login`
with its `~/.config/openl-mcp/credentials.json` cache — existed in the 1.1.0 release
and has been removed.)

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
It does not support deprecated SSE transport.

### Docker tips

- **Container can't reach the Studio** — use `host.docker.internal`, not `localhost` (on Linux add
  `--add-host=host.docker.internal:host-gateway`).
- **Port in use** — change the published port, e.g. `-p 3001:3000`.
- **First start is slow** — `npx` downloads the package on each fresh container (later runs reuse the image layer
  but re-fetch the package).

## CLI mode

The same binary doubles as a command-line tool: give it a tool name
(`npx -y openl-mcp <url> list_repositories`) and it makes one direct API call instead
of starting the server — handy for scripting, CI/CD, or debugging. Full reference —
configuration, flags, argument passing, output formats, recipes, and exit codes:
**[CLI Guide](cli.md)**.
