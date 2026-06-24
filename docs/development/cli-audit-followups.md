# CLI Mode — Audit Follow-ups

Tracks items identified in the `EPBDS-16027` CLI audit (May 2026) that were **not** implemented in the initial release but are recommended for future tickets. Each item links the best-practice rationale, an estimated cost, and a one-line recommendation on when to take it on.

> Items 1, 2, 3, 5, and 6 from the original audit list were closed in `EPBDS-16027`. This document covers the deferred remainder.

---

## Status legend

- 🟡 **P1** — improves UX measurably; pick up before npm publication if possible
- 🟢 **P2** — substantive feature work; schedule as its own ticket
- 🔵 **P3** — nice-to-have; backlog

---

## 🟡 P1.4 — "Did you mean…?" suggestions for typos

**Problem.** Typing `openl_list_repositorie` (missing trailing letters) or `openl-list-projects` (dashes instead of underscores) currently produces a bare `Unknown tool: <name>` error with no recovery hint. Every mature CLI (`gh`, `git`, `npm`, `kubectl` via Cobra) does Levenshtein-based "did you mean" suggestions for both subcommands and flags.

**References.**
- [clig.dev — Help](https://clig.dev/#help): *"When the user gets it wrong, the tool should help them get it right."*
- [Cobra README — suggestions](https://github.com/spf13/cobra#suggestions)
- [Commander `showSuggestionAfterError`](https://github.com/tj/commander.js#showSuggestionAfterError)

**Sketch.**
- Implement Levenshtein distance (or use [`fastest-levenshtein`](https://www.npmjs.com/package/fastest-levenshtein), ~2KB, 1 dep).
- On `Unknown tool: <X>` from `executeTool`: compute distance to each registered tool name; if min ≤ 3, show "Did you mean: `openl_list_repositories`, `openl_list_branches`?"
- Same treatment for unknown flag names in `parseArgs`.

**Estimate.** ~30 lines of code + 3 unit tests. **~1 hour.**

---

## 🟡 P1.7 — `--token-stdin` for secret-safer input

**Problem.** Passing the secret through `--token <pat>` exposes it in the OS process listing (`ps aux`, `/proc/<pid>/cmdline`), shell history, and process accounting logs. Documented in [README.cli.md → Security](../../README.cli.md#security), but documentation alone is a weak mitigation — the secure path doesn't exist yet.

**Best practice.** Industry convention (`docker login --password-stdin`, `gh auth login --with-token`) is to accept the secret via a dedicated stdin flag, which sidesteps the argv leak.

**References.**
- [smallstep — Handle Secrets on the Command Line](https://smallstep.com/blog/command-line-secrets/)
- [`docker login --password-stdin` docs](https://docs.docker.com/engine/reference/commandline/login/#provide-a-password-using-stdin)

**Sketch.**
- Add flag `--token-stdin` (mutually exclusive with the value-bearing `--token <pat>` form and with `--stdin` for tool args; *but* compatible with `--stdin` if we route tool args through `@file.json`).
- Read one line from `process.stdin` until newline/EOF, trim, set as the override.
- Update README to mark `--token` as "OK for env-driven hosts; for shared/multi-user systems prefer `--token-stdin`."

**Estimate.** ~40 lines + 3 tests (incl. EOF without newline). **~1.5 hours.**

**Caveat.** Conflicts with using `--stdin` for the tool args payload. We'd need a small extension to allow one stdin source for the secret AND another (file/inline) for the args, or document that they're mutually exclusive.

---

## 🟡 P1.8 — Machine-readable error output (`--json-errors`)

**Problem.** When a tool call fails, the error is a free-form English string on stderr (e.g. `Error: MCP error -32600: OpenL Studio API error (401): ...`). CI/CD scripts that already parse JSON from stdout have no equivalent path for parsing failures — they have to regex-match strings.

**Best practice.** `gh --json`, `aws`, and `kubectl` emit a structured error object (to stdout when `--json` is on) with `{ "error": { "code": "EAUTH", "message": "...", "details": {...} } }`. Exit code still signals success/failure; stderr stays human-readable.

**References.**
- [npm issue #2150 — `--json` errors leaked to stdout](https://github.com/npm/cli/issues/2150) (cautionary tale: emit errors to **stdout** when `--json` is on, not stderr)
- [Heroku CLI Style Guide](https://devcenter.heroku.com/articles/cli-style-guide)

**Sketch.**
- Add `--json-errors` flag (or auto-enable when stdout is JSON-formatted by default, which is our case).
- In the top-level catch, when flag is on: emit `{"error":{"code":<exit_code_name>,"message":<sanitized>,"exitCode":<num>}}` to stdout instead of plain text on stderr.
- Stderr still gets the human message for interactive use.

**Estimate.** ~20 lines + 2 tests. **~45 min.**

---

## 🟢 P2.9 — `--config <path>` + XDG Base Dir support

**Problem.** For users who routinely invoke many CLI calls against the same Studio host, repeating `--base-url`/`--token` (or env exports) is tedious. No way to share config with a teammate via a file.

**Best practice.** Read `~/.config/openl-mcp/config.json` (or `$XDG_CONFIG_HOME/openl-mcp/config.json`) by default; allow `--config <path>` override; flags > env > config file > defaults.

**References.**
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)
- [`env-paths` npm package](https://www.npmjs.com/package/env-paths) — handles Windows/macOS equivalents
- [12-factor §3](https://12factor.net/config)

**Sketch.**
- New `--config <path>` flag.
- Default lookup: `$XDG_CONFIG_HOME/openl-mcp/config.json`, fallback `~/.config/openl-mcp/config.json` on Linux, `~/Library/Preferences/openl-mcp/config.json` on macOS, `%APPDATA%/openl-mcp/config.json` on Windows (`env-paths` handles this).
- Schema: `{ baseUrl, token, timeout, clientDocumentId }` — same keys as overrides.
- Precedence: CLI flag > env > config file > defaults.

**Estimate.** ~80 lines + tests + README update + 1 dependency (`env-paths`). **~3 hours.**

---

## 🟢 P2.10 — `--quiet` / `--verbose` / `--debug` flags

**Problem.** We hardcode `OPENL_CLI_QUIET=1` inside `runCli` to suppress the chatty `[Auth]` lines. There's no escape hatch when a user **wants** the diagnostic output for debugging.

**Sketch.**
- `--verbose` / `-v` → unset `OPENL_CLI_QUIET`, set `DEBUG_AUTH=true`.
- `--debug` → also dumps full stack traces, raw HTTP request/response (with secrets redacted).
- `--quiet` / `-q` → current default (already the case; flag becomes explicit no-op for symmetry).

**Estimate.** ~15 lines + 2 tests. **~30 min.**

---

## 🟢 P2.11 — Graceful SIGINT (Ctrl-C) handling

**Problem.** Hitting Ctrl-C mid-API-call leaves the HTTP request open (axios doesn't auto-abort), and the process exits with code 130 from the signal — but resources aren't cleaned up.

**Best practice.** Set up an `AbortController`, pass `signal` to axios, on SIGINT call `controller.abort()`, then exit 130 explicitly.

**References.**
- [Node.js `AbortController` docs](https://nodejs.org/api/globals.html#class-abortcontroller)
- [Axios cancellation via `AbortController`](https://axios-http.com/docs/cancellation)
- [Node signal events](https://nodejs.org/api/process.html#signal-events)

**Sketch.**
- Wire a process-level `AbortController` in `runCli`; pass `signal` through `OpenLConfig` to `axios.create({ signal })` (requires extending `OpenLConfig` and `OpenLClient`).
- `process.once('SIGINT', () => controller.abort())`.
- In catch: if `error.code === 'ERR_CANCELED'`, write `\nAborted.\n` and return 130.

**Estimate.** ~30 lines across cli.ts + client.ts + OpenLConfig type, ~2 tests. **~2 hours.**

---

## 🟢 P2.12 — Shell completion (`completion bash|zsh|fish`)

**Problem.** Tab-completing tool names (31 of them with `openl_` prefix) and flags would be a real time-saver. Currently zero shell integration.

**Best practice.** Canonical pattern: a subcommand `<cli> completion <shell>` that prints a script to stdout for users to `source` or save into completion dirs.

**References.**
- [Click — Shell Completion docs](https://click.palletsprojects.com/en/stable/shell-completion/) (canonical UX)
- [`tabtab`](https://github.com/mklabs/tabtab), [`omelette`](https://github.com/f/omelette) — Node libraries
- Yargs has [`completion()`](https://yargs.js.org/docs/#api-reference-completioncommand-description-fn) built-in (one reason to consider migrating to yargs eventually)

**Sketch.**
- New `completion <shell>` subcommand.
- Generate static script that knows: 31 tool names, ~12 flags, file paths for `--cookie-jar` / `@file` args.
- Document installation: `npx openl-mcp-server completion zsh > ~/.zsh/completions/_openl-mcp`.

**Estimate.** ~150 lines (script templates per shell) or ~30 lines + `tabtab` dep. **~3 hours.**

---

## 🟢 P2.13 — TTY-aware output: pretty JSON to terminal, compact to pipe

**Problem.** We always emit compact JSON. When a user runs `openl-mcp openl_list_repositories` in a terminal (no pipe), reading is harder than it needs to be. When piped to `jq`, compact is right.

**Best practice.** Detect with `process.stdout.isTTY`; if true, pretty-print (2-space indent); if false (pipe/redirect), keep compact.

**References.**
- [Node TTY docs](https://nodejs.org/api/tty.html)
- [`vitest` auto-switches modes on TTY](https://vitest.dev/) (same pattern)

**Sketch.**
- After applying `applyDefaultResponseFormat`, if `process.stdout.isTTY && response_format === 'json'`, set a flag.
- In `formatResponse` (or post-process in CLI), pretty-print JSON when TTY.

**Estimate.** ~10 lines + 1 test. **~30 min.** Watch: tool currently returns a pre-formatted string; we'd need to re-parse + re-stringify, or alter the formatter signature.

---

## 🟢 P2.14 — Stdin size limit

**Problem.** `readStream` reads stdin fully into memory. An accidental `cat huge.bin | npx -y openl-mcp-server openl_… --stdin` could OOM the Node process.

**Sketch.**
- Hard cap at 10 MB (way more than any tool arg will ever be).
- Throw `CliError('Stdin payload exceeds 10 MB; use @file.json for large payloads', EX_DATAERR)`.

**Estimate.** ~10 lines + 1 test. **~20 min.**

---

## 🟢 P2.15 — Per-host cookie-jar scoping

**Problem.** Current cookie-jar format is a single line containing one JSESSIONID. If a user reuses the same `--cookie-jar` file across calls to **different** `--base-url` hosts, sessions collide silently.

**Best practice.** Real-world cookie jars are scoped by host (Netscape `cookies.txt` format, [curl cookie jar spec](https://everything.curl.dev/http/cookies/fileformat.html)).

**Sketch.**
- Migrate jar format from plain text to JSON: `{ "host:port": "jsessionid", ... }`.
- Backwards-compatible read: if the file content is a JSON object, treat as map; else treat as legacy single-value for current `baseUrl`.
- Add a `version: 1` field for future format changes.

**Estimate.** ~40 lines + 4 tests (read both formats, write new format, host scoping). **~1.5 hours.**

---

## 🟢 P2.16 — Startup performance: lazy-load MCP SDK

**Problem.** `--help` and `--list-tools` take ~120 ms warm / ~220 ms cold because importing the MCP SDK pulls 5.8 MB of deps that aren't actually needed for discovery. clig.dev recommends ≤100 ms for `--help`.

**References.**
- [Node startup snapshot RFC #17058](https://github.com/nodejs/node/issues/17058)
- [Commander vs Yargs vs Oclif startup-cost comparison](https://www.pkgpulse.com/blog/how-to-build-cli-nodejs-commander-yargs-oclif)

**Sketch.**
- Move `import { Server } from "@modelcontextprotocol/sdk/server/index.js"` to a dynamic `await import()` inside `ensureToolsRegistered` — only loaded when actually constructing a Server.
- For `--help` and `--list-tools` we currently pass a stub `OpenLClient` to `ensureToolsRegistered` purely to populate the registry. The registry only needs the **handlers**, not the client (passed at execute time). Refactor `registerAllTools` to skip needing a real `Server` instance.

**Estimate.** ~30 lines + measurement script. **~2 hours.**

---

## ✅ P2.17 — Child-process integration tests — DONE

**Done in `EPBDS-16027`.** Added `tests/cli-spawn.test.ts` (6 tests) spawning the
built `dist/index.js` via `node:child_process` (no extra dep). Covers:
- CLI-mode dispatch: `--version`, `--help`, typo'd tool → EX_USAGE (64), valid
  tool with no config → EX_CONFIG (78) via the CLI loader.
- MCP-mode dispatch: no-args routes to the stdio MCP path (asserted via the
  MCP loader's distinct "environment variable is required" message).
- EPIPE: closing stdout's read end early doesn't crash the process (exit 0,
  no EPIPE on stderr).
- Implicitly exercises shebang / `bin` wiring / real stream behavior.

`beforeAll` rebuilds `dist/` only when it's older than `src/index.ts` /
`src/cli.ts`, so CI (build-before-test) and fresh local builds skip the rebuild.

> Note: child-process tests don't move `index.ts`'s coverage number — the
> spawned process isn't instrumented by jest. Their value is catching real
> entry-point regressions (dispatch routing, EPIPE, bin wiring) that
> in-process tests can't.

---

## 🟢 P2.18 — Snapshot tests for `--help` output

**Problem.** Help text can drift as flags are added/removed without anyone noticing the wording change in PR review. Snapshots catch that.

**Best practice.** Vitest/Jest `toMatchSnapshot()` against `--help` output.

**References.**
- [How to Test CLI Output in Jest & Vitest](https://www.lekoarts.de/how-to-test-cli-output-in-jest-vitest/)

**Sketch.**
- `it('--help output matches snapshot')` — capture stdout from `runCli({argv:['--help'], env:{}})`.
- Update workflow: when intentional changes, run `jest --updateSnapshot` and commit the diff.

**Estimate.** ~15 lines + initial snapshot. **~15 min.**

---

## 🟢 P2.19 — `--dry-run` for CI args validation

**Problem.** CI users want to validate that their JSON args structurally satisfy a tool's schema **without** making the API call. Currently they have to spin up a mock server or accept the cost of the real call.

**Sketch.**
- Add `--dry-run` flag.
- After `resolveToolArgs` and `applyDefaultResponseFormat`, validate against the tool's Zod schema directly (not via `executeTool`).
- Emit `{ "valid": true, "args": <effective_args> }` (or `valid: false` with errors) and exit 0/65.

**Estimate.** ~25 lines + 3 tests. **~45 min.**

---

## 🟢 P2.20a — Fix or replace `.github/workflows/ci.yml`

**Problem.** The current workflow has `working-directory: mcp-server` and `paths: ['mcp-server/**']`, but the repository has `package.json` at the root (no `mcp-server/` subdirectory). The workflow has **never run** on this repo per maintainer confirmation. Any new test we add (including the 30 new CLI tests added in `EPBDS-16027`) is verified locally only — there's no automated gate on PRs.

**Sketch.**
- Drop the `mcp-server/` prefix from both `paths` filters and the `working-directory: mcp-server` default.
- Or, if `mcp-server/` is the intended layout (and the maintainers plan to restructure), align repo layout to match.
- Verify by pushing a small change to a `claude/**` branch and checking the Actions tab.

```yaml
on:
  push:
    branches: [ main, develop, 'claude/**' ]
    paths:
      - 'src/**'
      - 'tests/**'
      - 'package.json'
      - 'package-lock.json'
      - 'tsconfig.json'
  pull_request:
    branches: [ main, develop ]
    paths:
      - 'src/**'
      - 'tests/**'
      - 'package.json'
      - 'package-lock.json'
      - 'tsconfig.json'

jobs:
  test:
    # remove `defaults.run.working-directory`
    ...
```

**Estimate.** ~5 min YAML edit + 1 verification push. **~15 min total.**

**Note.** May depend on whether there's a parallel CI system (Jenkins, GitLab CI) running tests for this repo. Confirm with maintainers before touching.

---

## 🟢 P2.20 — `npm publish --provenance` (SLSA L2)

**Problem.** Supply-chain attestation isn't enforced in our release workflow. `npm publish --provenance` from GitHub Actions produces a signed Sigstore attestation linking the tarball to the source commit + workflow run. Shows green checkmark on npmjs.com.

**References.**
- [npm package provenance announcement](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/)
- [SLSA + Node.js (slsa.dev)](https://slsa.dev/blog/2023/05/bringing-improved-supply-chain-security-to-the-nodejs-ecosystem)

**Sketch.**
- Update the GitHub Actions release workflow to publish with `--provenance`.
- Requires `id-token: write` permission on the job.
- Document in `docs/development/contributing.md` if not already mentioned.

**Estimate.** ~5 lines in CI YAML + verification. **~30 min.**

---

## 🔵 P3 — backlog (probably not worth their own ticket each)

| # | Item | Note |
|---|---|---|
| 21 | Man page generation | Optional for npm-distributed CLIs; `commander-help-man` if we ever migrate to Commander |
| 22 | Hyperfine startup regression test in CI | Defends ≤100 ms goal once #16 lands |
| 23 | Width-aware `--help` (`min($COLUMNS, 100)`) | Minor — fixed-width is acceptable |
| 24 | `--update-check` (warn on outdated version) | Adds startup network call; controversial |
| 25 | Telemetry opt-in (with `DO_NOT_TRACK` respect) | Likely never — privacy posture |
| 26 | URL scheme allowlist (`https:` only by default) | Currently any valid URL accepted; might break local dev |
| 27 | `@file` path traversal allowlist | User runs this on their own machine — design choice not to restrict |
| 28 | Dedicated `openl-cli` bin alongside `openl-mcp` | Slight discoverability win; doubles install footprint |

---

## Where to track these

When picking one up, file under the EIS Jira project with **EPBDS-16027** as a related/follow-up link and reference the section in this doc.

Suggested grouping for tickets:

| Ticket bundle | Contains | Effort |
|---|---|---|
| **CLI UX polish** | P1.4 + P1.7 + P1.8 + P2.10 | ~4 hours |
| **CLI session & config** | P2.9 + P2.15 | ~4.5 hours |
| **CLI hardening** | P2.11 + P2.14 + P2.16 | ~4 hours |
| **CLI tooling** | P2.12 + P2.18 + P2.19 (P2.17 done) | ~4 hours |
| **Release security** | P2.20a + P2.20 | ~45 min |

---

## See also

- [`../../README.cli.md`](../../README.cli.md) — User-facing CLI guide.
- [`../../src/cli.ts`](../../src/cli.ts) — Current implementation.
- [`../../tests/cli.test.ts`](../../tests/cli.test.ts) — In-process test suite.
- Audit conducted 2026-05-26 against [clig.dev](https://clig.dev/), [sysexits.h](https://man7.org/linux/man-pages/man3/sysexits.h.3head.html), 12-factor §3, smallstep secrets guidance, and reference CLIs (`gh`, `npm`, `kubectl`, `aws v2`, `jest`).
