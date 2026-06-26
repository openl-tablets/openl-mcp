# openl-mcp — CLI mode

`openl-mcp` is primarily an [MCP](https://modelcontextprotocol.io/) server for Claude Desktop, Cursor, and other LLM clients. The **same binary** also doubles as a command-line tool for direct API calls — useful when you want to script OpenL Studio operations, integrate into CI/CD, or debug a single tool invocation from your shell without spinning up an MCP client.

CLI mode is **agent-first**: the primary consumer is an LLM agent that shells out to the binary (the human operator is the secondary audience). That shapes the defaults — output is **markdown** by default (LLMs parse it more naturally and token-efficiently than escaped JSON), and discovery is split into a human-readable catalog (`--help`) and a machine-readable schema dump (`--list-tools`).

Internally, CLI mode reuses the same tool registry, Zod input validation, response formatters, and error handling as the MCP server: anything Claude can do through MCP, you can do from a shell — with identical tool surface, titles, and schemas.

---

## Contents

- [When to use CLI mode](#when-to-use-cli-mode)
- [Quick start](#quick-start)
- [Invocation](#invocation)
- [Discovery](#discovery)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Passing tool arguments](#passing-tool-arguments)
- [Output format](#output-format)
- [Scripting & JSON extraction](#scripting--json-extraction)
- [Session-coupled flows: `--cookie-jar`](#session-coupled-flows---cookie-jar)
- [Recipes](#recipes)
- [Exit codes](#exit-codes)
- [Cross-platform notes](#cross-platform-notes)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## When to use CLI mode

Use CLI mode when:

- **An LLM agent** drives operations by shelling out to the binary (the primary, agent-first case) — it reads the default markdown output directly, no JSON tooling needed.
- You're building **CI/CD** automation (deploy a project, run tests, check status).
- You're **debugging** a single API call without launching Claude Desktop / Cursor.
- You want to **integrate** OpenL Studio into shell scripts, cron jobs, or Makefiles — extracting fields with `jq`/`grep` (request `response_format:"json"` for these; see [Scripting & JSON extraction](#scripting--json-extraction)).

Use MCP mode (the default — pass no arguments) when:

- An MCP client (Claude Desktop, Cursor) drives the session over the MCP protocol.
- You need **multi-turn** conversations where Claude chooses tools dynamically.
- You're walking through a stateful flow that benefits from session continuity (although `--cookie-jar` covers most of this in CLI mode too — see below).

The two modes are **mutually exclusive per process**: invoking the binary with a tool name (or a discovery flag like `--help`) routes to CLI; with no arguments — or with just a base `<url>` and no tool name — it starts the MCP stdio server.

---

## Quick start

```bash
# 1. Discovery — works without any config
npx -y openl-mcp --help                          # human catalog (titles)
npx -y openl-mcp --list-tools | jq '.[].name'    # machine-readable

# 2. Single call — base URL as a positional argument (markdown by default)
npx -y openl-mcp https://studio.example.com \
  list_repositories --token openl_pat_…

#    …or with env-based config
export OPENL_BASE_URL=https://studio.example.com
export OPENL_PERSONAL_ACCESS_TOKEN=openl_pat_…
npx -y openl-mcp list_repositories

# 3. Add response_format=json when you want to pipe into jq
npx -y openl-mcp https://studio.example.com \
  list_projects '{"response_format":"json"}' \
  --token openl_pat_… \
  | jq '.data[] | {name, status}'
```

---

## Invocation

```text
openl-mcp <url> <tool-name> [args] [flags]   # base URL as a positional argument
openl-mcp <tool-name> [args] [flags]         # base URL via --base-url / OPENL_BASE_URL
openl-mcp --help
openl-mcp --list-tools
openl-mcp <url>                    # just a URL, no tool → MCP stdio server
openl-mcp                          # no args → MCP stdio server (uses OPENL_BASE_URL)
```

The OpenL Studio base URL can be given as a **positional argument** (in any position relative to the tool name), via `--base-url`, or via `OPENL_BASE_URL` — see [Configuration](#configuration) for precedence.

**Tool names drop the `openl_` prefix on the CLI.** The namespace prefix that keeps tools distinct across servers is just noise in a shell, so the CLI uses bare names — `list_repositories`, not `openl_list_repositories` (the prefixed form is not accepted). The prefix is a protocol-boundary concern: the tool registry and the CLI (`--help`, `--list-tools`, and what you type) use bare names; only the MCP `tools/list` / `tools/call` wire adds and strips the `openl_` prefix.

You can invoke the binary three ways:

| Method | Example |
|---|---|
| One-shot via `npx` (no install) | `npx -y openl-mcp <url> <tool-name> …` |
| Globally installed | `npm i -g openl-mcp && openl-mcp <url> <tool-name> …` |
| From a clone | `node /path/to/dist/index.js <url> <tool-name> …` |

> **Tip.** `npx -y` skips the prompt to install missing packages; safe to use in scripts.

---

## Discovery

Discovery is deliberately split by audience — all three work without credentials:

| Command | Audience | Output |
|---|---|---|
| `--help` | human (operator configuring the agent) | usage + flags + catalog of tool **titles** grouped by category |
| `<tool> --help` | human + agent | that tool's full description + argument schema |
| `--list-tools` | **agent** (programmatic introspection) | JSON array — `name` / `title` / `description` / `inputSchema` |

`--list-tools` is the CLI's equivalent of MCP's `tools/list`: an agent that shells out instead of speaking the MCP protocol uses it to discover capabilities and their input schemas.

### `--help` (global) and `--version`

Prints usage, all flags, and a human-readable catalog of tool **titles** grouped by category (Repository / Project / Rules & Tables / Trace / Version Control / Deployment). The titles (e.g. `List Repositories`, `Update Table`) keep the catalog scannable — use `<tool> --help` for the full description of any one tool.

```bash
npx -y openl-mcp --help
npx -y openl-mcp --version    # or -V — prints "openl-mcp X.Y.Z"
```

### `<tool> --help` (per-tool)

For detailed help on a specific tool — title, full description, every argument with type / required / enum / description, and example invocations:

```bash
npx -y openl-mcp update_table --help
npx -y openl-mcp append_table --help
```

Output includes the input-schema breakdown rendered for humans (use `--list-tools | jq` for the full machine-readable JSON Schema).

### `--list-tools`

Dumps a JSON array of every tool's metadata and **complete JSON Schema** for inputs. This is the agent-facing discovery endpoint. Pipe through `jq` to filter, or use as a source for code generation:

```bash
npx -y openl-mcp --list-tools \
  | jq '.[] | select(.name == "openl_update_table") | .inputSchema'
```

---

## Configuration

The CLI reads configuration from environment variables. Every variable has a matching CLI flag that overrides the env (handy for one-off calls without polluting your shell).

| Env var | Flag | Required | Default | Notes |
|---|---|---|---|---|
| `OPENL_BASE_URL` | positional `<url>` or `--base-url <url>` | yes | — | OpenL Studio root URL, e.g. `http://localhost:8080` |
| `OPENL_PERSONAL_ACCESS_TOKEN` | `--token <pat>` | no | — | PAT starting with `openl_pat_`; omit to send unauthenticated requests |
| `OPENL_TIMEOUT` | `--timeout <ms>` | no | `30000` | Per-request HTTP timeout |
| — | `--cookie-jar <path>` | no | — | Persist JSESSIONID between calls (trace) |

Precedence: **CLI flag > environment variable > default**. The base URL is special — it also accepts a **positional `<url>`** that takes precedence over `--base-url`, so the full order is **positional `<url>` > `--base-url` > `OPENL_BASE_URL`**. The positional may appear before or after the tool name (`openl-mcp <url> <tool>` or `openl-mcp <tool> <url>`); a bareword that parses as an `http(s)` URL is always treated as the base URL, never as a tool name.

---

## Authentication

Authentication is **optional**: supply a Personal Access Token to authenticate, or omit it to send unauthenticated requests — for an OpenL Studio in single-user mode, or any server that permits anonymous access.

### Personal Access Token

```bash
# Via env
OPENL_PERSONAL_ACCESS_TOKEN=<your-token> \
  npx -y openl-mcp list_repositories

# Via flag
npx -y openl-mcp list_repositories --token <your-token>
```

Generate a PAT in OpenL Studio under **User Settings → Personal Access Tokens**.

> **Security note.** When you pass `--token` on the command line, the value is visible in process listings (`ps aux`). Prefer env vars for shared/multi-user hosts.

### Anonymous access

Omit `--token` (and `OPENL_PERSONAL_ACCESS_TOKEN`) to run anonymously — the client then sends no `Authorization` header:

```bash
# Server allows anonymous reads — no creds needed
OPENL_BASE_URL=https://studio.example.com \
  npx -y openl-mcp list_repositories
```

`OPENL_BASE_URL` is still required. A server that *does* require auth will respond `401`, which the CLI reports with exit code `77` (`EX_NOPERM`).

---

## Passing tool arguments

Every tool accepts a single JSON object matching its input schema (use `--list-tools` to see the schema). The CLI offers three ways to provide that object — they're **mutually exclusive**.

### 1. Inline JSON literal

Best for simple, short payloads:

```bash
npx -y openl-mcp list_projects '{"status":"OPENED","limit":10}'
```

### 2. `@file.json`

Best for **complex payloads** — `openl_update_table` (full table view), `openl_append_table` (discriminated union by table type), `openl_save_project` (project commit with structured comment):

```bash
cat > /tmp/save.json <<'EOF'
{
  "projectId": "design:insurance:hash123",
  "comment": "Update CA premium rates for Q3"
}
EOF

npx -y openl-mcp save_project @/tmp/save.json
```

### 3. `--stdin`

Best for **piping** from other commands:

```bash
# Build payload programmatically and pipe in
jq -n --arg id "$PROJECT_ID" '{projectId:$id, response_format:"json"}' \
  | npx -y openl-mcp get_project --stdin

# Or via heredoc
npx -y openl-mcp save_project --stdin <<'EOF'
{"projectId":"…", "comment":"saved from CI"}
EOF
```

### No arguments

For tools whose schema has no required fields:

```bash
npx -y openl-mcp list_repositories
# Equivalent to:
npx -y openl-mcp list_repositories '{}'
```

---

## Output format

CLI mode defaults `response_format` to **`markdown`** — the same default as the MCP server. This is the agent-first choice: an LLM agent shelling out to the CLI consumes markdown more naturally than escaped JSON. When you want machine-parseable output (e.g. piping into `jq`), pass `response_format: "json"` explicitly.

```bash
# Default — markdown (agent-readable)
npx -y openl-mcp list_projects

# Machine-parseable JSON for jq pipelines
npx -y openl-mcp list_projects '{"response_format":"json"}' | jq

# Concise markdown summary
npx -y openl-mcp list_projects '{"response_format":"markdown_concise"}'

# Detailed markdown (best for printing)
npx -y openl-mcp get_project \
  '{"projectId":"…", "response_format":"markdown_detailed"}'
```

Supported formats: `markdown` (default), `json`, `markdown_concise`, `markdown_detailed`.

The tool's text payload is written **as-is** to stdout. A trailing newline is added if missing so shell substitutions behave predictably.

---

## Scripting & JSON extraction

This section is for the **secondary audience** — human operators and CI/CD pipelines that extract specific fields. An LLM agent (the primary audience) reads the default markdown directly and never needs `jq`.

The rule of thumb: **whenever you pipe into `jq`, request `response_format:"json"`** — otherwise `jq` receives markdown and fails.

```bash
# ✅ Correct — explicit json, then jq
npx -y openl-mcp list_projects '{"response_format":"json"}' \
  | jq '.data[].name'

# ❌ Wrong — default markdown isn't JSON, jq errors out
npx -y openl-mcp list_projects | jq '.data[].name'
```

The one exception is `--list-tools`, which is **always** JSON regardless of `response_format` (it's the machine-readable discovery endpoint):

```bash
npx -y openl-mcp --list-tools | jq '.[].name'
```

See [Recipes](#recipes) below for end-to-end scripting patterns.

---

## Session-coupled flows: `--cookie-jar`

A few OpenL Studio APIs — notably the **trace** family — store state on the server keyed by `JSESSIONID`. `openl_start_trace` doesn't return a trace ID; the server identifies the trace through the session cookie set in the response. Subsequent `openl_get_trace_nodes`, `openl_get_trace_node_details`, etc. must present the **same** cookie.

In CLI mode each `npx` invocation is a fresh process with no session memory. Without help, the second call would land on a different session and see no trace.

**Solution:** pass `--cookie-jar <path>` consistently across the calls in one flow. The CLI reads the cookie from the file before the call and writes back any cookie the server set in the response.

```bash
JAR=/tmp/openl-trace.jar

# 1. Start trace — server sets JSESSIONID, CLI persists it to $JAR
npx -y openl-mcp start_trace --cookie-jar $JAR @start.json

# 2. Inspect — CLI loads JSESSIONID from $JAR and sends it
npx -y openl-mcp get_trace_nodes --cookie-jar $JAR \
  '{"projectId":"…"}'

# 3. Drill into a node
npx -y openl-mcp get_trace_node_details --cookie-jar $JAR \
  '{"projectId":"…", "nodeId":3}'

# 4. Clean up
npx -y openl-mcp cancel_trace --cookie-jar $JAR \
  '{"projectId":"…"}'
rm $JAR   # optional — the next start_trace will overwrite
```

**Behavior details:**

- **First call on a fresh path:** `ENOENT` is silently treated as "no prior session"; the call proceeds normally.
- **Stateless tools (list/get/update/...):** the server doesn't issue a session cookie, so the file isn't created or modified. You can freely pass `--cookie-jar` to stateless tools without side effects.
- **File permissions:** the jar is written with `0600` (owner-only) on POSIX systems. **Windows** ignores Unix file modes — on NTFS the cookie file inherits the parent directory's ACL. Avoid placing the jar in world-readable directories on Windows.
- **Read failures** (other than `ENOENT`) emit a warning to stderr and continue with a fresh session.
- **Write failures** emit a warning but don't fail the tool call — the API response has already arrived.

> **Tip.** Use one jar per flow (e.g. `/tmp/openl-trace-$$.jar` with `$$` = shell PID) to avoid clashes between parallel scripts.

---

## Recipes

Shell/CI patterns for the secondary (human/scripting) audience. They request `response_format:"json"` where output is piped into `jq` — see [Scripting & JSON extraction](#scripting--json-extraction).

### List projects with status `OPENED`, project name only

When piping into `jq`, request JSON explicitly (markdown is the default):

```bash
npx -y openl-mcp list_projects \
  '{"status":"OPENED","limit":100,"response_format":"json"}' \
  | jq '.data[].name'
```

### Save a project with a structured commit message

```bash
npx -y openl-mcp save_project @<(jq -n \
  --arg id "$PROJECT_ID" \
  --arg msg "$(git log -1 --format=%s)" \
  '{projectId:$id, comment:$msg}')
```

### Fetch a project's tables and find one by kind

```bash
TABLES=$(npx -y openl-mcp list_tables \
  "{\"projectId\":\"$PROJECT_ID\",\"response_format\":\"json\"}")

echo "$TABLES" | jq '.data[] | select(.kind=="SimpleRules") | .name'
```

### Run all tests in a project, exit non-zero on failure

```bash
SUMMARY=$(npx -y openl-mcp start_project_tests \
  '{"projectId":"…"}')
# … poll get_test_results_summary until done …
# (full pattern shown in the OpenL docs Test execution guide)
```

### Walk a trace tree in one script

```bash
JAR=/tmp/trace-$$.jar
trap 'rm -f $JAR' EXIT

npx -y openl-mcp start_trace --cookie-jar $JAR \
  '{"projectId":"…","tableId":"calcPremium_42"}'

# Get root nodes (json for jq processing)
ROOTS=$(npx -y openl-mcp get_trace_nodes --cookie-jar $JAR \
  '{"projectId":"…","response_format":"json"}')

# For each root, fetch details
echo "$ROOTS" | jq -r '.data[].id' | while read -r nodeId; do
  npx -y openl-mcp get_trace_node_details --cookie-jar $JAR \
    "{\"projectId\":\"…\",\"nodeId\":$nodeId,\"response_format\":\"json\"}" \
    | jq '{nodeId, result}'
done

npx -y openl-mcp cancel_trace --cookie-jar $JAR \
  '{"projectId":"…"}'
```

### Generate per-tool wrappers from `--list-tools`

```bash
npx -y openl-mcp --list-tools \
  | jq -r '.[].name' \
  | while read -r tool; do
      cat > "$HOME/bin/$tool" <<EOF
#!/usr/bin/env bash
exec npx -y openl-mcp $tool "\$@"
EOF
      chmod +x "$HOME/bin/$tool"
    done
```

---

## Exit codes

The CLI follows BSD [`sysexits.h`](https://man7.org/linux/man-pages/man3/sysexits.h.3head.html) conventions so CI/CD scripts can distinguish *don't-retry* failures (bad args) from *might-retry* failures (API down):

| Code | Name | Meaning |
|---|---|---|
| `0` | `EX_OK` | Tool executed successfully |
| `1` | `EX_GENERIC` | Unclassified failure (e.g. tool-handler error) |
| `64` | `EX_USAGE` | Bad CLI arguments — unknown flag, missing tool name, multiple arg sources |
| `65` | `EX_DATAERR` | Bad input data — malformed JSON in inline / `@file` / `--stdin` |
| `69` | `EX_UNAVAILABLE` | Server/network unavailable — `ECONNREFUSED`, `ETIMEDOUT`, 5xx |
| `77` | `EX_NOPERM` | Authentication / authorization failure — 401, 403 |
| `78` | `EX_CONFIG` | Missing or invalid configuration — no `OPENL_BASE_URL`, no auth, bad URL |

Inspect stderr for the human-readable error message; the exit code categorises programmatically.

---

## Cross-platform notes

### Windows `cmd.exe`

Single-quoted JSON literals don't work — `cmd.exe` doesn't strip single quotes. Two options:

```bat
:: Escaped double quotes (ugly but works)
npx -y openl-mcp list_projects "{\"status\":\"OPENED\"}"

:: …or use @file.json (recommended)
npx -y openl-mcp list_projects @args.json
```

### Windows PowerShell

Single quotes work as literals (no interpolation), but JSON escaping is nicer via `ConvertTo-Json`:

```powershell
@{ status = 'OPENED'; limit = 10 } | ConvertTo-Json -Compress |
  ForEach-Object { npx -y openl-mcp list_projects $_ }
```

### Shells with non-POSIX redirection

The `--stdin` flag is the most portable option for piping payloads.

---

## Security

- **Credentials in process listings.** Avoid `--token` on the CLI on shared hosts where other users can run `ps aux`. Prefer env vars or env files.
- **Cookie jar is sensitive.** It contains a server session identifier; `0600` perms are applied automatically but don't share the file or commit it.
- **Logs.** The CLI writes only sanitized errors to stderr — credentials and PATs are redacted by [`sanitizeError`](src/utils.ts). The chatty `[Auth]` informational lines from MCP mode are suppressed in CLI mode via `OPENL_CLI_QUIET=1` (set automatically; you don't need to touch it).
- **CI/CD.** Use your platform's secret store (GitHub Actions secrets, GitLab variables, etc.) and inject as env vars at job runtime. Don't commit `.env` files.

---

## Troubleshooting

### `Error: OPENL_BASE_URL is required`

Set the env var or pass `--base-url`. `--help` and `--list-tools` don't require it.

### `Error: Failed to parse tool arguments as JSON: …`

Your JSON literal is malformed. Common causes: missing quotes on keys, trailing commas, shell interpolation munging the string. Use `@file.json` or `--stdin` to sidestep shell quoting issues.

### `Error: Unknown tool: …`

Either a typo in the tool name, or you're targeting a temporarily disabled tool. Run `--list-tools` (or `--help`) to see the exact set currently available — that's the source of truth. A few tools are commented out in the registry pending API/implementation fixes; if a tool you expect is missing, it's likely one of those.

### `Error: MCP error -32603: OpenL Studio API error …`

The API returned an error. Common cases:

- `401`: bad credentials or expired PAT.
- `404`: project ID format mismatch (use exact `projectId` from `openl_list_projects`, don't reformat).
- `409`: concurrent modification — re-fetch project state with `openl_get_project` and retry.
- `ECONNREFUSED`: wrong `--base-url` or OpenL Studio not running.

The line preceded by `[ERROR] Tool error: …` (from the standard logger) gives endpoint, HTTP code, and the tool arguments that triggered the error — useful for filing tickets.

### Trace `get_trace_nodes` returns empty / `404` after `start_trace`

You're calling the two operations in **separate processes** without `--cookie-jar`. See [Session-coupled flows](#session-coupled-flows---cookie-jar).

### Output isn't valid JSON

The CLI defaults to **markdown**, not JSON. To get JSON (e.g. for `jq`), pass `response_format:"json"` in the tool args. See [Scripting & JSON extraction](#scripting--json-extraction).

---

## Limitations

- **No subcommand-per-tool yet.** Today the CLI is "tool name + JSON" — no `openl-cli list-projects --repository foo --status OPENED` style. The JSON-in-argv approach is universal (handles every input schema, including discriminated unions and `Record<string, any>`) but verbose. Subcommand UX is a possible future enhancement.
- **No persistent sessions beyond `--cookie-jar`.** Other request-scoped state (HTTP/2 connection pooling, redirect cache) doesn't carry over between `npx` invocations. Not usually a problem.
- **Stateful flows fan out.** A "save then close" macro is two CLI calls. If you need transaction-like behavior, drive the flow from a script that reacts to each result (or use Claude Desktop with the MCP server).
- **Disabled tools.** A few tools are commented out in the registry pending API/implementation fixes, so they appear in neither `--list-tools` nor MCP mode. The CLI exposes exactly the same active set as the MCP server — run `--list-tools` for the current list.

---

## See also

- [`README.md`](README.md) — project overview and MCP-mode setup.
- [`README.npm.md`](README.npm.md) — short npm package description.
- [`AGENTS.md`](AGENTS.md) — full agent capabilities reference, with tool list and prompts.
- [Usage Examples (MCP mode)](docs/guides/examples.md) — prompt-based examples for Claude Desktop / Cursor.
- [Authentication Guide](docs/guides/advanced.md#authentication) — PAT setup and SSO scenarios.
- [Troubleshooting](docs/guides/troubleshooting.md) — general troubleshooting (applies to both modes).
- [CLI Audit Follow-ups](docs/development/cli-audit-followups.md) — backlog of deferred CLI improvements (P1/P2/P3) with rationale and effort estimates.
