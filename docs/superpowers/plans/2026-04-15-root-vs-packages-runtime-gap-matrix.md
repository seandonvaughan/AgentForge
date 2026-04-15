# AgentForge Root-vs-Packages Runtime Gap Matrix

**Prepared:** April 15, 2026  
**Audience:** AgentForge development team  
**Purpose:** Document the current split between the legacy root `src/` runtime and the newer `packages/*` runtime stack, then map the convergence work needed for v3.1 and beyond.

## Executive Summary

AgentForge is no longer a single-tree CLI project. It is now a hybrid monorepo with two active runtime surfaces:

- the root `src/` tree, which still owns the legacy CLI, root Fastify server, and session-based runtime path
- the `packages/*` workspace stack, which owns the modular CLI, core autonomous cycle engine, package server, and dashboard

The important takeaway is not that one side is "right" and the other side is "wrong". The repo is operating as a split system. That split is visible in entrypoints, version numbers, command names, API prefixes, docs, and runtime behavior.

The current risk is architectural drift:

- users see overlapping commands and servers that do similar work
- contributors have to reason about two parallel mental models
- docs and version metadata are behind the real product state
- runtime behavior diverges depending on whether a user enters through root CLI, package CLI, root server, or package server

v3.1 should not add another layer on top of this split. It should reduce it. The highest-value work is to pick canonical surfaces, turn the non-canonical ones into thin compatibility layers, and make docs/version metadata match the shipped runtime.

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

- Root release line is `10.5.0` in [package.json](../../../package.json), while workspace packages still declare `6.0.0` in [packages/core/package.json](../../../packages/core/package.json) and [packages/server/package.json](../../../packages/server/package.json).
- The root plugin export in [src/index.ts](../../../src/index.ts) still reports version `0.1.0`, adding a third active version line on top of the root package and workspace package manifests.
- The root build graph still compiles `src/**/*` as the primary root source tree, while also referencing workspace packages in [tsconfig.json](../../../tsconfig.json).
- Root CLI commands are registered in [src/cli/index.ts](../../../src/cli/index.ts) and include `forge`, `genesis`, `rebuild`, `reforge`, `invoke`, `delegate`, `cost-report`, `activate`, `deactivate`, and `sessions`.
- Package CLI entrypoints are registered in [packages/cli/src/bin.ts](../../../packages/cli/src/bin.ts) and expose a different surface: `init`, `start`, `migrate`, `info`, `autonomous:cycle`, and workspace commands.
- Root server bootstrap lives in [src/server/main.ts](../../../src/server/main.ts) and reports `AgentForge v6.2`, while package server bootstrap lives in [packages/server/src/main.ts](../../../packages/server/src/main.ts) and reports `AgentForge v6.0`.
- Root server API assembly is in [src/server/server.ts](../../../src/server/server.ts), with `/api/v1/*` style routes and a local dashboard path.
- Package server API assembly is in [packages/server/src/server.ts](../../../packages/server/src/server.ts), with `/api/v5/*`, `/api/v6/*`, WebSocket bridges, workspace routing, cycles, search, execution, and plugin routes.
- The autonomous cycle is currently led from the package stack: [packages/server/src/routes/v5/cycles.ts](../../../packages/server/src/routes/v5/cycles.ts) spawns `packages/cli/dist/bin.js autonomous:cycle`, and [packages/core/src/autonomous/cycle-runner.ts](../../../packages/core/src/autonomous/cycle-runner.ts) owns the cycle engine.
- Root `invoke` now uses `AgentForgeSession` in [src/cli/commands/invoke.ts](../../../src/cli/commands/invoke.ts), but `--loop` still prints a placeholder message instead of entering a control loop.
- Root `genesis` is more complete than before, but it still sits inside the legacy root CLI surface in [src/cli/commands/genesis.ts](../../../src/cli/commands/genesis.ts).
- The docs trail the code. [README.md](../../../README.md) still claims `invoke --loop` is available and uses release-era language that does not match the current package split, while [CHANGELOG.md](../../../CHANGELOG.md) still tops out at `6.7.0`.

This is enough evidence to treat the repo as split-brain today, with a convergence path still in progress.

---

## Summary Matrix

| ID | Gap | Current Code Reality | Risk | Recommendation | Priority |
|----|-----|----------------------|------|----------------|----------|
| G1 | Hybrid architecture is not yet converged | Root `src/` and `packages/*` both compile, both boot runtimes, and both own live product paths | Contributors will keep building against two different mental models | Declare one canonical runtime stack and convert the other into compatibility wrappers | P0 |
| G2 | CLI surface is duplicated | Root CLI and package CLI expose different commands and different product stories | Command discovery, docs, and automation drift from each other | Collapse to one user-facing CLI surface, or namespace the second surface explicitly | P0 |
| G3 | Server/runtime surface is duplicated | Root Fastify server and package Fastify server both expose overlapping API families | Route drift and duplicated bug-fixing effort | Choose one canonical server runtime and freeze the other as a thin adapter | P0 |
| G4 | Runtime behavior diverges by entrypoint | Root `invoke` uses `AgentForgeSession`; package `autonomous:cycle` uses `CycleRunner`; root and package servers route users differently | The same user intent can produce different behavior depending on entrypoint | Route all runtime entrypoints through a single orchestration boundary | P0 |
| G5 | Version and docs are out of sync | Root is `10.5.0`, packages still say `6.0.0`, README and CHANGELOG lag the shipped behavior | Trust erosion for users and contributors | Make version/docs generated from a single source of truth | P0 |
| G6 | Package autonomous launcher is architected but still partially stubbed | `packages/cli/src/commands/autonomous.ts` wires `CycleRunner`, but proposal/scoring adapters are still stubbed | The canonical new runtime is not fully end-to-end without more signal wiring | Finish real adapter wiring and remove smoke-test scaffolding | P1 |
| G7 | Dashboard and operator surfaces reflect the split | Root server serves the legacy dashboard path; package dashboard is the canonical operational UI | Operators can land in different UI stacks with different expectations | Make the package dashboard the canonical UI and deprecate the root path with a migration notice | P1 |
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

### G3. Server Surfaces Are Duplicated

**Current code reality**

- Root server bootstrap is in [src/server/main.ts](../../../src/server/main.ts) and [src/server/server.ts](../../../src/server/server.ts).
- Package server bootstrap is in [packages/server/src/main.ts](../../../packages/server/src/main.ts) and [packages/server/src/server.ts](../../../packages/server/src/server.ts).
- The two server stacks expose overlapping domains: health, cycles, search, runs, org graph, teams, memory, reviews, autonomy, and workspace behavior.
- Root server is `v6.2` while package server is `v6.0`, which is a strong signal that the two are parallel tracks, not one runtime with a tidy boundary.

**Why this matters**

Two active servers almost always drift on route shape, auth behavior, startup assumptions, and artifact locations. That drift becomes expensive as soon as dashboards or automation depend on one path and then unexpectedly hit the other.

**Recommendation**

Choose one canonical API server and make the other side a compatibility layer or a migration bridge.

The simplest convergence move is:

- package server becomes canonical for operator/runtime flows
- root server becomes a thin bootstrap wrapper or legacy compatibility path

If that is not the intended direction, the reverse decision still needs to be explicit and documented.

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

### G5. Version and Documentation Drift Are Material

**Current code reality**

- Root package version is `10.5.0` in [package.json](../../../package.json).
- Package manifests still report `6.0.0` in [packages/core/package.json](../../../packages/core/package.json) and [packages/server/package.json](../../../packages/server/package.json).
- The root plugin export in [src/index.ts](../../../src/index.ts) still reports `0.1.0`.
- [README.md](../../../README.md) still advertises `invoke --loop` as shipped.
- [CHANGELOG.md](../../../CHANGELOG.md) still tops out at `6.7.0` and is no longer aligned with the repo tip.

**Why this matters**

Version drift is not cosmetic. It causes support confusion, release confusion, and false confidence in what is actually shipped. Docs drift makes the repo look more finished than it is.

**Recommendation**

Move to one source of truth for versions and release claims.

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
