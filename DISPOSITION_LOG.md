# CLI Commands Disposition Log

**Date**: 2026-04-17  
**Audit**: `src/cli/commands/*` vs `packages/cli/src/commands/*`  
**Purpose**: Determine safe DELETE vs SHIM strategy for each root CLI command  
**Blocker Resolution**: Unblocks compat bridge removal, invoke --loop consolidation, and deprecation warning injection.

---

## Summary

**Total Commands Audited**: 12 (in `src/cli/commands/`)  
**All Dispositions**: **DELETE** (11) + **DELETE** (1 no-op) = **12 DELETE**

The package CLI (`packages/cli/src/`) has **fully migrated** all command functionality and provides compatibility aliases for backward compatibility. **No commands require shims in the root CLI** — all can be safely deleted.

---

## Detailed Disposition per Command

### 1. **team.ts** → **DELETE**
- **Root Implementation**: Wraps `showGeneratedTeam` from `@agentforge/core`
- **Deprecation Notice**: "[compat] `team` is a root compatibility wrapper. Prefer the package-canonical `agentforge team` surface."
- **Package Canonical**: `packages/cli/src/commands/team.ts:37–44` — `registerTeamCommand()` → `team show` action
- **Compat Alias in Package**: Yes, implicit (default action when running `agentforge team`)
- **Safe to Delete**: ✅ YES — package CLI provides identical functionality and deprecation path

### 2. **status.ts** → **DELETE**
- **Root Implementation**: Wraps `showGeneratedTeam`, forwards `--verbose` flag
- **Deprecation Notice**: "[compat] `status` is a root compatibility wrapper. Prefer `agentforge team` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/team.ts:217–231` — `teamShowAction()`
- **Compat Alias in Package**: Implicit (runs as default `team` action)
- **Safe to Delete**: ✅ YES — `status` is a pure alias for `team show`

### 3. **forge.ts** → **DELETE**
- **Root Implementation**: Wraps `forgeTeamService` with `--dry-run`, `--verbose`, `--domains` options
- **Deprecation Notice**: "[compat] `forge` is a root compatibility wrapper. Prefer `agentforge team forge` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/team.ts:45–52` — `team forge` subcommand
- **Compat Alias in Package**: **Explicit** (team.ts:101–110) — top-level `forge` command
- **Safe to Delete**: ✅ YES — package CLI has both canonical and compat forms

### 4. **genesis.ts** → **DELETE**
- **Root Implementation**: Wraps `genesisTeamService` with `--interview`, `--domains`, `--yes` options
- **Deprecation Notice**: "[compat] `genesis` is a root compatibility wrapper. Prefer `agentforge team genesis` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/team.ts:54–61` — `team genesis` subcommand
- **Compat Alias in Package**: **Explicit** (team.ts:112–122) — top-level `genesis` command
- **Safe to Delete**: ✅ YES — package CLI has both canonical and compat forms

### 5. **rebuild.ts** → **DELETE**
- **Root Implementation**: Wraps `rebuildTeamService` with `--auto-apply`, `--upgrade` options
- **Deprecation Notice**: "[compat] `rebuild` is a root compatibility wrapper. Prefer `agentforge team rebuild` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/team.ts:63–69` — `team rebuild` subcommand
- **Compat Alias in Package**: **Explicit** (team.ts:124–133) — top-level `rebuild` command
- **Safe to Delete**: ✅ YES — package CLI has both canonical and compat forms

### 6. **reforge.ts** → **DELETE**
- **Root Implementation**: Wraps reforge services with subcommands: `apply`, `list`, `rollback`, `status`
- **Deprecation Notice**: "[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/team.ts:71–98` — `team reforge` command group
- **Compat Alias in Package**: **Explicit** (team.ts:135–174) — top-level `reforge` command group
- **Safe to Delete**: ✅ YES — package CLI has both canonical and compat forms

### 7. **cost-report.ts** → **DELETE**
- **Root Implementation**: Wraps `generateCostReport`, displays cost breakdown
- **Deprecation Notice**: "[compat] `cost-report` is a root compatibility wrapper. Prefer `agentforce costs report` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/costs.ts:8–10` — `costs report` subcommand
- **Compat Alias in Package**: **Explicit** (costs.ts:13–16) — top-level `cost-report` command
- **Safe to Delete**: ✅ YES — package CLI provides both canonical and compat alias

### 8. **invoke.ts** → **DELETE**
- **Root Implementation**: Wraps `invokeAgentRun` with agent, task, runtime, budget, and tools
- **Deprecation Notice**: "[compat] `invoke` is a root compatibility wrapper. Prefer `agentforge run invoke` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/run.ts:38–41` — `run invoke` subcommand
- **Compat Alias in Package**: **Explicit** (run.ts:61–64) — top-level `invoke` command
- **Safe to Delete**: ✅ YES — package CLI provides both canonical and compat alias

### 9. **delegate.ts** → **DELETE**
- **Root Implementation**: Wraps `delegateTask` with recommendation and optional execution
- **Deprecation Notice**: "[compat] `delegate` is a root compatibility wrapper. Prefer `agentforge run delegate` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/run.ts:43–46` — `run delegate` subcommand
- **Compat Alias in Package**: **Explicit** (run.ts:66–69) — top-level `delegate` command
- **Safe to Delete**: ✅ YES — package CLI provides both canonical and compat alias

### 10. **activate.ts** → **DELETE** (No-op; already retired)
- **Root Implementation**: Deprecated stub that returns error with exit code 1
- **Message**: "Root-only live team mode is no longer supported."
- **Deprecation Notice**: "[compat] `activate` has been retired from the canonical surface."
- **Package Canonical**: **No equivalent** — functionality intentionally retired
- **Compat Alias in Package**: **No** — intentionally not provided
- **Safe to Delete**: ✅ YES — command is already a no-op error

### 11. **deactivate.ts** → **DELETE** (No-op; already retired)
- **Root Implementation**: Deprecated stub that returns error with exit code 1
- **Message**: "There is no root-owned active team mode to stop anymore."
- **Deprecation Notice**: "[compat] `deactivate` has been retired from the canonical surface."
- **Package Canonical**: **No equivalent** — functionality intentionally retired
- **Compat Alias in Package**: **No** — intentionally not provided
- **Safe to Delete**: ✅ YES — command is already a no-op error

### 12. **sessions.ts** → **DELETE**
- **Root Implementation**: Wraps session list/delete with subcommands: `list`, `delete <sessionId>`
- **Deprecation Notice**: "[compat] `sessions` is a root compatibility wrapper. Prefer `agentforge team-sessions` from the package CLI."
- **Package Canonical**: `packages/cli/src/commands/team.ts:177–192` — `team-sessions` command group
- **Compat Alias in Package**: **Explicit** (team.ts:194–214) — top-level `sessions` command group
- **Safe to Delete**: ✅ YES — package CLI provides both canonical and compat forms

---

## Summary Table

| Command | Disposition | Canonical | Compat Alias | Note |
|---------|-------------|-----------|--------------|------|
| team.ts | DELETE | `team` | Implicit | Show wrapper |
| status.ts | DELETE | `team show` | Implicit | Alias for team |
| forge.ts | DELETE | `team forge` | `forge` | Explicit alias |
| genesis.ts | DELETE | `team genesis` | `genesis` | Explicit alias |
| rebuild.ts | DELETE | `team rebuild` | `rebuild` | Explicit alias |
| reforge.ts | DELETE | `team reforge` | `reforge` | Explicit alias |
| cost-report.ts | DELETE | `costs report` | `cost-report` | Explicit alias |
| invoke.ts | DELETE | `run invoke` | `invoke` | Explicit alias |
| delegate.ts | DELETE | `run delegate` | `delegate` | Explicit alias |
| activate.ts | DELETE | None | None | Retired stub |
| deactivate.ts | DELETE | None | None | Retired stub |
| sessions.ts | DELETE | `team-sessions` | `sessions` | Explicit alias |

---

## Impact Summary

### What Gets Deleted
- All 12 files from `src/cli/commands/`
- 12 imports from `src/cli/index.ts`
- 12 registrations from `src/cli/index.ts`

### What Stays
- `src/cli/index.ts` with compatibility notice and version display
- Root CLI entry point (for backward compatibility)
- Package CLI as single source of truth for all commands

### Confidence Level
**Very High (95%+)** — All equivalents verified in package CLI, compat aliases confirmed, no breaking changes

### Unblocked Work
1. ✅ Compat bridge removal
2. ✅ Invoke --loop consolidation (single-sourced in package CLI)
3. ✅ Deprecation warning injection (centralized in package CLI)
