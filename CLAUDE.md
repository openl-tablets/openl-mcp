# Claude AI Agent Configuration

This document provides instructions for configuring Claude AI to work with OpenL MCP Server.

**👉 See [AGENTS.md](./AGENTS.md) for the agent guide.**

AGENTS.md is the runtime reference an AI agent needs to use the server:
- The full tool catalog (40 tools) and their nuances
- Rules for `local` projects, response formats, and OpenL-specific behaviour
- The 14 prompt templates

How to connect a client and configure it lives in the Quick Start guide, not AGENTS.md.

## Quick Links

- **[AGENTS.md](./AGENTS.md)** - Agent guide (tools, prompts, behaviour)
- **[Quick Start](docs/guides/quick-start.md)** - Connect your AI client to the MCP server

## Code Quality

- Keep the code clean at all times: no dead code (unused files, exports, functions, variables, or unreachable branches) and no unused dependencies. Remove them as soon as they become orphaned.
- Add a third-party library only when it brings significant benefit — that is, it substantially reduces the code we would otherwise write and maintain. Prefer reimplementing small or simple functionality over taking on a dependency.
- When a library is used, keep it on the latest version that is practical for the project.

## Testing

- Tests must exercise real logic — the behavior a unit computes (transformations, branches, parsing, error paths, edge cases) — not static facts. Asserting the shape or literal value of a declared constant, that a literal equals itself, or a type the compiler already guarantees adds no coverage; don't write such tests. A test should fail when behavior regresses, not only when someone edits a constant.
- Do not duplicate tests: cover each behavior once. Before adding a test, check whether an existing one already exercises that path — if so, strengthen it instead of adding a near-copy. A consistency check that cross-validates two independent sources (e.g. code vs. data files) is not a duplicate; it earns its place by catching drift.
- Keep test location and names predictable and meaningful: a unit's tests live in the conventional, obvious place for that unit, and each test name states the behavior it verifies so a failure reads as a plain statement of what broke.
- Follow the file-naming convention so the test layout mirrors `src/`: a unit test for `src/<module>.ts` lives in `tests/<module>.test.ts`, and integration tests (those that drive the MCP surface through the client's mocked HTTP layer) live under `tests/integration/`. Name every test file for the unit it actually exercises.
- A test's scope must match the file it lives in. Do not test one unit's behavior from inside another unit's test file — e.g. `constants.ts`'s `mcpToolName`/`stripToolPrefix` or the `tool-handlers.ts` registry returned by `getAllTools()` do not belong in a server test. Put each test with the code it exercises.
- When code is moved or renamed, move or rename its test file (and update any references to it) in the same change, so the convention above never drifts.

## Documentation

- Keep all documentation up to date with every code change. When a change adds, removes, or alters tools, prompts, dependencies, configuration, or behavior, update the affected docs in the same change — never leave them for later.
- This covers every document, not just the README: `AGENTS.md`, the `README*.md` files, everything under `docs/`, the prompt files in `prompts/`, and the spec docs under `.specify/`.
- Remove obsolete information rather than letting it accumulate: no references to removed tools, prompts, or APIs, and no stale counts, examples, or links.

## Git Commits

- Commit every completed piece of work.
- Write a short, meaningful subject that answers *why* the change was made, not *what* changed — the "what" is already visible in the diff and history.
- The subject should explain the benefit to a user or a developer.
- Add an extended body only when the subject alone cannot convey the meaning gracefully.
- Do NOT add a `Co-Authored-By: Claude` trailer (or any co-author trailer) to commit messages.

## Pull Requests

- Before creating a pull request, add an entry to [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` (in the matching `### Added` / `### Fixed` / etc. section, following the Keep a Changelog format).
- Keep changelog entries short and to the point — describe the user-facing change, not the implementation. No deep technical details.
