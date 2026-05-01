# AgentForge Root-vs-Packages Runtime Gap Matrix

**Prepared:** April 15, 2026  
**Last reviewed:** April 30, 2026  
**Audience:** AgentForge development team  
**Purpose:** Document the current split between the legacy root `src/` runtime and the newer `packages/*` runtime stack, then map the convergence work needed for v3.1 and beyond.

## April 30, 2026 Status Update

This matrix was written before the `10.5.0` convergence cleanup. The repo is still not deleted back to a single source tree, but the current state is now package-canonical rather than equally split:

- `packages/cli`, `packages/core`, `packages/server`, and `packages/dashboard` are aligned to `10.5.0`.
- Root plugin version export now reads root package metadata instead of a stale hardcoded version.
- Root server bootstrap now warns and forwards to the package-canonical server.
- `README.md` and `CHANGELOG.md` now describe the package-canonical command and dashboard surfaces.
- Remaining work is primarily compatibility deletion, policy enforcement, and keeping async run execution covered as the default operator path.

## Executive Summary

AgentForge is no longer a single-tree CLI project. It is now a package-canonical monorepo with a retained compatibility surface:

- the `packages/*` workspace stack owns the modular CLI, core runtime, package server, and dashboard
- the root `src/` tree remains for compatibility exports, root launch shims, and legacy/manual workflow bridge code

The important takeaway is that the canonical direction has been chosen: package-first, root-as-compatibility. The remaining split is still visible in entrypoints and old implementation files, but version/docs drift is no longer the primary signal of the split.

The current risk is architectural drift:

- users can still discover old root implementation files
- contributors can still accidentally patch root code for package-runtime behavior
- compatibility policy and deletion sequencing remain implicit in some areas
- runtime behavior can still diverge where package commands bridge to legacy/manual workflow code

Future convergence work should reduce the retained compatibility surface rather than polishing both branches. The highest-value work now is to keep canonical package surfaces enforced, remove or mark old root implementation paths, and keep async run/SSE behavior documented as it lands.

---

## Scope

This matrix is limited to the root-vs-packages runtime boundary:

- root CLI and root server under `src/`
- package CLI, core runtime, package server, and dashboard under `packages/*`
- versioning, docs, and command surface drift caused by the split
- convergence moves that reduce ambiguity without breaking current users

This document does not attempt a full product roadmap. It is focused on runtime architecture truth and the migration steps needed to converge it.

---

## Current-State Evidence

The repository currently shows a hybrid architecture in code, not just in docs:

- Root release line is `10.5.0` in [package.json](../../../package.json), and the checked package manifests for [packages/cli/package.json](../../../packages/cli/package.json), [packages/core/package.json](../../../packages/core/package.json), [packages/server/package.json](../../../packages/server/package.json), and [packages/dashboard/package.json](../../../packages/dashboard/package.json) also declare `10.5.0`.
- The root plugin export in [src/index.ts](../../../src/index.ts) now reads the root package version rather than reporting a stale hardcoded value.
- The root build graph still compiles `src/**/*` as the primary root source tree, while also referencing workspace packages in [tsconfig.json](../../../tsconfig.json).
- Root CLI commands are registered in [src/cli/index.ts](../../../src/cli/index.ts) and include `forge`, `genesis`, `rebuild`, `reforge`, `invoke`, `delegate`, `cost-report`, `activate`, `deactivate`, and `sessions`.
- Package CLI entrypoints are registered in [packages/cli/src/bin.ts](../../../packages/cli/src/bin.ts) and expose the package-canonical `run`, `costs`, `cycle`, `team`, `team-sessions`, `workspaces`, `migrate`, `info`, and `start` surfaces.
- Root server bootstrap lives in [src/server/main.ts](../../../src/server/main.ts), but now forwards through [src/server/index.ts](../../../src/server/index.ts) to `@agentforge/server` with a compatibility warning. Package server bootstrap lives in [packages/server/src/main.ts](../../../packages/server/src/main.ts) and prints the root package version.
- Root server API assembly is in [src/server/server.ts](../../../src/server/server.ts), with `/api/v1/*` style routes and a local dashboard path.
- Package server API assembly is in [packages/server/src/server.ts](../../../packages/server/src/server.ts), with `/api/v5/*`, `/api/v6/*`, WebSocket bridges, workspace routing, cycles, search, execution, and plugin routes.
- The autonomous cycle is currently led from the package stack: [packages/server/src/routes/v5/cycles.ts](../../../packages/server/src/routes/v5/cycles.ts) spawns `packages/cli/dist/bin.js autonomous:cycle`, and [packages/core/src/autonomous/cycle-runner.ts](../../../packages/core/src/autonomous/cycle-runner.ts) owns the cycle engine.
- Root `invoke` now uses `AgentForgeSession` in [src/cli/commands/invoke.ts](../../../src/cli/commands/invoke.ts), but `--loop` still prints a placeholder message instead of entering a control loop.
- Root `genesis` is more complete than before, but it still sits inside the legacy root CLI surface in [src/cli/commands/genesis.ts](../../../src/cli/commands/genesis.ts).
- Dashboard runner behavior now defaults to async run starts: clients should tolerate default `202 Accepted` start responses and compatibility `?wait=true` synchronous `200` completion responses, then consume `/api/v5/stream` `agent_activity` chunks and `workflow_event` completion by `sessionId`.

This is enough evidence to treat the repo as package-canonical with retained compatibility paths. The convergence path is still in progress, but the canonical side is no longer ambiguous.

---

## Summary Matrix

| ID | Gap | Current Code Reality | Risk | Recommendation | Priority |
|----|-----|----------------------|------|----------------|----------|
| G1 | Hybrid architecture is not fully deleted | Root `src/` and `packages/*` both compile, but `packages/*` is now canonical | Contributors can still patch the wrong layer | Keep package-first ownership explicit and continue converting root to compatibility wrappers | P0 |
| G2 | CLI surface still has bridge behavior | Package CLI is public-canonical, while root/legacy command paths still exist under the hood | Command behavior can diverge if bridges are not kept thin | Keep one package CLI vocabulary and label/delete root compatibility surfaces over time | P0 |
| G3 | Server/runtime surface retains legacy files | Root server bootstrap forwards to package server, but old root server implementation files remain | Route fixes can accidentally land in a non-canonical server | Keep package server canonical and mark or remove legacy root server implementation paths | P0 |
| G4 | Runtime behavior diverges by entrypoint | Root `invoke` uses `AgentForgeSession`; package `autonomous:cycle` uses `CycleRunner`; root and package servers route users differently | The same user intent can produce different behavior depending on entrypoint | Route all runtime entrypoints through a single orchestration boundary | P0 |
| G5 | Version/docs drift can regress | Version metadata and top-level docs are currently aligned to `10.5.0` package-canonical behavior | Future releases can reintroduce drift without a release discipline | Keep version/docs tied to package metadata and command help | P1 |
| G6 | Package autonomous launcher is architected but still partially stubbed | `packages/cli/src/commands/autonomous.ts` wires `CycleRunner`, but proposal/scoring adapters are still stubbed | The canonical new runtime is not fully end-to-end without more signal wiring | Finish real adapter wiring and remove smoke-test scaffolding | P1 |
| G7 | Dashboard operator contract is moving to async runs | Package dashboard is canonical and `/runner` must support `202 Accepted` plus SSE chunks | Operators can lose output or completion state if the UI assumes a synchronous POST | Keep runner/live tests focused on async run start, chunk replay, metadata, reconnect, and clear/copy behavior | P1 |
| G8 | Compatibility policy is implicit, not explicit | Root and packages both remain active with no documented deprecation boundary | Future changes can silently reintroduce overlap | Define compatibility windows and deprecation rules for root entrypoints | P1 |

---

## Detailed Gaps

### G1. Hybrid Architecture Is Still the Default

**Current code reality**

- Root source still builds from `src/**/*` via [tsconfig.json](../../../tsconfig.json).
- Workspace packages are also first-class build targets via `tsconfig.json` references and the root `pnpm-workspace.yaml`.
- The root repo still ships root-level start and build scripts, while package-level build/start flows also exist in `package.json`.

**Why this matters**

The repo is not in a clean migration state. It is a hybrid system that will keep generating accidental complexity until one side is declared canonical and the other side is downgraded to compatibility or removal.

**Recommendation**

Pick a canonical runtime stack for v3.1 and document it in one place. The likely outcome is:

- `packages/*` becomes the canonical product runtime and server stack
- root `src/` becomes compatibility, migration, and thin wrapper code only

If the team prefers the root stack to remain canonical, the same rule still applies in reverse. The critical point is to stop treating both as equal source-of-truth surfaces.

**Risk**

High. This is the root cause of most other drift in the repo.

**Priority**

`P0`

**Ownership suggestion**

Platform/runtime lead plus one maintainer from the root CLI/server code path and one maintainer from the package runtime code path.

---

### G2. CLI Surfaces Are Duplicated

**Current code reality**

- Root CLI is defined in [src/cli/index.ts](../../../src/cli/index.ts) and exposes forge/genesis/rebuild/reforge/invoke/delegate/cost-report/sessions.
- Package CLI is defined in [packages/cli/src/bin.ts](../../../packages/cli/src/bin.ts) and exposes init/start/migrate/info/autonomous:cycle/workspaces.
- The command sets do not line up, and the versioning language differs between them.

**Why this matters**

Users should not have to infer which CLI is authoritative. Duplicate command surfaces create support burden, confusion in docs, and inconsistent automation behavior.

**Recommendation**

Create one public CLI surface and one internal compatibility layer.

- If `packages/cli` is the canonical user entrypoint, route legacy root commands into it or mark them as deprecated shims.
- If the root CLI remains canonical for now, make the package CLI an implementation detail and align its commands behind the same public naming scheme.

Do not keep two unrelated command vocabularies indefinitely.

**Risk**

High. CLI confusion is a user-facing product problem, not just a code organization problem.

**Priority**

`P0`

**Ownership suggestion**

CLI owner plus docs/release owner. This needs an owner who can enforce command naming and deprecation notices.

---

### G3. Server Surfaces Retain Legacy Files

**Current code reality**

- Root server compatibility bootstrap is in [src/server/main.ts](../../../src/server/main.ts) and forwards through [src/server/index.ts](../../../src/server/index.ts) to `@agentforge/server`.
- Legacy root server implementation files such as [src/server/server.ts](../../../src/server/server.ts) still exist and remain part of the build graph.
- Package server bootstrap is in [packages/server/src/main.ts](../../../packages/server/src/main.ts) and [packages/server/src/server.ts](../../../packages/server/src/server.ts).
- The package server is canonical for health, cycles, search, runs, org graph, teams, memory, reviews, autonomy, and workspace behavior.
- The package server startup now prints the root package version, currently `10.5.0`.

**Why this matters**

Legacy server implementation files can still attract accidental fixes. That drift becomes expensive if dashboards or automation depend on a root file that is no longer the canonical launch path.

**Recommendation**

Keep the package server canonical and make root server code visibly compatibility-only.

The simplest convergence move is:

- package server remains canonical for operator/runtime flows
- root server remains a thin bootstrap wrapper or legacy compatibility path

Do not add new `/api/v5/*` runtime behavior to root server files.

**Risk**

High. This is the main source of endpoint duplication and version skew.

**Priority**

`P0`

**Ownership suggestion**

Server/platform owner plus dashboard owner. The server decision has to be made together with the UI path.

---

### G4. Runtime Behavior Diverges By Entry Point

**Current code reality**

- Root `invoke` uses `AgentForgeSession` in [src/cli/commands/invoke.ts](../../../src/cli/commands/invoke.ts) and is centered on session logging and cost tracking.
- Package autonomous execution uses `CycleRunner` in [packages/core/src/autonomous/cycle-runner.ts](../../../packages/core/src/autonomous/cycle-runner.ts).
- Package server’s `/api/v5/cycles` route in [packages/server/src/routes/v5/cycles.ts](../../../packages/server/src/routes/v5/cycles.ts) is already the operational launcher for the autonomous cycle.
- Root `invoke --loop` still returns a placeholder notice instead of entering the bounded control loop.

**Why this matters**

The repo has more than one runtime story:

- interactive agent invocation
- session-driven task execution
- autonomous cycle execution
- server-triggered cycle execution

If these are meant to be related, they need a common orchestration boundary and a common artifact model. If they are not related, the docs need to say so explicitly.

**Recommendation**

Define one authoritative runtime boundary and route all product entrypoints through it:

- agent invocation
- autonomous cycle launch
- server-triggered cycle launch
- dashboard-triggered actions

The runtime boundary should own session tracking, cost accounting, approvals, and artifact writes.

**Risk**

High. This is where users feel the split in behavior.

**Priority**

`P0`

**Ownership suggestion**

Runtime/orchestration owner with support from the package core team and the root session/orchestrator maintainer.

---

### G5. Version and Documentation Drift Can Regress

**Current code reality**

- Root package version is `10.5.0` in [package.json](../../../package.json).
- Package manifests checked for [packages/cli/package.json](../../../packages/cli/package.json), [packages/core/package.json](../../../packages/core/package.json), [packages/server/package.json](../../../packages/server/package.json), and [packages/dashboard/package.json](../../../packages/dashboard/package.json) report `10.5.0`.
- The root plugin export in [src/index.ts](../../../src/index.ts) reads package metadata instead of reporting a stale hardcoded version.
- [README.md](../../../README.md) documents the package-canonical CLI and dashboard runner SSE contract.
- [CHANGELOG.md](../../../CHANGELOG.md) includes the `10.5.0` convergence line and current Unreleased notes.

**Why this matters**

Version drift is not cosmetic when it regresses. It causes support confusion, release confusion, and false confidence in what is actually shipped. Docs should stay tied to executable command help, package metadata, and API contracts.

**Recommendation**

Keep one source of truth for versions and release claims.

- root and package versioning should be explicitly related, not independently implied
- README claims should be generated from actual command help or release metadata
- changelog entries should be updated alongside the release line that users actually see

**Risk**

Medium-high. It is not a runtime crash risk, but it damages trust and slows contributor onboarding.

**Priority**

`P0`

**Ownership suggestion**

Release manager or docs owner with a hard rule that release metadata cannot drift from the executable command surface.

---

### G6. Package Autonomous Launcher Still Needs Real Signal Wiring

**Current code reality**

- `packages/cli/src/commands/autonomous.ts` wires `CycleRunner`, but proposal and scoring adapters still return empty or placeholder values.
- That means the package runtime has a valid execution shell, but the input signal quality is still incomplete.

**Why this matters**

The package runtime is the canonical future path, so its stubs are more important than they would be in a throwaway branch. If the launcher stays hollow, the new canonical path will appear real but fail on real project signal inputs.

**Recommendation**

Finish the adapter wiring so the cycle runner consumes real backlog, scoring, and workspace data. Remove or narrow the smoke-test placeholders once the live path is in place.

**Risk**

Medium. The control flow exists, but it still needs real data to be product-ready.

**Priority**

`P1`

**Ownership suggestion**

Package core team plus package CLI maintainer.

---

### G7. Dashboard Path Should Be Canonicalized

**Current code reality**

- Root server still serves a legacy dashboard path from the root tree.
- Package server and package dashboard are the current operational surface around cycles, approvals, and live execution.

**Why this matters**

When the UI path is unclear, operator trust drops. The same is true for docs that point to one dashboard while the runtime data is being written for another.

**Recommendation**

Make the package dashboard the canonical operator UI and make the root dashboard path explicitly legacy.

**Risk**

Medium. This is mostly about operator confusion, but it compounds with server drift.

**Priority**

`P1`

**Ownership suggestion**

Dashboard owner together with the server owner.

---

### G8. Compatibility Policy Is Not Written Down

**Current code reality**

- Both runtime stacks remain active.
- There is no explicit deprecation boundary in the code surface that tells contributors when to add a feature to root vs package code.

**Why this matters**

Without a compatibility policy, every new feature becomes a judgment call. That keeps the hybrid architecture alive longer than necessary.

**Recommendation**

Write a short compatibility policy that answers:

- what is canonical
- what is legacy
- how long legacy paths remain supported
- where shims belong
- when to delete duplicate code

**Risk**

Medium. The issue is organizational, but it directly affects code health.

**Priority**

`P1`

**Ownership suggestion**

Tech lead or platform owner. This is a policy decision, not just an implementation task.

---

## Sequencing For v3.1

1. Decide the canonical runtime stack first. Do not start by polishing both branches.
2. Collapse the public CLI vocabulary next. If the user-facing command surface is split, everything downstream stays split.
3. Canonicalize the server path after that. The UI and automation entrypoints should point to one runtime model.
4. Update docs and versions only after the canonical surfaces are chosen. Otherwise the docs will just encode ambiguity faster.
5. Finish the remaining package autonomous wiring once the interface boundaries are stable.

If the team wants the shortest path with the least churn, the practical convergence move is:

- keep `packages/*` as the canonical runtime/server/dashboard stack
- turn root `src/` into compatibility and migration layers
- gradually reduce root command and server ownership until the package stack is the only public surface

That is not the only possible answer, but it is the lowest-friction answer given the current code shape.

---

## Ownership Suggestions

- `Runtime/platform owner`: canonical runtime decision, orchestration boundary, compatibility policy
- `CLI owner`: command surface consolidation, deprecation shims, help text parity
- `Server owner`: one API surface, route migration, dashboard alignment
- `Package core owner`: autonomous cycle runner, adapter wiring, session/cost persistence
- `Docs/release owner`: README, changelog, version sync, command truthfulness
- `QA owner`: E2E coverage for CLI parity, server parity, and canonical startup flows

The team should assign one person to own the split boundary itself. If nobody owns the boundary, the repo will keep growing in two directions.
