# Convergence — Deprecated Surfaces & Replacement Map

**Version:** Updated v10.5.1 → v10.7.0+  
**Purpose:** Single source of truth for operators, contributors, and CI systems navigating AgentForge's migration from a split root/packages architecture to a canonical package-centered runtime.  
**Scope:** Covers deprecation status, canonical replacements, and removal milestones for all surfaces affected by the v10.5+ convergence.

---

## Executive Summary

AgentForge transitioned from a monolithic root `src/` tree to a modular `packages/*` workspace architecture during v6.0–v10.5. The convergence consolidates this split into one canonical surface.

**Current state (v10.7.0+):**
- ✅ **Canonical:** Package stack (`packages/cli`, `packages/server`, `packages/core`, `packages/dashboard`)
- ✅ **Deleted:** Root server (`src/server/`), legacy dashboard (`dashboard/`), CLI compat bridges (`src/cli/compat/`)
- 🟡 **Frozen shims:** Root CLI commands still delegate to package CLI (removal target: v11.0.0)

**Timeline:**
- **v10.5.1:** Convergence documented; package stack is canonical.
- **v10.7.0:** ✅ Root server purge complete; legacy dashboard deleted; CLI compat bridges removed.
- **v11.0.0:** Root CLI commands removed entirely; package CLI is the only entry point.
- **v12.0.0:** Full root `src/` tree removed from build graph; package stack only.

---

## Surface Mapping: Deprecated → Canonical

### Root CLI

All root CLI commands are deprecated and delegate to their package-canonical equivalents in `@agentforge/cli`. Removal target: v11.0.0 (commands removed entirely); v12.0.0 (root CLI entry point removed).

| Deprecated Root CLI | Canonical Package CLI | Current Status | Removal Milestone |
|---|---|---|---|
| `agentforge forge` | `agentforge team forge` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge genesis` | `agentforge team genesis` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge rebuild` | `agentforge team rebuild` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge reforge *` | `agentforge team reforge *` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge invoke` | `agentforge run invoke` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge invoke --loop` | `agentforge cycle run` or `autonomous:cycle` | ❌ Removed v10.7.0 | N/A |
| `agentforge delegate` | `agentforge run delegate` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge cost-report` | `agentforge costs report` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge sessions *` | `agentforge team-sessions *` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge status` | `agentforge info` | 🟡 Frozen shim with deprecation warning | v12.0.0 |
| `agentforge activate/deactivate` | No replacement; functionality absorbed into team management | ❌ Removed v10.7.0 | N/A |

**Key:** Each root command in `src/cli/commands/` (e.g., `forge.ts`, `genesis.ts`) is a thin wrapper that imports and re-exports from `packages/cli/src/commands/`. See [CLI_AUDIT.md](../CLI_AUDIT.md) for detailed disposition.

### Root Server

The root Fastify server (`src/server/main.ts`) and all associated routes have been deleted as of v10.7.0. The package server (`packages/server/src/main.ts`) is the canonical runtime.

| Deprecated Root Surface | Canonical Package Surface | Current Status | Removal Milestone |
|---|---|---|---|
| Root Fastify server (`src/server/main.ts`) | Package server (`packages/server/src/main.ts`) | ✅ Deleted v10.7.0 | N/A |
| Root server auth (`src/server/auth/*`) | Package auth (`packages/server/src/lib/auth/`) | ✅ Migrated v10.7.0 | N/A |
| Root server SSE (`src/server/sse/*`) | Package SSE (`packages/server/src/lib/sse/`) | ✅ Migrated v10.7.0 | N/A |
| Root API routes (`src/server/routes/*`) | Package API v5 routes (`packages/server/src/routes/v5/*`) | ✅ Migrated v10.7.0 | N/A |
| `/api/v1/*` endpoints (root) | `/api/v5/*` endpoints (package) | 🟡 Root routes frozen; package routes are canonical | v11.0.0 |
| Root dashboard HTML (`dashboard/index.html`) | SvelteKit dashboard (`packages/dashboard/`) | ✅ Deleted v11.0.0 | N/A |
| Root server startup script | `agentforge start` (package CLI) | ✅ Deleted v10.7.0 | N/A |

**Key:** See [Deprecation Enforcement in CI](#deprecation-enforcement-in-ci) for automated checks preventing regression.

### Root Builder

The root team-building and genesis engine (`src/genesis/*`, `src/scanner/*`, `src/reforge/*`) are deprecated stubs that re-export from the package-canonical implementations in `packages/core/src/team/engine/`. All builder logic now lives in the `@agentforge/core` package.

The core builder tree (`src/builder/`) was deleted entirely in v15.0.0 — those six files were compatibility shims that failed typecheck; the canonical implementations at `packages/core/src/team/engine/builder/` are unaffected.

| Deprecated Root Module | Canonical Package Module | Current Status | Removal Milestone |
|---|---|---|---|
| `src/builder/` (full tree) | `packages/core/src/team/engine/builder/` | ✅ Deleted v15.0.0 | N/A |
| `src/builder/agent-validator.ts` | `packages/core/src/team/engine/builder/agent-validator.ts` | ✅ Deleted v15.0.0 | N/A |
| `src/builder/template-loader.ts` | `packages/core/src/team/engine/builder/template-loader.ts` | ✅ Deleted v15.0.0 | N/A |
| `src/builder/template-customizer.ts` | `packages/core/src/team/engine/builder/template-customizer.ts` | ✅ Deleted v15.0.0 | N/A |
| `src/builder/team-composer.ts` | `packages/core/src/team/engine/builder/team-composer.ts` | ✅ Deleted v15.0.0 | N/A |
| `src/builder/team-writer.ts` | `packages/core/src/team/engine/builder/team-writer.ts` | ✅ Deleted v15.0.0 | N/A |
| `src/builder/index.ts` | `packages/core/src/team/engine/builder/index.ts` | ✅ Deleted v15.0.0 | N/A |
| `src/genesis/` (full tree) | `packages/core/src/team/engine/genesis/` | 🟡 Stubs re-export from package | v11.0.0 |
| `src/genesis/brief-builder.ts` | `packages/core/src/team/engine/genesis/brief-builder.ts` | 🟡 Compatibility shim | v11.0.0 |
| `src/genesis/discovery.ts` | `packages/core/src/team/engine/genesis/index.ts` | 🟡 Compatibility shim | v11.0.0 |
| `src/genesis/team-designer.ts` | `packages/core/src/team/engine/genesis/team-designer.ts` | 🟡 Compatibility shim | v11.0.0 |
| `src/scanner/` (full tree) | `packages/core/src/team/engine/scanner/` | 🟡 Stubs re-export from package | v11.0.0 |
| `src/reforge/` (full tree) | `packages/core/src/team/engine/reforge/` | 🟡 Stubs re-export from package | v11.0.0 |
| Root `forge` command entrypoint | `packages/cli/src/commands/team.ts:team forge` | 🟡 Delegates via CLI | v12.0.0 |
| Root `genesis` command entrypoint | `packages/cli/src/commands/team.ts:team genesis` | 🟡 Delegates via CLI | v12.0.0 |

**Key:** Remaining root builder files (`src/genesis/`, `src/scanner/`, `src/reforge/`) contain this header:
```typescript
/**
 * Root compatibility shim for the package-canonical team genesis/scanner/reforge engine.
 */
export * from '@agentforge/core';
```

### Root Autonomous

The root autonomous runtime (`src/orchestrator/session.ts`, `src/autonomous/*` stubs) are deprecated in favor of the package-canonical cycle runner and phase handlers in `packages/core/src/autonomous/`. All agent execution now routes through `CycleRunner` and the autonomous phase pipeline.

| Deprecated Root Module | Canonical Package Module | Current Status | Removal Milestone |
|---|---|---|---|
| Root `AgentForgeSession` (`src/orchestrator/session.ts`) | Package `CycleRunner` (`packages/core/src/autonomous/cycle-runner.ts`) | 🟡 Still functional; routed through package bridges | v11.0.0 |
| Root `invoke` single-shot execution (`src/orchestrator/invoke.ts`) | `agentforge run invoke` (CLI) or `ExecutionService` (package) | 🟡 Frozen shim | v12.0.0 |
| Root `invoke --loop` looped execution | `agentforge cycle run` or `autonomous:cycle` (package) | ❌ Removed v10.7.0 | N/A |
| Root autonomous stubs (`src/autonomous/*`) | Package autonomous adapters (`packages/core/src/autonomous/*`) | 🔴 Deprecated; consolidate v10.7.0 | v10.7.0 |
| Root cycle phases (`src/lifecycle/phase-*.ts`) | Package phase handlers (`packages/core/src/autonomous/phase-handlers/`) | 🟡 Routed through package bridges | v11.0.0 |
| Root budget enforcement (`src/budget/`) | Package cost control (`packages/core/src/runtime/cost-control.ts`) | 🟡 Routed through package bridges | v11.0.0 |

**Key:** Runtime execution flows through the unified `CycleRunner`, which orchestrates all autonomy phases (audit, execute, review, gate). Direct use of root `AgentForgeSession` is unsupported after v11.0.0.

---

## File Structure & Artifacts

| Deprecated Surface | Canonical Location | Status | Action |
|---|---|---|---|
| `src/server/` (full tree) | `packages/server/src/` | ✅ Deleted v10.7.0 | Complete |
| `src/cli/compat/` bridges | Direct imports from `packages/core` | 🔴 Delete v10.7.0 | Remove compat shims |
| `src/autonomous/*` | `packages/core/src/autonomous/*` | 🔴 Migrate & delete v10.7.0 | Runtime consolidation |
| `dashboard/` HTML/pages | `packages/dashboard/` | ✅ Deleted v11.0.0 | Complete |
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

### v10.7.0–v13.0.0 (Completed)

**Removals:**
- ✅ `src/server/` fully deleted; all server traffic routes through `packages/server`
- ✅ `dashboard/` legacy HTML deleted (v11.0.0); all UI traffic routes to SvelteKit at `packages/dashboard`
- ✅ `src/autonomous/*` migrated to `packages/core/src/autonomous/`; root directory removed
- ✅ `src/cli/compat/*` bridges deleted; direct package imports inlined

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
- ✅ Root server removed from package.json bin/scripts (completed v10.7.0)
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
- ✅ Root server bootstrap (`src/server/main.ts`) removed (completed v10.7.0)

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

> **v10.7.0+:** The root server (`src/server/main.ts`) has been deleted. Only the package server remains.

**Canonical server (v10.7.0+):**
```bash
# Start via package CLI
npm exec agentforge -- start

# Or directly via package script
node packages/server/dist/main.js

# Or via npm workspace
npm --workspace @agentforge/server start
```

### Users on Legacy Dashboard

> **v11.0.0+:** The legacy root HTML dashboard (`dashboard/index.html` and `dashboard/pages/`) has been deleted. Only the SvelteKit dashboard remains.

**Canonical dashboard (v11.0.0+):**
```
http://localhost:4751/            # SvelteKit dashboard (dev)
                                   # Requires Vite + package server running
```

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
| Root server identifies as | N/A | ✅ Deleted v10.7.0 | N/A |
| Package server identifies as | `v6.0` | 🔴 Incorrect | `v10.7.0` |

**Action:** v10.7.0 sprint aligns all workspace manifests and runtime version strings to a single release line.

---

## Document Ownership

- **Owners:** Platform/Runtime lead, CLI lead, Docs lead
- **Reviewers:** All contributors
- **Update frequency:** Per minor release (v10.x → v11.x, etc.)
- **Last updated:** v10.7.0 (root server purge sprint)
- **Next review:** v11.0.0 convergence merge

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
A: No. The root server (`src/server/main.ts`) was deleted in v10.7.0. Only the package server exists. Use `agentforge start` (package CLI) or `node packages/server/dist/main.js` directly.

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
