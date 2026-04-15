# Current Architecture Truth

**Prepared:** April 15, 2026  
**Audience:** AgentForge development team  
**Purpose:** Record the current code-grounded architecture after the latest pull so v3.1 work can target the repo as it exists now rather than older roadmap language.

This document reflects the codebase as pulled on 2026-04-15. It is intentionally grounded in the repo as it exists now, not in prior roadmap language or README claims.

## Executive Summary

AgentForge is currently a hybrid monorepo with two live runtime tracks:

- A root `src/` track that still powers the legacy CLI, root server, and session-based manual invocation flow.
- A `packages/*` track that now holds the strongest product surface: autonomous cycles, workspace-aware server APIs, and the dashboard.

The repo is not in a clean “old app replaced by new app” state. Both stacks are active, both compile, and both expose overlapping concepts. The current development reality is split-brain, not single-source.

The most authoritative current runtime for autonomous development is `packages/core` + `packages/server` + `packages/dashboard`. The root `src/` tree is still authoritative for `genesis`, `forge`, and `invoke` in the legacy/manual workflow, but it is no longer the only or primary product center.

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
- Root plugin export still exists in [src/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/index.ts) and still reports version `0.1.0`, which is another sign of version drift across active surfaces

## Architecture Layers

### 1. Root CLI Layer

The root CLI is still a real user-facing surface. It registers `forge`, `genesis`, `rebuild`, `reforge`, `team`, `status`, `invoke`, `delegate`, `cost-report`, `activate`, `deactivate`, and `sessions` in [src/cli/index.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/index.ts).

The key behaviors today are:

- `genesis` performs discovery, optional interview, team proposal, and approval gating in [src/cli/commands/genesis.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/commands/genesis.ts)
- `invoke` creates an `AgentForgeSession` and routes a single agent task through `OrchestratorV3` in [src/cli/commands/invoke.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/cli/commands/invoke.ts)
- `invoke --loop` is still a placeholder notice, not a shipped control loop

### 2. Root Runtime / Server Layer

The root server stack is still live and not deprecated. It starts from [src/server/main.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/main.ts) and wires routes in [src/server/server.ts](C:/Users/SeanVaughan/Projects/AgentForge/src/server/server.ts).

This stack uses:

- Fastify + CORS + static dashboard hosting
- SQLite-backed data access via the root DB layer
- `/api/v1/*` health and API conventions
- filesystem-backed routes for sessions, agents, sprints, cycles, org graph, memory, reforge, and run operations

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

### 6. Workspace Dashboard Layer

`packages/dashboard` is the operator UI. It reads the cycle API, streams SSE updates, and renders cycle state, approvals, sessions, and live progress.

The dashboard home page in [packages/dashboard/src/routes/+page.svelte](C:/Users/SeanVaughan/Projects/AgentForge/packages/dashboard/src/routes/+page.svelte) is the operational command center. Cycle detail pages in [packages/dashboard/src/routes/cycles/[id]/+page.svelte](C:/Users/SeanVaughan/Projects/AgentForge/packages/dashboard/src/routes/cycles/[id]/+page.svelte) poll live sprint and agent state and subscribe to SSE.

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

The repo is in a transitional coexistence state, not a clean migration.

`src/` still matters because it powers:

- the root CLI
- the root server
- `genesis`, `forge`, `invoke`, and the session wrapper path

`packages/*` matters because it powers:

- the autonomous cycle launcher
- the workspace server and dashboard
- the modular `@agentforge/*` libraries

The root `tsconfig.json` still includes `src/**/*` and also references the workspace packages, which means both layers are part of the build graph rather than one being fully superseded.

Versioning also shows the overlap clearly:

- root release line: `10.5.0`
- workspace package manifests: still `6.0.0`
- root server identifies as `v6.2`
- workspace server identifies as `v6.0`

That is a strong signal that the repo still contains parallel tracks, not a single canonical runtime.

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
- `packages/server` is the source of truth for cycle HTTP and SSE orchestration.
- `packages/dashboard` is the source of truth for operator-facing cycle inspection.
- Root `src/` is still the source of truth for the legacy/manual CLI flow and the root server stack.
- `genesis` and `invoke` are real, but they live in the root CLI track, not the workspace cycle engine.
- The repo should be treated as a hybrid monorepo until the overlap is explicitly removed.

## Transitional Overlap Notes

- Do not assume a single canonical server. Both root and workspace servers are live.
- Do not assume a single canonical CLI. Both root and workspace CLIs are live.
- Do not assume versions are aligned across packages. They are not.
- Do not treat README language as authoritative where it conflicts with code. `invoke --loop` is the clearest example.
- Do not collapse the two runtime tracks into one mental model when debugging. The root session-based runtime and the workspace autonomous cycle runtime solve different problems.

The practical operating rule for v3.1 work is simple: use the package-based stack as the canonical autonomous-cycle path, and use the root stack as the canonical manual/team-building path until the overlap is resolved.
