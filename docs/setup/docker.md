# Running with Docker (no Node.js required)

There is **no custom MCP image**. The server is the npm package
[`openl-mcp-server`](https://www.npmjs.com/package/openl-mcp-server), and Docker is
just a way to run it when you don't want to install Node.js: the official
`node:lts-alpine` image runs `npx`, and the container is thrown away on exit.

Three ways to use it:

| Goal | Use |
|------|-----|
| One MCP client, no Node.js on the machine | [One-off stdio container](#one-off-stdio-container) |
| Try the whole stack (Studio + MCP) in one command | [Full-stack demo](#full-stack-demo) |
| One shared server several clients connect to over HTTP | [Standalone HTTP server](#standalone-http-server) |

## One-off stdio container

This is what an MCP client launches per session when Node.js isn't installed:

```bash
docker run --rm -i node:lts-alpine npx -y openl-mcp-server http://host.docker.internal:8080
```

You don't normally run this by hand — you put it in your client's config. See the
[Running without Node.js (Docker)](mcp-connection-guide.md#running-without-nodejs-docker)
section of the connection guide for the per-client `command`/`args`.

> Use `host.docker.internal` (not `localhost`) so the container can reach an OpenL
> Studio running on the host. On Linux, add `--add-host=host.docker.internal:host-gateway`.

## Full-stack demo

Run OpenL Studio **and** the MCP server together with one file —
[`compose.yaml`](../../compose.yaml). The MCP service is plain `node:lts-alpine`
running `npx`, no build step:

```bash
docker compose up -d
```

This starts:

- **OpenL Studio** at `http://localhost:8080` (single-user mode — no auth needed)
- **MCP Server** at `http://localhost:3000/mcp` (HTTP transport)

Verify, then connect a client to the HTTP endpoint (see
[Standalone HTTP server](#standalone-http-server) for how clients connect):

```bash
curl http://localhost:3000/health   # {"status":"ok",...}
open http://localhost:8080
```

Useful commands:

```bash
docker compose logs -f openl-mcp   # follow MCP logs
docker compose down                 # stop everything
```

## Standalone HTTP server

To run one long-lived server that several clients share, start it in HTTP mode
with `--http` and publish the port:

```bash
docker run --rm -it -p 3000:3000 node:lts-alpine \
  npx -y openl-mcp-server http://host.docker.internal:8080 --http
```

| Part | Meaning |
|------|---------|
| `--rm` | Remove the container when it stops |
| `-it` | Interactive terminal (so you can see logs / `Ctrl+C` to stop) |
| `-p 3000:3000` | Publish the server's port to the host (omit and it's unreachable) |
| `node:lts-alpine` | Official Node image — no custom build |
| `npx -y openl-mcp-server` | Fetch and run the package |
| `http://host.docker.internal:8080` | OpenL Studio URL (positional argument) |
| `--http` | Serve MCP over HTTP at `/mcp` instead of stdio |

Clients then connect to `http://localhost:3000/mcp`. Configure them with the
HTTP/streamable-http transport — for VS Code, for example:

```json
{
  "servers": {
    "openl": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Token <your-pat-token>" }
    }
  }
}
```

Omit `headers` for a single-user OpenL Studio. For remote/non-localhost access,
put the server behind TLS and use `https://…/mcp` so the token isn't sent in the
clear.

## Configuration

| Variable / flag | Purpose | Default |
|-----------------|---------|---------|
| positional `<url>` or `OPENL_BASE_URL` | OpenL Studio API URL (positional wins) | — (required) |
| `--http` | Serve over HTTP instead of stdio | stdio |
| `PORT` | HTTP port (with `--http`) | `3000` |

> **Authentication is per client, never baked into the server.** In stdio mode the
> token comes from the client's `env` (`OPENL_PERSONAL_ACCESS_TOKEN`); in HTTP mode
> it comes from the client's `Authorization: Token <pat>` header. See the
> [Authentication Guide](../guides/authentication.md).

## HTTP endpoints

In `--http` mode the server speaks the MCP **Streamable HTTP** transport
(MCP spec 2025-11-25) at a single endpoint:

```text
POST   /mcp   — send a JSON-RPC message (`initialize` opens a session)
GET    /mcp   — open the server→client stream for an established session
DELETE /mcp   — terminate a session
GET    /health — unauthenticated liveness probe
```

All requests except `initialize` must carry the `mcp-session-id` header returned by
`initialize`. The base URL always comes from the server's positional `<url>` /
`OPENL_BASE_URL`; the client supplies only the token.

## Troubleshooting

- **Container can't reach OpenL Studio** — use `host.docker.internal`, not
  `localhost`; on Linux add `--add-host=host.docker.internal:host-gateway`.
- **Port 3000 in use** — change the published port, e.g. `-p 3001:3000`.
- **First start is slow** — `npx` downloads the package on each fresh container;
  subsequent runs reuse the image layer but re-fetch the package.

More: [Troubleshooting Guide](../guides/troubleshooting.md).

## Additional Resources

- [Quick Start](../getting-started/quick-start.md)
- [MCP Connection Guide](mcp-connection-guide.md) — per-client setup
- [Authentication Guide](../guides/authentication.md)
