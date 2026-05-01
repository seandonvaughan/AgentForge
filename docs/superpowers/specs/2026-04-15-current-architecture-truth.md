# Current Architecture Truth

**Prepared:** April 15, 2026  
**Last reviewed:** April 30, 2026  
**Audience:** AgentForge development team  
**Purpose:** Record the current code-grounded architecture after the latest pull so package-canonical work can target the repo as it exists now rather than older roadmap language.

This document was first grounded in the codebase as pulled on 2026-04-15 and was refreshed on 2026-04-30 for the `10.5.0` package-canonical convergence state.

## Executive Summary

AgentForge is currently a package-canonical monorepo with a retained root compatibility layer:

- The `packages/*` track is the canonical product stack: CLI, core runtime, package server, workspace/session persistence, and dashboard.
- The root `src/` track still exists for compatibility, plugin exports, and legacy/manual workflow bridging, but new operator/runtime work should land in `packages/*`.

The repo is not fully deleted back to one tree, but it is no longer accurate to describe root and packages as equally authoritative. The practical rule is package-first, root-as-compatibility.

The authoritative current runtime for autonomous and operator work is `packages/cli` + `packages/core` + `packages/server` + `packages/dashboard`. Team-building/manual commands that still need legacy behavior are bridged through package team services rather than treated as a second product center.

## Repository Snapshot

- Root package version: `10.5.0` in [package.json](C:/Users/SeanVaughan/Projects/AgentForge/package.json)
- Workspace layout: `packages/*` and `plugins/*` in [pnpm-workspace.yaml](C:/Users/SeanVaughan/Projects/AgentForge/pnpm-workspace.yaml)
- Root TypeScript build still compiles `src/**/*` and references workspace packages from [tsconfig.json](C:/Users/SeanVaughan/Projects/AgentForge/tsconfig.json)
- Workspace packages currently present:
  - `shared`
  - `db`
  - `core`
  - `cli`
  - `server`
  - `dashboard`
  - `embeddings`
  - `executor`
  - `plugins-sdk`
- Root CLI commands still exist in [src/cli/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/index.ts)
- Workspace CLI commands still exist in [packages/cli/src/bin.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/cli/src/bin.ts)
- Root server still exists in [src/server/main.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/main.ts) and [src/server/server.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/server.ts)
- Workspace server still exists in [packages/server/src/main.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/server/src/main.ts) and [packages/server/src/server.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/server/src/server.ts)
- Root plugin export still exists in [src/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/index.ts), but now reads the root package version instead of a stale hardcoded value

## Architecture Layers

### 1. Root CLI Layer

The root CLI is still a real user-facing surface. It registers `forge`, `genesis`, `rebuild`, `reforge`, `team`, `status`, `invoke`, `delegate`, `cost-report`, `activate`, `deactivate`, and `sessions` in [src/cli/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/index.ts).

The key behaviors today are:

- `genesis` performs discovery, optional interview, team proposal, and approval gating in [src/cli/commands/genesis.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/commands/genesis.ts)
- `invoke` creates an `AgentForgeSession` and routes a single agent task through `OrchestratorV3` in [src/cli/commands/invoke.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/commands/invoke.ts)
- `invoke --loop` is still a placeholder notice, not a shipped control loop

### 2. Root Runtime / Server Layer

The root server bootstrap remains present for compatibility, but it now forwards to the package-canonical server. [src/server/main.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/main.ts) calls [src/server/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/index.ts), which warns that the root bootstrap is deprecated and launches `@agentforge/server`.

Legacy root server implementation files still exist, but they should not be the target for new dashboard/runtime API work. New server behavior should land under [packages/server](C:/Users/SeanVaughan/Projects/AgentForge/packages/server).

Important compatibility details:

- `AGENTFORGE_DB` is treated as a legacy root-server setting.
- The package server uses `DATA_DIR` and defaults to `.agentforge/v5`.
- The dashboard expects the package server on port `4750` and Vite on port `4751` during development.

### 3. Workspace CLI Layer

The package CLI in [packages/cli/src/bin.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/cli/src/bin.ts) is a separate, real command surface with `init`, `start`, `migrate`, `info`, `autonomous:cycle`, and workspace commands.

This is the current entrypoint for the autonomous cycle launcher, not the root CLI.

Important current caveat: [packages/cli/src/commands/autonomous.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/cli/src/commands/autonomous.ts) wires the live `CycleRunner`, but its proposal and scoring adapters still carry smoke-test scaffolding. The cycle engine is real; some upstream signal inputs are still transitional.

### 4. Workspace Core Layer

`packages/core` is the center of the autonomous engine. The main loop starts at [packages/core/src/autonomous/cycle-runner.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/core/src/autonomous/cycle-runner.ts), advances through [packages/core/src/autonomous/phase-scheduler.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/core/src/autonomous/phase-scheduler.ts), and does real work in [packages/core/src/autonomous/phase-handlers/execute-phase.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/core/src/autonomous/phase-handlers/execute-phase.ts).

The cycle engine is filesystem-first and event-driven. It produces concrete artifacts for approval, sprint generation, phase execution, tests, git, and PR review.

### 5. Workspace Server Layer

`packages/server` is the operational API for the autonomous system. It exposes cycle, session, approval, run, and workspace routes and is what the dashboard expects to talk to.

The cycle route in [packages/server/src/routes/v5/cycles.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/server/src/routes/v5/cycles.ts) is the main orchestrator-facing surface:

- It creates or resolves cycle directories
- It spawns `packages/cli/dist/bin.js autonomous:cycle`
- It binds the subprocess to a preallocated cycle id
- It exposes cycle artifacts back over HTTP

The run route in [packages/server/src/routes/v5/run.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/server/src/routes/v5/run.ts) is the operator-facing agent invocation API. Dashboard clients should use the default async `202 Accepted` start shape and keep compatibility support for `?wait=true` synchronous `200` completion responses. In both modes, live output is keyed by `sessionId` over `/api/v5/stream`.

### 6. Workspace Dashboard Layer

`packages/dashboard` is the operator UI. It reads the cycle API, streams SSE updates, and renders cycle state, approvals, sessions, and live progress.

The dashboard home page in [packages/dashboard/src/routes/+page.svelte](C:/Users/SeanVaughan/Projects/AgentForge/packages/dashboard/src/routes/+page.svelte) is the operational command center. Cycle detail pages in [packages/dashboard/src/routes/cycles/[id]/+page.svelte](C:/Users/SeanVaughan/Projects/AgentForge/packages/dashboard/src/routes/cycles/[id]/+page.svelte) poll live sprint and agent state and subscribe to SSE.

Runner-specific operator behavior:

- [packages/dashboard/src/routes/runner/+page.svelte](C:/Users/SeanVaughan/Projects/AgentForge/packages/dashboard/src/routes/runner/+page.svelte) opens `/api/v5/stream` before `POST /api/v5/run` so chunks emitted before the HTTP response are buffered and replayed after the session id is known.
- `agent_activity` events append `data.content` or `data.chunk`.
- `workflow_event` events complete or fail the visible run via `data.status`.
- The runner displays resolved provider/runtime metadata, first-token latency, copy/clear controls, and stream reconnect warnings.
- [packages/dashboard/src/routes/live/+page.svelte](C:/Users/SeanVaughan/Projects/AgentForge/packages/dashboard/src/routes/live/+page.svelte) remains the raw activity feed and warns operators while SSE reconnects.

## Authoritative Entrypoints

- Root CLI: [src/cli/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/index.ts)
- Root server bootstrap: [src/server/main.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/main.ts)
- Root server assembly: [src/server/server.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/server.ts)
- Workspace CLI bootstrap: [packages/cli/src/bin.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/cli/src/bin.ts)
- Workspace autonomous command: [packages/cli/src/commands/autonomous.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/cli/src/commands/autonomous.ts)
- Workspace server bootstrap: [packages/server/src/main.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/server/src/main.ts)
- Workspace server assembly: [packages/server/src/server.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/server/src/server.ts)
- Autonomous engine runner: [packages/core/src/autonomous/cycle-runner.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/core/src/autonomous/cycle-runner.ts)

## How Root `src/` and `packages/*` Coexist

The repo is in a package-canonical coexistence state, not a fully deleted legacy-root state.

`src/` still matters because it powers:

- compatibility exports and root launch shims
- legacy/manual workflow code that package team services still bridge through where migration is not finished

`packages/*` matters because it powers:

- the canonical CLI
- the autonomous cycle launcher
- the workspace server and dashboard
- the modular `@agentforge/*` libraries

The root `tsconfig.json` still includes `src/**/*` and also references the workspace packages, so both layers remain part of the build graph. That is a compatibility/build reality, not a reason to add new runtime behavior to root by default.

Versioning is now materially less drifted than it was on 2026-04-15:

- root release line: `10.5.0`
- workspace package manifests checked for `@agentforge/cli`, `@agentforge/core`, `@agentforge/server`, and `@agentforge/dashboard`: `10.5.0`
- root plugin export reads the root package version
- package server startup prints the root package version

Remaining overlap is now mostly about compatibility policy and deletion sequencing rather than visible version skew.

## Current Command Surfaces

### Root CLI

Implemented commands in [src/cli/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/index.ts):

- `forge`
- `genesis`
- `rebuild`
- `reforge`
- `team`
- `status`
- `invoke`
- `delegate`
- `cost-report`
- `activate`
- `deactivate`
- `sessions`

Important current details:

- `genesis` now does real discovery, interview collection, team display, and approval gating
- `invoke` uses `AgentForgeSession`
- `invoke --loop` is still a placeholder and should not be described as shipped control-loop functionality

### Workspace CLI

Implemented commands in [packages/cli/src/bin.ts](C:/Users/SeanVaughan/Projects/AgentForge/packages/cli/src/bin.ts):

- `init`
- `start`
- `migrate`
- `info`
- `autonomous:cycle`
- workspace commands

`autonomous:cycle` is the command that launches the current autonomous loop engine.

## Runtime / Data Flow

### Manual Task Flow

1. User runs `invoke` from the root CLI.
2. The command loads `.agentforge/team.yaml` and the matching agent YAML from `.agentforge/agents/`.
3. `AgentForgeSession` is created from [src/orchestrator/session.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/orchestrator/session.ts).
4. `OrchestratorV3` runs the agent task.
5. Decision logs, knowledge store updates, and cost artifacts are written under `.agentforge/sessions/`.

### Genesis Flow

1. User runs `genesis`.
2. Discovery runs first.
3. Interview runs when the project is empty or when `--interview` is forced.
4. The proposed team is printed.
5. Approval is requested unless `--yes` is supplied.
6. The team is written to `.agentforge/team.yaml`.

### Autonomous Cycle Flow

1. The dashboard or API posts to `/api/v5/cycles`.
2. The server pre-creates a cycle directory under `.agentforge/cycles/<cycleId>/`.
3. The server spawns `packages/cli/dist/bin.js autonomous:cycle` with the cycle id in the environment.
4. `CycleRunner` performs plan, stage, run, verify, commit, and review work.
5. The phase scheduler advances `audit -> plan -> assign -> execute -> test -> review -> gate -> release -> learn`.
6. The dashboard polls and streams the resulting state.

## Persistence / Artifacts

The repo is heavily filesystem-backed. The main persistence roots are:

- `.agentforge/team.yaml`
- `.agentforge/agents/*.yaml`
- `.agentforge/sessions/`
- `.agentforge/cycles/<cycleId>/`
- `.agentforge/sprints/`
- `.agentforge/memory/`
- `.agentforge/v5/`
- `audit.db`

Cycle artifacts currently include:

- `cycle.json`
- `events.jsonl`
- `scoring.json`
- `phases/*.json`
- `tests.json`
- `git.json`
- `pr.json`
- `approval-pending.json`
- `approval-decision.json`

Session/cost artifacts currently include:

- `cost-entry-*.json`
- session summaries under `.agentforge/sessions/`
- decision logs and knowledge entries from `AgentForgeSession`

## Testing / CI Snapshot

The repository still has a conventional CI gate in [/.github/workflows/ci.yml](C:/Users/SeanVaughan/Projects/AgentForge/.github/workflows/ci.yml):

- lint on Node 18 and 20
- test on Node 18 and 20
- build on Node 18 and 20
- type-check on Node 18 and 20
- `pnpm install --frozen-lockfile`
- Vitest output captured in JUnit format

The repo also has Playwright support from root scripts, but the authoritative automated gate today is still CI, not a single local command.

## Current Source-of-Truth Conclusions

- `packages/core` is the source of truth for the autonomous cycle engine.
- `packages/server` is the source of truth for package HTTP, run, cycle, workspace, and SSE orchestration.
- `packages/dashboard` is the source of truth for operator-facing cycle inspection, run output, and live activity.
- `packages/cli` is the source of truth for the public package-canonical CLI surface.
- Root `src/` is compatibility and bridging code unless a task explicitly targets legacy behavior.
- The repo should be treated as package-canonical with retained compatibility layers until the overlap is explicitly removed.

## Transitional Overlap Notes

- Do not add new runtime/server behavior to root `src/` unless the task is explicitly compatibility-scoped.
- Do not treat root launch shims as proof that the root server is canonical; they now forward to the package server.
- Do keep dashboard/API work aligned to `/api/v5/*` package routes and `/api/v5/stream`.
- Do keep README/changelog language aligned with package help text and package manifests.
- Do preserve root compatibility behavior until a deletion or deprecation task explicitly removes it.

The practical operating rule is simple: use the package-based stack as canonical, and use root code only for compatibility/bridge behavior until the overlap is resolved.
