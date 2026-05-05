# v10.7.0 Convergence Purge — Backlog

This is the planted backlog for the autonomous loop's v10.7.0 cycle. Each `TODO(autonomous):` line below is picked up by the proposal scanner and ranked into a sprint. Scope is framed by `docs/superpowers/plans/2026-04-15-root-vs-packages-runtime-gap-matrix.md` (gaps G1–G8).

The intent of v10.7.0 is to **finish the convergence** that v10.5.1 started: collapse duplicated root/package runtime surfaces, sync versions, fix the residual test failures carried out of v10.6.0, and make the CHANGELOG/README tell the truth.

## Root server purge (G3)

TODO(autonomous): Delete the legacy root Fastify server at src/server/main.ts and src/server/server.ts. Move any remaining unique routes (inspect src/server/routes/*) into packages/server/src/routes/v5/ or confirm they are already duplicated. Update package.json bin/scripts to remove any root-server entrypoints. All server traffic must route through packages/server.

TODO(autonomous): Remove src/server/routes/flywheel.ts and src/server/routes/search.ts. The canonical versions live at packages/server/src/routes/v5/dashboard-stubs.ts and packages/server/src/routes/v5/search.ts. Delete the root versions and any test files that only cover them.

DONE(v13.0.0): Deleted the deprecated root dashboard at dashboard/index.html and dashboard/pages/. The SvelteKit dashboard under packages/dashboard is the canonical UI. Scrubbed references from docs/CONVERGENCE.md (status rows updated to ✅ Deleted v11.0.0). No references found in root scripts, commands, or README. The directory itself was already removed in v11.0.0.

## Root CLI surface collapse (G2)

TODO(autonomous): Audit src/cli/commands/* against packages/cli/src/commands/*. For each root command, either (a) delete it if duplicated, or (b) convert it to a thin shim that delegates to the package CLI via a spawn or direct import. Report the disposition in the commit message.

TODO(autonomous): Remove src/cli/compat/* bridges that are no longer referenced. Specifically src/cli/compat/package-run-services.ts and src/cli/compat/package-team-services.ts — check every caller, inline the direct package-core import, and delete the bridge module.

DONE(v12.0.0): Consolidated `invoke --loop` — flag removed from root CLI (src/cli/commands/invoke.ts deleted, dist/ compat wrapper has no --loop). Loop execution canonicalized in package CLI's `autonomous:cycle` command. Docs updated.

## Version and docs sync (G5)

TODO(autonomous): Update README.md to reflect the v10.7.0 state. Delete v6-era command tables, and add a "Deprecated surfaces" section listing the root CLI and root server with the target removal version. (Note: `invoke --loop` references already removed from README.)

TODO(autonomous): Audit CHANGELOG.md for gaps. Ensure every minor release from 10.5.0 through 10.6.0 has an entry with Convergence / Security / CI / Docs subsections matching the house style established in 10.5.1. Fill missing entries by inspecting git log.

TODO(autonomous): Verify src/index.ts plugin export version string — it still reports 0.1.0 despite being part of the 10.x release line. Either make it read from package.json or delete the plugin export if nothing consumes it.

## v10.6.0 test-failure triage

TODO(autonomous): Investigate the 8 failing tests from cycle 4424e214 (v10.6.0 ship). Run `npm test` and enumerate the failing files. For each: either fix the underlying bug (preferred) or, if the test encodes outdated behavior, delete the test and document why in the commit.

TODO(autonomous): Run `svelte-check` on packages/dashboard and fix every type error. MODEL_TIERS undefined errors were flagged in prior specs; verify they are actually resolved now that /runner has been wired. Commit the svelte-check output as evidence.

## Deprecation policy + compatibility (G8)

TODO(autonomous): Create docs/CONVERGENCE.md documenting which root surfaces are deprecated, which are frozen shims, and when each will be removed. Include a table mapping root entrypoint → canonical package replacement → removal milestone.

TODO(autonomous): Add a one-time startup warning to any remaining root CLI commands that delegate to a package — "this command is deprecated; use `agentforge <x>` instead" — printed to stderr. Gate it behind a flag so tests don't spam.

## Dashboard operator UX (G7)

DONE(v13.0.0): Verified no production code path serves dashboard/index.html. The directory was already removed in v11.0.0 (no disk presence confirmed). CONVERGENCE.md updated to reflect completion.

TODO(autonomous): Add a top-level banner to the SvelteKit dashboard showing the current package version and a link to the CHANGELOG section for that version. This is the single-source-of-truth fix for G5 from the operator's side.

## Package autonomous launcher finish (G6)

TODO(autonomous): Audit packages/cli/src/commands/autonomous.ts for stubbed proposal/scoring adapters. Replace every stub with the real adapter from packages/core/src/autonomous/*. Remove smoke-test scaffolding. The goal: package CLI `autonomous:cycle` produces byte-identical output to what the server's POST /api/v5/cycles spawns.

TODO(autonomous): Migrate the remaining root `src/autonomous/` references (if any) into packages/core/src/autonomous/. Delete the root directory. Any test fixtures in tests/ that import from root should switch to the package import.

## CI and release hygiene

TODO(autonomous): Add a release gate to .github/workflows/release.yml that fails the build if any root-level src/server/ or src/cli/compat/ path still exists at tag time. This enforces the convergence at CI level rather than relying on reviewers to notice.

TODO(autonomous): Pin the Node version in .nvmrc and ensure packages/*/package.json all set the same `engines.node` range. Version drift between packages is a known G5 risk surface.

## Memory-flow integration (carry-over from v10.6.0)

TODO(autonomous): Complete tests/integration/memory-flow.test.ts if it was not finished in v10.6.0. Validates cross-cycle memory write and audit-prompt inclusion. This was ranked last in the prior sprint and may have slipped.

## Dashboard polish

TODO(autonomous): Verify every dashboard route still renders after the root-server purge. Walk through /, /cycles, /cycles/[id], /sprints, /sprints/[version], /workspaces, /agents, /approvals, /branches, /cost, /flywheel, /health, /knowledge, /live, /memory, /org, /plugins, /runner, /search, /sessions, /settings. Any regressions land before the cycle completes.

TODO(autonomous): Fix the cycle-detail page to gracefully handle cycles whose cycle.json is never written (killed cycles). Current code assumes either terminal cycle.json or in-progress 404+cycleInProgress — there's a gap for killed cycles with partial phase data.

## Residual root src/ references blocking CI typecheck (carry-over from v10.6.0 merge, 2026-05-05)

After merging PR #16 (v10.6.0 convergence purge), CI on main still fails Type Check (20.19.x) and Build because remaining root `src/` files import `@agentforge/core` symbols that aren't built before typecheck runs. Specific failing files observed in CI annotations:

TODO(autonomous): Migrate or delete `src/cli/compat/package-run-services.ts` — typecheck reports `Cannot find module '@agentforge/core'`. Either inline the package-core import directly into callers and delete the bridge, or ensure the typecheck target builds packages/core first.

TODO(autonomous): Migrate or delete the entire `src/builder/` tree (template-loader, template-customizer, team-writer, team-composer, agent-validator, index). All files import from `@agentforge/core` and fail typecheck. Per the v10.5.x convergence direction, builder logic should live at `packages/core/src/team/engine/` or similar. Audit which files in this tree are still referenced and either migrate or delete.

TODO(autonomous): Fix the typecheck job ordering in `.github/workflows/ci.yml` so `pnpm build` (or at minimum `pnpm --filter @agentforge/core build`) runs before `tsc --noEmit`. Many root files reference `packages/core/dist/memory/types.d.ts` which doesn't exist until core builds. Without this fix, even after migrating root src files away, transient typecheck failures will recur whenever a fresh checkout types-checks before a build.

TODO(autonomous): After all root src/ migrations land, run the convergence-gate that release.yml already enforces (fails if `src/server/` or `src/cli/compat/` exist) and extend it to also fail if `src/builder/` or `src/autonomous/` exist as root directories. The gate should encode the final state.

## CI green re-baseline (carry-over from v10.6.0 merge, 2026-05-05)

After landing the convergence purge plus PR #19 (security hardening) plus the dependabot bumps, CI has not yet been observed green on main. Both the v10.6.0 merge and the security PR were admin-merged because their failures were pre-existing main breakage, not regressions.

TODO(autonomous): Run the full `pnpm verify:gates` locally on main and document every failing test/typecheck. For each, classify as (a) stale test referencing a deleted root path → delete or update the test, or (b) genuine regression → fix. The goal is one clean CI run on main before v10.7.0 ships.
