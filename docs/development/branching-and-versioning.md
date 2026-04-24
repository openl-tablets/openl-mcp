# Branching & Versioning Strategy

Simplified Git workflow for the OpenL MCP Server project.

## Branches

| Branch | Purpose | Versions |
|---|---|---|
| `main` | Active development + release tags | v1.0.0, v1.1.0... |
| `release/X.Y.x` | Hotfix support for released version | X.Y.1, X.Y.2... |
| `feature/*` | New features, merge to `main` | — |
| `fix/*` | Hotfixes, merge to `release/X.Y.x` | — |

## Lifecycle Example: 1.0.x → 1.1.x → 1.2.x

```
main
 │
 │ v1.0.0        v1.0.1    v1.0.2  v1.1.0        v1.1.1          v1.2.0
 ●───●───●───●──────●─────────●───────●───●───●──────●───────●──────●───●──
     │               ▲         ▲       │   │         ▲        │      │
     │               │  cherry-pick    │   │         │        │      │
     │               │         │       │   │         │        │      │
     │ release/1.0.x │         │       │   │         │        │      │
     └──●────────────●─────────●──EOL  │   │         │        │      │
        │  fix/auth   ▲ fix/oom ▲      │   │         │        │      │
        │  ●──●───────┘ ●──●───┘       │   │         │        │      │
        │                              │   │         │        │      │
        │ feature/trace-api            │   │         │        │      │
        │ ●──●──●──────────────────────┘   │         │        │      │
        │          feature/prompts         │         │        │      │
        │          ●──●────────────────────┘         │        │      │
        │                                            │        │      │
        │              release/1.1.x                 │        │      │
        │              └──●──────────────────────────●──EOL   │      │
        │                 │  fix/trace-timeout        ▲       │      │
        │                 │  ●──●────────────────────┘        │      │
        │                 │          cherry-pick → main        │      │
        │                 │                                    │      │
        │                 │ feature/rate-limit                 │      │
        │                 │ ●──●──●────────────────────────────┘     │
        │                          feature/logging                   │
        │                          ●──●──────────────────────────────┘
```

**Timeline:**

1. `v1.0.0` released → create `release/1.0.x`
2. Hotfixes `fix/auth`, `fix/oom` → merge to `release/1.0.x` → tag `v1.0.1`, `v1.0.2` → cherry-pick to `main`
3. Features `trace-api`, `prompts` developed on `main`
4. `v1.1.0` released → create `release/1.1.x` → `release/1.0.x` EOL (by default)
5. Hotfix `fix/trace-timeout` → merge to `release/1.1.x` → tag `v1.1.1` → cherry-pick to `main`
6. Features `rate-limit`, `logging` developed on `main`
7. `v1.2.0` released → create `release/1.2.x` → `release/1.1.x` EOL (by default)

## Versioning (semver)

```
MAJOR.MINOR.PATCH

1.0.0  — first release
1.0.1  — bugfix (patch): backward-compatible fix
1.0.2  — another bugfix
1.1.0  — minor: new features (trace tools, etc.), backward-compatible
2.0.0  — major: breaking changes (removed tools, changed API)
```

The `package.json` version, the git tag, and the npm publish are produced
by the **Release (npm)** workflow — see [Release](#release) below. You don't
run `npm version` locally for releases.

## Workflows

### New Feature

```bash
git checkout main
git checkout -b feature/trace-api
# ... develop ...
# PR → main
```

### Release

Releases are cut from the **Release (npm)** GitHub Actions workflow. The
workflow is the single source of truth: it bumps `package.json`, commits,
tags, builds, publishes the npm package, and pushes commit + tag back to the
branch.

1. Make sure `main` (or the release branch you're releasing from) is in the
   shape you want to ship.
2. Open **Actions → Release (npm) → Run workflow**, pick the bump type
   (`patch` / `minor` / `major` / `prepatch` / `preminor` / `premajor` /
   `prerelease`) and the right source branch in the dropdown — the
   commit/tag are pushed back to that branch.
3. Create the release branch from the tag for the next minor:

   ```bash
   git fetch --tags
   git checkout -b release/1.1.x 1.1.0
   git push -u origin release/1.1.x
   ```

4. Decide on the previous release branch (see EOL Policy below).

### Hotfix

```bash
# 1. Fix on release branch
git checkout release/1.1.x
git checkout -b fix/timeout-bug
# ... fix ...
# PR → release/1.1.x
```

2. Cut a patch release: open **Actions → Release (npm) → Run workflow**,
   pick branch `release/1.1.x` and bump type `patch`. The workflow tags
   `1.1.1` (or whatever the next patch is) on that branch and publishes to
   npm.
3. Bring the fix back to `main`:

   ```bash
   git checkout main
   git cherry-pick <fix-commit>
   # Or: merge release/1.1.x → main (if multiple fixes accumulated)
   ```

4. If multiple release branches are supported (LTS), cherry-pick to each:

   ```bash
   git checkout release/1.0.x && git cherry-pick <fix-commit>
   ```

## Release Lifecycle & EOL Policy

By default, only the **latest** release branch is actively maintained.
Older branches receive no further patches and can be deleted.

If consumers depend on older versions, keep multiple release branches alive (LTS model):

```
                          v1.0.3 (security-only)      v1.0.4
release/1.0.x  ──●────●────●───────────────────────────●──── ... (LTS until date X)
                                                        ▲
                              fix/CVE-5678  ●──●────────┘
                                            │
                          v1.1.1            │ cherry-pick to all supported branches
release/1.1.x  ──●────●────●───────────────●──●──── ... (active support)
                             ▲              ▲
                             │              │
main           ──●────●──────●──────●───────●────●──── ... (development)
```

**Support tiers:**

| Tier | What gets patched | Duration |
|---|---|---|
| **Active** (latest release) | Bugs + security + minor improvements | Until next release |
| **LTS** (older releases, if needed) | Security & critical bugs only | Fixed date (e.g., 6 months after next release) |
| **EOL** | Nothing, branch archived/deleted | — |

**When to use LTS:**
- External consumers pinned to a specific major/minor version
- Breaking changes in newer versions that consumers can't adopt quickly
- Contractual or compliance requirements for specific versions

**When single active branch is enough:**
- Internal project, all consumers migrate immediately
- No breaking changes between minors (our current case)

**Current project decision:** Single active branch (no LTS). Revisit if external consumers appear.

## Rules

1. **`main` is always deployable** — broken builds must be fixed immediately.
2. **Tags are immutable** — never move or delete a release tag.
3. **Hotfixes go to `release/X.Y.x` first**, then cherry-pick to `main`.
4. **Features go to `main` directly** (via feature branches + PR).
5. **One active release branch by default.** Keep multiple only if LTS is needed (see EOL Policy).
