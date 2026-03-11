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

Update `package.json` version before tagging:

```bash
npm version minor   # 1.0.0 → 1.1.0 (auto-creates commit + tag)
npm version patch   # 1.1.0 → 1.1.1
npm version major   # 1.1.1 → 2.0.0
```

## Workflows

### New Feature

```bash
git checkout main
git checkout -b feature/trace-api
# ... develop ...
# PR → main
```

### Release

```bash
# 1. Bump version and tag
git checkout main
npm version minor                # creates commit + tag v1.1.0

# 2. Create support branch from the tag
git checkout -b release/1.1.x

# 3. Decide on previous release branch (see EOL Policy below)
```

### Hotfix

```bash
# 1. Fix on release branch
git checkout release/1.1.x
git checkout -b fix/timeout-bug
# ... fix ...
# PR → release/1.1.x

# 2. Bump patch version and tag
git checkout release/1.1.x
npm version patch                # creates commit + tag v1.1.1

# 3. Bring fix to main
git checkout main
git cherry-pick <fix-commit>
# Or: merge release/1.1.x → main (if multiple fixes accumulated)

# 4. If multiple release branches are supported (LTS), cherry-pick to each:
# git checkout release/1.0.x && git cherry-pick <fix-commit>
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
