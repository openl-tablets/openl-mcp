# openl-mcp-server — CLI mode

`openl-mcp-server` is primarily an [MCP](https://modelcontextprotocol.io/) server for Claude Desktop, Cursor, and other LLM clients. The **same binary** also doubles as a command-line tool for direct API calls — useful when you want to script OpenL Studio operations, integrate into CI/CD, or debug a single tool invocation from your shell without spinning up an MCP client.

Internally, CLI mode reuses the same tool registry, Zod input validation, response formatters, and error handling as the MCP server: anything Claude can do through MCP, you can do from a shell.

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
- [Session-coupled flows: `--cookie-jar`](#session-coupled-flows---cookie-jar)
- [Request tracking: `--client-document-id`](#request-tracking---client-document-id)
- [Recipes](#recipes)
- [Exit codes](#exit-codes)
- [Cross-platform notes](#cross-platform-notes)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## When to use CLI mode

Use CLI mode when:

- You want to call **one** tool and pipe the result somewhere (`jq`, `grep`, another script).
- You're building **CI/CD** automation (deploy a project, run tests, check status).
- You're **debugging** a single API call without launching Claude Desktop / Cursor.
- You want to **integrate** OpenL Studio into shell scripts, cron jobs, or Makefiles.

Use MCP mode (the default — pass no arguments) when:

- An LLM client (Claude Desktop, Cursor) drives the session.
- You need **multi-turn** conversations where Claude chooses tools dynamically.
- You're walking through a stateful flow that benefits from session continuity (although `--cookie-jar` covers most of this in CLI mode too — see below).

The two modes are **mutually exclusive per process**: invoking the binary with arguments routes to CLI; with no arguments, it starts the MCP stdio server.

---

## Quick start

```bash
# 1. Discovery — works without any config
npx -y openl-mcp-server --help
npx -y openl-mcp-server --list-tools | jq '.[].name'

# 2. Single call with env-based config
export OPENL_BASE_URL=https://studio.example.com
export OPENL_PERSONAL_ACCESS_TOKEN=openl_pat_…
npx -y openl-mcp-server openl_list_repositories | jq

# 3. Or pass everything as flags (one-off, no env pollution)
npx -y openl-mcp-server openl_list_projects \
  --base-url https://studio.example.com \
  --token openl_pat_… \
  | jq '.data[] | {name, status}'
```

---

## Invocation

```
openl-mcp-server <tool-name> [args] [flags]
openl-mcp-server --help
openl-mcp-server --list-tools
openl-mcp-server                          # no args → MCP stdio server
```

You can invoke the binary three ways:

| Method | Example |
|---|---|
| One-shot via `npx` (no install) | `npx -y openl-mcp-server <tool-name> …` |
| Globally installed | `npm i -g openl-mcp-server && openl-mcp <tool-name> …` |
| From a clone | `node /path/to/dist/index.js <tool-name> …` |

> **Tip.** `npx -y` skips the prompt to install missing packages; safe to use in scripts.

---

## Discovery

CLI mode can list every tool and dump every input schema without any credentials — useful for exploring or generating bindings.

### `--help`

Prints usage, all flags, and a one-line description for every tool:

```bash
npx -y openl-mcp-server --help
```

Sample output (truncated):

```text
openl-mcp-server v1.0.0 — CLI mode

Usage:
  openl-mcp <tool-name> [<json-args> | @file.json | --stdin] [flags]
  openl-mcp --list-tools
  openl-mcp --help

…

Available tools (31):
  openl_append_table                         Add new rows/fields to an existing table…
  openl_cancel_trace                         Cancel ongoing trace execution…
  openl_close_project                        Close a project. If the project has unsaved…
  …
```

### `--list-tools`

Dumps a JSON array of every tool's metadata and **complete JSON Schema** for inputs. Pipe through `jq` to filter, or use as a source for code generation:

```bash
npx -y openl-mcp-server --list-tools \
  | jq '.[] | select(.name == "openl_execute_rule") | .inputSchema'
```

---

## Configuration

The CLI reads configuration from environment variables. Every variable has a matching CLI flag that overrides the env (handy for one-off calls without polluting your shell).

| Env var | Flag | Required | Default | Notes |
|---|---|---|---|---|
| `OPENL_BASE_URL` | `--base-url <url>` | yes | — | OpenL Studio root URL, e.g. `http://localhost:8080` |
| `OPENL_PERSONAL_ACCESS_TOKEN` | `--token <pat>` | one of two auth modes | — | PAT starting with `openl_pat_` |
| `OPENL_USERNAME` | `--user <name>` | with `--password` | — | Basic auth username |
| `OPENL_PASSWORD` | `--password <pwd>` | with `--user` | — | Basic auth password |
| `OPENL_TIMEOUT` | `--timeout <ms>` | no | `30000` | Per-request HTTP timeout |
| `OPENL_CLIENT_DOCUMENT_ID` | `--client-document-id <id>` | no | — | Request tracking header (audit) |
| — | `--cookie-jar <path>` | no | — | Persist JSESSIONID between calls (trace) |

Precedence: **CLI flag > environment variable > default**.

---

## Authentication

The OpenL Studio API supports two methods; the CLI accepts either.

### Personal Access Token (recommended)

```bash
# Via env
OPENL_PERSONAL_ACCESS_TOKEN=openl_pat_abc123 \
  npx -y openl-mcp-server openl_list_repositories

# Via flag
npx -y openl-mcp-server openl_list_repositories --token openl_pat_abc123
```

Generate a PAT in OpenL Studio under **User Settings → Personal Access Tokens**.

### Basic Auth

```bash
# Via env
OPENL_USERNAME=admin OPENL_PASSWORD=admin \
  npx -y openl-mcp-server openl_list_repositories

# Via flag
npx -y openl-mcp-server openl_list_repositories --user admin --password admin
```

> **Security note.** When you pass `--password` or `--token` on the command line, the value is visible in process listings (`ps aux`). Prefer env vars for shared/multi-user hosts.

### Validation

If neither auth method is configured, the CLI fails fast with a clear message before making any HTTP requests:

```text
Error: Authentication required: set OPENL_PERSONAL_ACCESS_TOKEN (or --token),
or both OPENL_USERNAME/OPENL_PASSWORD (or --user/--password)
```

---

## Passing tool arguments

Every tool accepts a single JSON object matching its input schema (use `--list-tools` to see the schema). The CLI offers three ways to provide that object — they're **mutually exclusive**.

### 1. Inline JSON literal

Best for simple, short payloads:

```bash
npx -y openl-mcp-server openl_list_projects '{"status":"OPENED","limit":10}'
```

### 2. `@file.json`

Best for **complex payloads** — `openl_update_table` (full table view), `openl_execute_rule` (nested input data), `openl_append_table` (discriminated union by table type):

```bash
cat > /tmp/exec.json <<'EOF'
{
  "projectId": "design:insurance:hash123",
  "ruleName": "calculatePremium",
  "inputData": {
    "driverType": "SAFE",
    "age": 30,
    "vehicleValue": 25000
  }
}
EOF

npx -y openl-mcp-server openl_execute_rule @/tmp/exec.json
```

### 3. `--stdin`

Best for **piping** from other commands:

```bash
# Build payload programmatically and pipe in
jq -n --arg id "$PROJECT_ID" '{projectId:$id, response_format:"json"}' \
  | npx -y openl-mcp-server openl_get_project --stdin

# Or via heredoc
npx -y openl-mcp-server openl_execute_rule --stdin <<'EOF'
{"projectId":"…", "ruleName":"calc", "inputData":{"x":1}}
EOF
```

### No arguments

For tools whose schema has no required fields:

```bash
npx -y openl-mcp-server openl_list_repositories
# Equivalent to:
npx -y openl-mcp-server openl_list_repositories '{}'
```

---

## Output format

CLI mode defaults `response_format` to `"json"` so output pipes cleanly into `jq`. The MCP-stdio default is `"markdown"` for LLM readability; CLI is different.

Override per-call by including `response_format` in your args:

```bash
# Default (JSON)
npx -y openl-mcp-server openl_list_projects | jq

# Force markdown (human-readable summary)
npx -y openl-mcp-server openl_list_projects '{"response_format":"markdown_concise"}'

# Detailed markdown (best for printing)
npx -y openl-mcp-server openl_get_project \
  '{"projectId":"…", "response_format":"markdown_detailed"}'
```

Supported formats: `json`, `markdown`, `markdown_concise`, `markdown_detailed`.

The tool's text payload is written **as-is** to stdout. A trailing newline is added if missing so shell substitutions behave predictably.

---

## Session-coupled flows: `--cookie-jar`

A few OpenL Studio APIs — notably the **trace** family — store state on the server keyed by `JSESSIONID`. `openl_start_trace` doesn't return a trace ID; the server identifies the trace through the session cookie set in the response. Subsequent `openl_get_trace_nodes`, `openl_get_trace_node_details`, etc. must present the **same** cookie.

In CLI mode each `npx` invocation is a fresh process with no session memory. Without help, the second call would land on a different session and see no trace.

**Solution:** pass `--cookie-jar <path>` consistently across the calls in one flow. The CLI reads the cookie from the file before the call and writes back any cookie the server set in the response.

```bash
JAR=/tmp/openl-trace.jar

# 1. Start trace — server sets JSESSIONID, CLI persists it to $JAR
npx -y openl-mcp-server openl_start_trace --cookie-jar $JAR @start.json

# 2. Inspect — CLI loads JSESSIONID from $JAR and sends it
npx -y openl-mcp-server openl_get_trace_nodes --cookie-jar $JAR \
  '{"projectId":"…"}'

# 3. Drill into a node
npx -y openl-mcp-server openl_get_trace_node_details --cookie-jar $JAR \
  '{"projectId":"…", "nodeId":3}'

# 4. Clean up
npx -y openl-mcp-server openl_cancel_trace --cookie-jar $JAR \
  '{"projectId":"…"}'
rm $JAR   # optional — the next start_trace will overwrite
```

**Behavior details:**

- **First call on a fresh path:** `ENOENT` is silently treated as "no prior session"; the call proceeds normally.
- **Stateless tools (list/get/update/...):** the server doesn't issue a session cookie, so the file isn't created or modified. You can freely pass `--cookie-jar` to stateless tools without side effects.
- **File permissions:** the jar is written with `0600` (owner-only). Treat the file like any other credential.
- **Read failures** (other than `ENOENT`) emit a warning to stderr and continue with a fresh session.
- **Write failures** emit a warning but don't fail the tool call — the API response has already arrived.

> **Tip.** Use one jar per flow (e.g. `/tmp/openl-trace-$$.jar` with `$$` = shell PID) to avoid clashes between parallel scripts.

---

## Request tracking: `--client-document-id`

OpenL Studio honors the `Client-Document-Id` header for audit/correlation. Pass it per-call or set globally:

```bash
# Per-call
npx -y openl-mcp-server openl_save_project \
  --client-document-id ticket-EPBDS-12345 \
  '{"projectId":"…", "comment":"Fix CA premium rates"}'

# Or via env
export OPENL_CLIENT_DOCUMENT_ID=$(uuidgen)
npx -y openl-mcp-server openl_deploy_project '…'
```

The value is added as a header to every HTTP request the CLI makes during that invocation.

---

## Recipes

### List projects with status `OPENED`, project name only

```bash
npx -y openl-mcp-server openl_list_projects \
  '{"status":"OPENED","limit":100}' \
  | jq '.data[].name'
```

### Save a project with a structured commit message

```bash
npx -y openl-mcp-server openl_save_project @<(jq -n \
  --arg id "$PROJECT_ID" \
  --arg msg "$(git log -1 --format=%s)" \
  '{projectId:$id, comment:$msg}')
```

### Execute a rule and check a specific result field

```bash
RESULT=$(jq -n --arg id "$PROJECT_ID" \
  '{projectId:$id, ruleName:"calculatePremium", inputData:{age:30}}' \
  | npx -y openl-mcp-server openl_execute_rule --stdin)

echo "$RESULT" | jq -e '.result.premium > 0' \
  && echo "OK" \
  || echo "BAD: $RESULT"
```

### Run all tests in a project, exit non-zero on failure

```bash
SUMMARY=$(npx -y openl-mcp-server openl_start_project_tests \
  '{"projectId":"…"}')
# … poll openl_get_test_results_summary until done …
# (full pattern shown in the OpenL docs Test execution guide)
```

### Walk a trace tree in one script

```bash
JAR=/tmp/trace-$$.jar
trap 'rm -f $JAR' EXIT

npx -y openl-mcp-server openl_start_trace --cookie-jar $JAR \
  '{"projectId":"…","tableId":"calcPremium_42"}'

# Get root nodes
ROOTS=$(npx -y openl-mcp-server openl_get_trace_nodes --cookie-jar $JAR \
  '{"projectId":"…"}')

# For each root, fetch details
echo "$ROOTS" | jq -r '.data[].id' | while read -r nodeId; do
  npx -y openl-mcp-server openl_get_trace_node_details --cookie-jar $JAR \
    "{\"projectId\":\"…\",\"nodeId\":$nodeId}" \
    | jq '{nodeId, result}'
done

npx -y openl-mcp-server openl_cancel_trace --cookie-jar $JAR \
  '{"projectId":"…"}'
```

### Generate per-tool wrappers from `--list-tools`

```bash
npx -y openl-mcp-server --list-tools \
  | jq -r '.[].name' \
  | while read -r tool; do
      cat > "$HOME/bin/$tool" <<EOF
#!/usr/bin/env bash
exec npx -y openl-mcp-server $tool "\$@"
EOF
      chmod +x "$HOME/bin/$tool"
    done
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Tool executed successfully |
| `1` | Anything else — bad arguments, missing config, tool error, HTTP error, JSON parse failure, etc. |

The CLI does not currently distinguish error categories with different exit codes. Inspect stderr for context. If you need to discriminate, look at the JSON tool result (when `response_format=json` and the tool succeeded but returned a logical error).

---

## Cross-platform notes

### Windows `cmd.exe`

Single-quoted JSON literals don't work — `cmd.exe` doesn't strip single quotes. Two options:

```bat
:: Escaped double quotes (ugly but works)
npx -y openl-mcp-server openl_list_projects "{\"status\":\"OPENED\"}"

:: …or use @file.json (recommended)
npx -y openl-mcp-server openl_list_projects @args.json
```

### Windows PowerShell

Single quotes work as literals (no interpolation), but JSON escaping is nicer via `ConvertTo-Json`:

```powershell
@{ status = 'OPENED'; limit = 10 } | ConvertTo-Json -Compress |
  ForEach-Object { npx -y openl-mcp-server openl_list_projects $_ }
```

### Shells with non-POSIX redirection

The `--stdin` flag is the most portable option for piping payloads.

---

## Security

- **Credentials in process listings.** Avoid `--password` / `--token` on the CLI on shared hosts where other users can run `ps aux`. Prefer env vars or env files.
- **Cookie jar is sensitive.** It contains a server session identifier; `0600` perms are applied automatically but don't share the file or commit it.
- **Logs.** The CLI writes only sanitized errors to stderr — credentials and PATs are redacted by [`sanitizeError`](src/utils.ts). The chatty `[Auth]` informational lines from MCP mode are suppressed in CLI mode via `OPENL_CLI_QUIET=1` (set automatically; you don't need to touch it).
- **CI/CD.** Use your platform's secret store (GitHub Actions secrets, GitLab variables, etc.) and inject as env vars at job runtime. Don't commit `.env` files.

---

## Troubleshooting

### `Error: OPENL_BASE_URL is required`

Set the env var or pass `--base-url`. `--help` and `--list-tools` don't require it.

### `Error: Authentication required …`

Set either `OPENL_PERSONAL_ACCESS_TOKEN` or both `OPENL_USERNAME`/`OPENL_PASSWORD`. The CLI doesn't accept anonymous access (some OpenL endpoints do allow it, but the API client requires credentials up front).

### `Error: Failed to parse tool arguments as JSON: …`

Your JSON literal is malformed. Common causes: missing quotes on keys, trailing commas, shell interpolation munging the string. Use `@file.json` or `--stdin` to sidestep shell quoting issues.

### `Error: Unknown tool: …`

Typo in the tool name, or you're targeting a disabled tool. Run `--list-tools` to see what's available. Disabled tools: `openl_upload_file`, `openl_download_file`, `openl_validate_project`, `openl_get_project_errors`, `openl_test_project`, `openl_compare_versions` (pending API support).

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

You probably overrode `response_format`. Default in CLI is `json`. Inspect with `… | head -1` to see what the first character is.

---

## Limitations

- **No subcommand-per-tool yet.** Today the CLI is "tool name + JSON" — no `openl-cli list-projects --repository foo --status OPENED` style. The JSON-in-argv approach is universal (handles every input schema, including discriminated unions and `Record<string, any>`) but verbose. Subcommand UX is a possible future enhancement.
- **No persistent sessions beyond `--cookie-jar`.** Other request-scoped state (HTTP/2 connection pooling, redirect cache) doesn't carry over between `npx` invocations. Not usually a problem.
- **Stateful flows fan out.** A "save then close" macro is two CLI calls. If you need transaction-like behavior, drive the flow from a script that reacts to each result (or use Claude Desktop with the MCP server).
- **Disabled tools.** Six tools are temporarily disabled pending fixes (listed under Troubleshooting). CLI exposes the same active set as MCP mode.

---

## See also

- [`README.md`](README.md) — project overview and MCP-mode setup.
- [`README.npm.md`](README.npm.md) — short npm package description.
- [`AGENTS.md`](AGENTS.md) — full agent capabilities reference, with tool list and prompts.
- [Usage Examples (MCP mode)](docs/guides/examples.md) — prompt-based examples for Claude Desktop / Cursor.
- [Authentication Guide](docs/guides/authentication.md) — PAT setup and SSO scenarios.
- [Troubleshooting](docs/guides/troubleshooting.md) — general troubleshooting (applies to both modes).
