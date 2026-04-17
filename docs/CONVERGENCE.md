# Convergence — Deprecated Surfaces & Replacement Map

**Version:** Updated v10.5.1 → v10.7.0+  
**Purpose:** Single source of truth for operators, contributors, and CI systems navigating AgentForge's migration from a split root/packages architecture to a canonical package-centered runtime.  
**Scope:** Covers deprecation status, canonical replacements, and removal milestones for all surfaces affected by the v10.5+ convergence.

---

## Executive Summary

AgentForge transitioned from a monolithic root `src/` tree to a modular `packages/*` workspace architecture during v6.0–v10.5. The convergence consolidates this split into one canonical surface.

**Current state (v10.5.1+):**
- ✅ **Canonical:** Package stack (`packages/cli`, `packages/server`, `packages/core`, `packages/dashboard`)
- 🔴 **Deprecated:** Root stack (`src/cli`, `src/server`, legacy dashboard)
- 🟡 **Frozen shims:** Compatibility bridges for users on old entry points

**Timeline:**
- **v10.5.1:** Convergence documented; package stack is canonical.
- **v10.7.0:** Root server purge; legacy dashboard deletion; CLI compatibility shims added.
- **v11.0.0:** Root CLI deprecated with startup warnings; package CLI is primary.
- **v12.0.0:** Root CLI, root server, and legacy shims removed; package stack only.

---

## Surface Mapping: Deprecated → Canonical

### CLI Command Routing

| Deprecated Surface | Canonical Replacement | Current Status | Removal Milestone |
|---|---|---|---|
| `agentforge forge` (root) | `agentforge team forge` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge genesis` (root) | `agentforge team genesis` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge rebuild` (root) | `agentforge team rebuild` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge reforge *` (root) | `agentforge team reforge *` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge invoke` (root) | `agentforge run invoke` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge invoke --loop` (root) | `agentforge cycle run` or `autonomous:cycle` (package) | ❌ Removed v10.7.0 | N/A |
| `agentforge delegate` (root) | `agentforge run delegate` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge cost-report` (root) | `agentforge costs report` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge sessions *` (root) | `agentforge team-sessions *` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge status` (root) | `agentforge info` (package) | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge activate/deactivate` (root) | No replacement; functionality absorbed into team management | ❌ Removed v10.7.0 | N/A |

### Server and API Routes

| Deprecated Surface | Canonical Replacement | Current Status | Removal Milestone |
|---|---|---|---|
| Root Fastify server (`src/server/main.ts`) | Package server (`packages/server/src/main.ts`) | 🟡 Still boots; deprecated path | v10.7.0 |
| `/api/v1/*` endpoints (root) | `/api/v5/*` endpoints (package) | 🟡 Root routes frozen; package routes are canonical | v11.0.0 |
| Root dashboard HTML (`dashboard/index.html`) | SvelteKit dashboard (`packages/dashboard/`) | 🔴 Deprecated; delete v10.7.0 | v10.7.0 |
| Root server startup script | `agentforge start` (package CLI) | 🟡 Frozen shim | v11.0.0 |

### Session and Runtime Flows

| Deprecated Surface | Canonical Replacement | Current Status | Removal Milestone |
|---|---|---|---|
| Root `AgentForgeSession` path (`src/orchestrator/session.ts`) | Package `CycleRunner` (`packages/core/src/autonomous/cycle-runner.ts`) | 🟡 Still functional; routed through package bridges | v11.0.0 |
| Root `invoke` single-shot execution | `agentforge run invoke` (single-shot) or `agentforge cycle run` (looped) | 🟡 Frozen shim | v12.0.0 |
| Root autonomous stubs (`src/autonomous/*`) | Package autonomous adapters (`packages/core/src/autonomous/*`) | 🔴 Deprecated; consolidate v10.7.0 | v10.7.0 |

### File Structure & Artifacts

| Deprecated Surface | Canonical Location | Status | Action |
|---|---|---|---|
| `src/server/` (full tree) | `packages/server/src/` | 🔴 Delete v10.7.0 | Root server purge |
| `src/cli/compat/` bridges | Direct imports from `packages/core` | 🔴 Delete v10.7.0 | Remove compat shims |
| `src/autonomous/*` | `packages/core/src/autonomous/*` | 🔴 Migrate & delete v10.7.0 | Runtime consolidation |
| `dashboard/` HTML/pages | `packages/dashboard/` | 🔴 Delete v10.7.0 | Dashboard consolidation |
| `src/index.ts` plugin export (v0.1.0) | Package manifests (10.5.0+) | 🟡 Version mismatch | Audit & fix v10.7.0 |

---

## Deprecation Notices & Warnings

### v10.5.1 (Current)

**Root CLI status:** Stub with deprecation notice on every invocation.

```
[compat] Root CLI is deprecated and has no commands.
[compat] All AgentForge commands now live in the package CLI.
[compat] Usage: npm exec agentforge -- <command> (or use packages/cli directly)
[compat] To suppress: set AGENTFORGE_SUPPRESS_DEPRECATION=1
```

**Suppression:** Set `AGENTFORGE_SUPPRESS_DEPRECATION=1` in the environment; tests and CI scripts may use `AGENTFORGE_BRIDGED=1`.

---

### v10.7.0 (Planned)

**Removals:**
- ❌ `src/server/` fully deleted; all server traffic routes through `packages/server`
- ❌ `dashboard/` legacy HTML deleted; all UI traffic routes to SvelteKit at `packages/dashboard`
- ❌ `src/autonomous/*` migrated to `packages/core/src/autonomous/`; root directory removed
- ❌ `src/cli/compat/*` bridges deleted; direct package imports inlined

**Freeze points:**
- 🟡 Root CLI commands frozen as thin delegation shims
- 🟡 Root `/api/v1/*` routes frozen; no new endpoints added

**Startup warnings:**
- ⚠️ Any root CLI command will warn: `"<cmd> is deprecated; use '<canonical>' instead"`
- ⚠️ Package versions synchronized: root `package.json` and `packages/*/package.json` aligned to `10.7.0`
- ⚠️ CHANGELOG and README updated to reflect true v10.7.0 state

---

### v11.0.0 (Planned)

**Removals:**
- ❌ Root CLI commands removed entirely (no delegation possible)
- ❌ Root server removed from package.json bin/scripts
- ❌ `/api/v1/*` routes removed; only `/api/v5/` supported

**Behavior changes:**
- Root `src/orchestrator/` runtime paths rerouted to package `CycleRunner`
- Startup scripts in root `package.json` point only to `packages/cli`

---

### v12.0.0 (Planned)

**Removals:**
- ❌ Full root `src/` tree removed from build graph (only if all migration is complete)
- ❌ All compatibility shims deleted
- ❌ `tsconfig.json` no longer includes root paths; only `packages/*`
- ❌ Root CLI index (`src/cli/index.ts`) removed
- ❌ Root server bootstrap (`src/server/main.ts`) removed

**Final state:**
- Package stack is the only runtime
- `packages/*` is the exclusive build target
- No compatibility layer needed

---

## Migration Paths by Entrypoint

### Users on Root CLI Commands

**Current (v10.5.1+):**
```bash
# Deprecated (prints warning)
agentforge forge
agentforge genesis
agentforge invoke mytask
agentforge cycle run

# Use instead (no warning, canonical)
agentforge team forge
agentforge team genesis
agentforge run invoke mytask
agentforge cycle run
```

**After v11.0.0:**
Root commands will fail entirely; package commands required.

### Users on Root Server

**Current (v10.5.1+):**
```bash
# Deprecated (still boots, but v10.7.0 will remove)
npm run start:root  # or custom root server script

# Use instead (canonical)
npm exec agentforge -- start
# OR
npm --workspace @agentforge/server start
```

**After v10.7.0:**
Root server no longer available; only package server.

### Users on Legacy Dashboard

**Current (v10.5.1):**
```
http://localhost:4750/dashboard/  # legacy root HTML dashboard
```

**Use instead (canonical):**
```
http://localhost:4751/            # SvelteKit dashboard (dev)
                                   # Requires Vite + package server running
```

**After v10.7.0:**
Legacy HTML dashboard deleted; package dashboard is only option.

---

## Deprecation Enforcement in CI

### Release Gate (v10.7.0+)

The `.github/workflows/release.yml` enforces convergence at tag time:

```bash
# Fail the release if root src/server/ or src/cli/compat/ still exist
if [[ -d "src/server" ]] || [[ -d "src/cli/compat" ]]; then
  echo "❌ Convergence violation: root server or CLI compat paths still exist"
  exit 1
fi
```

### Pre-Commit Hook (Recommended)

Contributors should set up a hook to catch regressions:

```bash
# .husky/pre-commit or similar
git diff --cached --name-only | grep -E '^src/(server|cli/compat)/' && \
  echo "❌ Do not add to deprecated root paths. Use packages/* instead." && \
  exit 1
```

---

## Version Alignment

### Current Version State

| Component | Version | Status | Target (v10.7.0) |
|---|---|---|---|
| Root `package.json` | `10.5.1` | ✅ Aligned to release line | `10.7.0` |
| `packages/core/package.json` | `6.0.0` | 🔴 Drift | `10.7.0` |
| `packages/server/package.json` | `6.0.0` | 🔴 Drift | `10.7.0` |
| `packages/dashboard/package.json` | `6.0.0` | 🔴 Drift | `10.7.0` |
| `packages/cli/package.json` | `6.0.0` | 🔴 Drift | `10.7.0` |
| `src/index.ts` plugin export | `0.1.0` | 🔴 Stale | Delete or sync |
| Root server identifies as | `v6.2` | 🔴 Incorrect | `v10.7.0` |
| Package server identifies as | `v6.0` | 🔴 Incorrect | `v10.7.0` |

**Action:** v10.7.0 sprint aligns all workspace manifests and runtime version strings to a single release line.

---

## Document Ownership

- **Owners:** Platform/Runtime lead, CLI lead, Docs lead
- **Reviewers:** All contributors
- **Update frequency:** Per minor release (v10.x → v11.x, etc.)
- **Last updated:** v10.5.1
- **Next review:** v10.7.0 convergence merge

### Change Protocol

When deprecating a surface:
1. Add a row to the appropriate table above with status 🟡 (frozen shim) or 🔴 (pending deletion)
2. Implement the deprecation warning in code (environment variable gating for tests)
3. Document the removal milestone
4. Update CHANGELOG with "Deprecation" subsection
5. Link the CHANGELOG entry from this document

---

## FAQ

**Q: Can I still use the root CLI?**  
A: Yes, until v11.0.0. It will print warnings. After v11.0.0, you must use the package CLI.

**Q: What if my scripts call root commands?**  
A: Before v11.0.0, add `AGENTFORGE_SUPPRESS_DEPRECATION=1` to suppress warnings. After v11.0.0, migrate scripts to use `agentforge <cmd>` from `packages/cli`. See _Migration Paths by Entrypoint_ above.

**Q: Is the root server still functional?**  
A: Yes, until v10.7.0. After v10.7.0, only the package server exists. Update your startup scripts to use `agentforge start` instead of root server bootstrap.

**Q: What about existing sessions or cycles from the old server?**  
A: The package server reads `.agentforge/` artifacts written by both root and package paths. Existing data is compatible. The server bootstrap is the only thing changing, not the artifact format.

**Q: Why the split in the first place?**  
A: AgentForge grew from a single-tree CLI (v1–v3) into a modular multi-agent platform (v4–v6) with package-based autonomy (v6+). The root tree holds legacy logic; the packages hold the new runtime. Convergence consolidates this for clarity and reduced maintenance.

**Q: When will v12.0.0 land?**  
A: Not yet planned. Convergence is a v10.x → v11.x arc. v12.0.0 is a future milestone once all surfaces are frozen as shims and ready to delete.

---

## See Also

- [Architecture Truth (v10.5.1)](./superpowers/specs/2026-04-15-current-architecture-truth.md) — Current codebase structure
- [Root-vs-Packages Gap Matrix](./superpowers/plans/2026-04-15-root-vs-packages-runtime-gap-matrix.md) — Detailed convergence rationale
- [v10.7.0 Convergence Purge Backlog](./superpowers/specs/2026-04-16-v107-convergence-purge.md) — Sprint items for convergence
- [CHANGELOG.md](../CHANGELOG.md) — Release history and version alignment
- [README.md](../README.md) — User-facing guide (updated per release)
