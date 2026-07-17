# CLI Mode

`openl-mcp` is primarily an MCP server, but the **same binary** is also a command-line tool for direct API
calls — handy for scripting, CI/CD, or debugging one tool call without an MCP client. New here? Start with the
[Quick Start](quick-start.md).

CLI mode is **agent-first**: an LLM agent shells out to the binary and reads the default **markdown** output
directly. Everything the MCP server can do is available here, with the same tools, schemas, validation, and
formatting.

## CLI vs. server mode

The mode is chosen per process from the arguments:

- **CLI** — a tool name, or a discovery flag (`--help`, `--list-tools`, `--version`).
- **Server** — no arguments, or just a base `<url>`. Starts the MCP stdio server that clients launch.

Use CLI for scripts, CI/CD, and one-off debugging; use server mode for multi-turn sessions where the client picks
tools. `--cookie-jar` (below) covers most stateful flows in CLI mode too.

## Invocation

```text
openl-mcp <url> <tool> [args] [flags]     # base URL as a positional argument
openl-mcp <tool> [args] [flags]           # base URL via --base-url / OPENL_BASE_URL
openl-mcp <tool> --help                   # one tool's description + schema
openl-mcp --help | --list-tools | --version
```

Run it with `npx -y openl-mcp …` (no install), a global install (`npm i -g openl-mcp`), or a clone
(`node dist/index.js …`).

**Tool names drop the `openl_` prefix on the CLI** — type `list_repositories`, not `openl_list_repositories`.
The prefix is added only on the MCP wire; the registry, `--help`, and `--list-tools` all use bare names.

## Discovery

All three work without config or credentials, and are the source of truth for the current tool set:

| Command | Output |
|---|---|
| `--help` | usage, flags, and a catalog of tool **titles** by category |
| `<tool> --help` | that tool's full description and argument schema |
| `--list-tools` | JSON array (`name` / `title` / `description` / `inputSchema`) — the CLI's `tools/list` |

```bash
npx -y openl-mcp --help
npx -y openl-mcp update_table --help
npx -y openl-mcp --list-tools | jq '.[].name'
```

`--list-tools` reports **bare** names, so filter on the bare name:

```bash
npx -y openl-mcp --list-tools | jq '.[] | select(.name=="update_table") | .inputSchema'
```

## Configuration

Every setting has an env var and a matching flag; precedence is **flag > env > default**. The base URL also
accepts a positional `<url>` that wins over `--base-url` — it may sit before or after the tool name, and a
bareword `http(s)` URL is always the base URL, never a tool name.

| Env var | Flag | Default | Purpose |
|---|---|---|---|
| `OPENL_BASE_URL` | `<url>` / `--base-url` | — (required) | OpenL Studio URL, e.g. `http://localhost:8080` |
| `OPENL_PERSONAL_ACCESS_TOKEN` | `--token` | — | PAT (`openl_pat_…`); omit for anonymous |
| `OPENL_TIMEOUT` | `--timeout` | `30000` | Per-request timeout (ms) |
| — | `--cookie-jar <path>` | — | Persist `JSESSIONID` between calls (see [Trace flows](#trace-flows-cookie-jar)) |

## Authentication

Auth is **optional**: `--token` / `OPENL_PERSONAL_ACCESS_TOKEN` when supplied, otherwise anonymous (no
`Authorization` header). A server that requires auth answers `401`, which the CLI reports as exit code `77`.

```bash
npx -y openl-mcp list_repositories --token <your-token>   # explicit PAT
npx -y openl-mcp list_repositories                        # anonymous (single-user Studio)
```

Create a PAT in OpenL Studio under **User Settings → Personal Access Tokens**. Details
in [Authentication](advanced.md#authentication).

> Passing `--token` puts the secret in process listings (`ps aux`). Prefer an env var on shared hosts.

## Passing tool arguments

Each tool takes one JSON object matching its schema. Provide it **one** of three ways (mutually exclusive), or
omit it entirely for tools with no required fields:

```bash
npx -y openl-mcp list_projects '{"status":"OPENED","limit":10}'   # inline JSON
npx -y openl-mcp save_project @save.json                          # from a file
echo '{"projectId":"…"}' | npx -y openl-mcp get_project --stdin   # from stdin
```

Use `@file.json` or `--stdin` for large payloads (e.g. `update_table`, `append_table`) and to sidestep
shell-quoting issues.

## Output format

Output defaults to **markdown**, the same as the MCP server. For machine-parseable output — piping into `jq` —
request JSON in the args:

```bash
npx -y openl-mcp list_projects '{"response_format":"json"}' | jq '.data[].name'
```

Formats: `markdown` (default), `markdown_concise`, `markdown_detailed`, `json`. Rule of thumb: **whenever you pipe
into `jq`, ask for `"response_format":"json"`** — otherwise `jq` receives markdown and errors. (`--list-tools` is
always JSON regardless.)

## Trace flows (cookie jar)

The **trace debugger** tools keep the debug session on the server keyed by `JSESSIONID`: `start_trace` sets the
cookie, and later `step_trace` / `inspect_trace_frame` / `stop_trace` must send the same one. Each `npx` run is a
fresh process, so pass `--cookie-jar <path>` consistently across the flow — the CLI loads the cookie before each
call and saves any the server sets.

```bash
JAR=/tmp/trace-$$.jar
trap 'rm -f $JAR' EXIT

npx -y openl-mcp start_trace         --cookie-jar $JAR '{"projectId":"…","tableId":"calcPremium_42"}'
npx -y openl-mcp step_trace          --cookie-jar $JAR '{"projectId":"…","type":"out"}'
npx -y openl-mcp inspect_trace_frame --cookie-jar $JAR '{"projectId":"…","frameIndex":0}'
npx -y openl-mcp stop_trace          --cookie-jar $JAR '{"projectId":"…"}'
```

- The jar is bound to the server URL and user, written `0600`, and never replayed for a different server or user
  (Windows ignores Unix modes — keep the jar out of shared directories).
- A missing jar just means "fresh session"; stateless tools write nothing. Read/write problems warn on stderr but
  don't fail the call.
- Use one jar per flow (e.g. `$$` = shell PID) to avoid clashes between parallel scripts.

## Exit codes

Follows BSD [`sysexits.h`](https://man7.org/linux/man-pages/man3/sysexits.h.3head.html) so CI can tell
*don't-retry* failures from *might-retry* ones. The human-readable message goes to stderr.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unclassified failure |
| `64` | Bad CLI usage — unknown flag, missing tool name, multiple argument sources |
| `65` | Bad tool input — malformed JSON, or an unreadable `@file` |
| `69` | Server/network unavailable — `ECONNREFUSED`, `ETIMEDOUT`, DNS failure, 5xx |
| `77` | Auth failure — 401 / 403 |
| `78` | Bad configuration — missing `OPENL_BASE_URL`, or an invalid URL or timeout |

## Scripting recipes

```bash
# Save a project, using the last commit subject as the message
npx -y openl-mcp save_project @<(jq -n \
  --arg id "$PROJECT_ID" --arg msg "$(git log -1 --format=%s)" \
  '{projectId:$id, comment:$msg}')

# Generate a per-tool wrapper script for every tool
npx -y openl-mcp --list-tools | jq -r '.[].name' | while read -r tool; do
  printf '#!/usr/bin/env bash\nexec npx -y openl-mcp %s "$@"\n' "$tool" > "$HOME/bin/$tool"
  chmod +x "$HOME/bin/$tool"
done
```

## Cross-platform notes

- **Windows `cmd.exe`** doesn't strip single quotes — use `@file.json`, or escape: `"{\"status\":\"OPENED\"}"`.
- **PowerShell**: `@{ status='OPENED' } | ConvertTo-Json -Compress | % { npx -y openl-mcp list_projects $_ }`.
- `--stdin` is the most portable way to pass a payload.

## Security

- Prefer env vars over `--token` on shared hosts (the flag value shows in `ps aux`).
- The cookie jar holds a session id — `0600` is applied automatically; don't share or commit it.
- Errors written to stderr are sanitized: PATs and credentials are redacted.
- In CI, inject secrets from your platform's secret store; don't commit `.env` files.

## Troubleshooting

- **`OPENL_BASE_URL is required`** — set the env var or pass `--base-url` (`--help` / `--list-tools` don't need it).
- **`Failed to parse tool arguments as JSON`** — malformed JSON; use `@file.json` or `--stdin` to dodge shell quoting.
- **`Unknown tool: …`** — a typo, or a temporarily disabled tool. `--list-tools` is the source of truth for the active set.
- **Output isn't JSON** — the default is markdown; pass `"response_format":"json"`.
- **`step_trace` / `inspect_trace_frame` answer 404 (no debug session) after `start_trace`** — you're missing `--cookie-jar`; see [Trace flows](#trace-flows-cookie-jar).

More: [general troubleshooting](troubleshooting.md).
