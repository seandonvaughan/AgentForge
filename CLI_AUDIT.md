# CLI Audit: src/cli/commands/* vs packages/cli/src/commands/*

## Summary
All 12 root CLI commands are **duplicates** or **retired stubs** of package-canonical commands. The root CLI serves only as a compatibility layer with deprecation warnings. Safe to delete all root command files.

## Disposition by Command

### DUPLICATE COMMANDS (11 total) - DELETE
These forward directly to package-core services with identical implementations:

| Root Command | Duplicates | Package Canonical | Status |
|---|---|---|---|
| `forge.ts` | YES | `packages/cli/src/commands/team.ts` → `team forge` | Wrapper, DELETE |
| `genesis.ts` | YES | `packages/cli/src/commands/team.ts` → `team genesis` | Wrapper, DELETE |
| `rebuild.ts` | YES | `packages/cli/src/commands/team.ts` → `team rebuild` | Wrapper, DELETE |
| `reforge.ts` | YES | `packages/cli/src/commands/team.ts` → `team reforge` | Wrapper, DELETE |
| `team.ts` | SHIM | `packages/cli/src/commands/team.ts` | Shim (keep for now) |
| `status.ts` | YES | `packages/cli/src/commands/team.ts` → `team` | Wrapper, DELETE |
| `sessions.ts` | YES | `packages/cli/src/commands/team.ts` → `team-sessions` | Wrapper, DELETE |
| `invoke.ts` | YES | `packages/cli/src/commands/run.ts` → `run invoke` | Wrapper, DELETE |
| `delegate.ts` | YES | `packages/cli/src/commands/run.ts` → `run delegate` | Wrapper, DELETE |
| `cost-report.ts` | YES | `packages/cli/src/commands/costs.ts` → `costs report` | Wrapper, DELETE |

### RETIRED STUBS (2 total) - DELETE
These are intentional error stubs, feature removed entirely:

| Root Command | Message | Status |
|---|---|---|
| `activate.ts` | "live root-only team mode has been retired" | Deprecated stub, DELETE |
| `deactivate.ts` | "live root-only team mode has been retired" | Deprecated stub, DELETE |

## Actions Required

1. Delete all 12 command files from `src/cli/commands/`
2. Update `src/cli/index.ts` to remove all command imports and registrations
3. Result: Root CLI shows compatibility notice but has no commands; users routed to `packages/cli`

## Rationale

- **Convergence**: All command logic now lives in package-canonical location
- **Deprecation path**: Existing scripts with deprecation warnings point users to package CLI
- **Simplification**: Eliminates duplicate codepaths and version skew
- **Gate prerequisite**: Enables safe removal of compat bridges (rank 14 task)
