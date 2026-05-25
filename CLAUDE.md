# AgentForge — CLAUDE.md

**Audience:** An AI agent (or human developer) opening this repository for the first time.

AgentForge is a TypeScript monorepo with Codex and Claude Code host surfaces. It scans a software project and forges an optimized AI agent team to develop it autonomously. It runs unattended development cycles under hard budget caps and gate verdicts, accumulating learnings each cycle so the forged agents become more specialized over time.

---

## Repository layout

```
packages/
  cli/          — canonical CLI surface (`agentforge` binary)
  core/         — forge pipeline, cycle orchestration, runtime services
  server/       — Fastify v5 REST + SSE API server
  dashboard/    — SvelteKit operator UI (http://localhost:4751)
  db/           — WorkspaceAdapter + SQLite schema helpers
  shared/       — shared types and utilities
  embeddings/   — vector embeddings subsystem
  executor/     — autonomous cycle executor
  mcp-server/   — stdio MCP server used by Codex and other MCP hosts
  plugins-sdk/  — plugin authoring helpers
  skills-catalog/ — skill catalog and governance helpers

src/            — legacy compatibility shims (forward to packages/)
plugins/agentforge-codex/ — Codex host plugin wrapper
tests/          — vitest test suites (mirrors packages/ structure)
.agentforge/    — workspace data: agents/, team.yaml, memory/, cycles/
```

---

## What AgentForge is

AgentForge scans a software project's source tree, dependency graph, git history, and engineering conventions and forges an optimized AI agent team specialized to develop that project autonomously through the configured runtime host. The forged agents each own a well-scoped subsystem, with capability tiers that route strategic work to `opus`, implementation work to `sonnet`, and utility work to `haiku` provider profiles.

---

## Current team composition

The v22.1 team lives in `.agentforge/agents/` and `.agentforge/team.yaml`. It contains **24 specialist agents** organized in four buckets:

### Strategic (Opus)

| Agent | Domain |
|---|---|
| `chief-architect` | Monorepo topology, cross-package contracts, ADRs |
| `forge-engine-architect` | Forge pipeline design end-to-end |
| `autonomy-strategist` | Autonomous loop policy, budget gates, self-correction |

### Implementation (Sonnet)

| Agent | Domain |
|---|---|
| `fastify-v5-engineer` | All `/api/v5/*` Fastify routes, SSE bridge, DM/inbox/KB routes |
| `fastify-v6-shim-engineer` | v6 path-rewriting shim, namespace compatibility |
| `db-workspace-engineer` | WorkspaceAdapter, SQLite schema, migrations |
| `embeddings-engineer` | Vector embeddings subsystem |
| `plugin-sdk-engineer` | Plugin authoring SDK, Claude Code plugin integration |
| `executor-runtime-engineer` | Cycle executor, Planner/Executor step shapes |
| `cli-engineer` | CLI commands, Commander registration, `agentforge demo` |
| `scanner-engineer` | File scanner, language detection, CI provider detection |
| `reforge-genesis-engineer` | Reforge diff engine, genesis flow |
| `svelte-cycles-engineer` | `/cycles` and `/cycles/:id` dashboard pages |
| `svelte-agents-engineer` | `/agents` and `/agents/:id` dashboard pages |
| `svelte-runner-engineer` | `/runner`, `/live`, `/jobs`, `/workspaces` pages |
| `svelte-component-atoms-engineer` | Shared Svelte 5 component atoms |
| `shared-utils-engineer` | Cross-package utilities in `@agentforge/shared` |
| `pr-merge-manager` | PR lifecycle, GitHub API, merge queue |

### Quality (Sonnet)

| Agent | Domain |
|---|---|
| `auth-security-engineer` | Auth plugin, RBAC, security gate |
| `test-engineer` | Vitest suites, coverage, test strategy |
| `ci-build-engineer` | CI config, build pipeline, turbo tasks |

### Utility (Haiku)

| Agent | Domain |
|---|---|
| `yaml-doctor` | YAML serialization, agent manifest linting |
| `memory-curator` | JSONL memory files, flywheel curation |
| `file-reader` | File reading, context assembly |

---

## Forge pipeline

The v22+ agent-driven forge runs four phases:

```
Phase A — Recon        5 parallel recon agents emit structured JSON
Phase B — Synthesis    Opus reads all recon artifacts and writes every agent's system_prompt
Phase C — Validation   Deterministic fact-checker (no LLM) verifies agent file paths and prompt quality
Phase D — Routing      Capability-tag routing index built from the new agent set
```

**Phase A recon agents** (all run in parallel, each emits a typed JSON artifact):

| Agent | Artifact |
|---|---|
| `code-archaeologist` | Subsystem map (`SubsystemsReport`) |
| `dep-graph-analyst` | Dependency graph (`DependenciesReport`) |
| `convention-detective` | Engineering conventions (`ConventionsReport`) |
| `domain-mapper` | Domain classification (`DomainReport`) |
| `failure-historian` | Git failure history (`HistoryReport`) |

**Phase B synthesis** invokes Opus with the five recon artifacts plus a representative source corpus and produces a `TeamPlan` (Zod-validated JSON). Each agent entry carries `id`, `tier`, `category`, `owns_subsystems`, `capability_tags`, `system_prompt`, `auto_include_files`, and `learnings_seed`.

**Phase C validation** runs five deterministic checks: `auto_include_files` exist, `owns_subsystems` are non-empty, system prompt references real paths, no domain contradictions, no duplicate prompts. Produces `.agentforge/forge/validation-report.json`.

**Phase D routing** reads every agent YAML and emits `.agentforge/routing-index.json` mapping `capability_tags` and `owns_subsystems` to agent IDs for O(n) dispatch routing.

**Output files written by forge:**

```
.agentforge/agents/<id>.yaml          — AgentTemplate-compatible YAML per agent
.claude/agents/<id>.md                — Claude Code frontmatter + system_prompt
.agentforge/team.yaml                 — team manifest
.agentforge/forge/team-plan.json      — raw Opus synthesis output (audit trail)
.agentforge/forge/validation-report.json
.agentforge/routing-index.json
```

---

## Running a forge

### First-time users — smoke test against an external project

```bash
agentforge demo --project /path/to/your-project
```

This runs a full scan and deterministic forge against the target path without spending LLM budget. It prints the scan summary, agent count, and sample agent IDs. Use it to verify your installation before committing to a full agent-driven forge.

Use `--legacy` to force the deterministic (no-LLM) forge path even after the agent-driven pipeline is available:

```bash
agentforge demo --project /path/to/your-project --legacy
```

### In-project forge

```bash
cd /path/to/your-project
agentforge team forge
```

Or from anywhere:

```bash
agentforge team forge --project-root /path/to/your-project --verbose
```

### Agent-driven forge (v22+)

To use the Opus-driven synthesis pipeline, set `AGENTFORGE_FORGE_STRATEGY`:

```bash
export AGENTFORGE_FORGE_STRATEGY=agent-driven
agentforge team forge --project-root /path/to/your-project
```

Strategy resolution order (highest to lowest):

1. `opts.strategy` passed programmatically
2. Presence of a `runtime` in the call (implies `agent-driven`)
3. `AGENTFORGE_FORGE_STRATEGY` env var
4. Conservative default: `legacy`

The `legacy` path is deterministic (no LLM calls) and always available as a fallback. The `agent-driven` path requires a configured runtime.

### Slash command

```
/agentforge:forge
```

Runs `agentforge team forge` against the current working directory from inside a Claude Code session.

---

## Running a cycle

A cycle is the 9-phase autonomous development loop:

```
audit → plan → assign → execute → test → review → gate → release → learn
```

### Start a cycle

```bash
agentforge cycle run --project-root /path/to/your-project
```

Preview without executing:

```bash
agentforge cycle preview --project-root /path/to/your-project
```

### Runtime transport

The cycle execution transport is controlled by `AGENTFORGE_RUNTIME`:

| Value | Transport | Use case |
|---|---|---|
| `auto` | Provider resolver; Anthropic SDK, Claude Code compatibility, or Codex CLI when available | Default for local development |
| `sdk` | Anthropic SDK alias | AgentForge Cloud, CI |
| `cli` | Claude CLI alias | Local when you want to guarantee the Claude CLI path |
| `anthropic-sdk` | Anthropic SDK transport | Explicit SDK transport selection |
| `claude-cli` | Claude CLI compatibility transport | Explicit Claude CLI selection |
| `claude-code-compat` | Legacy Claude Code compatibility transport name | Existing configs and tests |
| `codex-cli` | Codex CLI transport | Codex plugin and Codex-local execution |
| `openai-sdk` | OpenAI SDK transport | OpenAI-compatible runtime execution |

```bash
export AGENTFORGE_RUNTIME=cli          # explicit CLI transport
export AGENTFORGE_RUNTIME=sdk          # requires ANTHROPIC_API_KEY
export AGENTFORGE_RUNTIME=codex-cli    # Codex CLI transport
export AGENTFORGE_RUNTIME=auto         # default
```

Precedence: `AGENTFORGE_RUNTIME` env var > `runtime:` in `.agentforge/autonomous.yaml` > hardcoded `auto`.

### Cycle configuration

`.agentforge/autonomous.yaml` controls all cycle parameters:

```yaml
runtime: auto     # transport: auto | sdk | cli | anthropic-sdk | claude-cli | claude-code-compat | codex-cli | openai-sdk

budget:
  perCycleUsd: 30
  allowOverageApproval: true

limits:
  maxItemsPerSprint: 5

quality:
  testPassRateFloor: 0.95

git:
  branchPrefix: autonomous/
  baseBranch: main

pr:
  draft: false
  assignReviewer: your-github-username
```

### Approve a waiting cycle

```bash
agentforge cycle approve <cycle-id> --all
```

### Dashboard

```bash
agentforge start --project-root /path/to/your-project
# Open http://localhost:4751
```

---

## Memory and learning loop

Every gate verdict and code review finding flows back into agent learnings automatically. Memory files accumulate in `.agentforge/memory/`:

```
.agentforge/memory/
  cycle-outcome.jsonl       # per-cycle result records
  gate-verdict.jsonl        # pass/fail with reasoning
  review-finding.jsonl      # per-agent review findings
```

Starting from the second forge (or after an explicit `agentforge team forge`), the synthesis agent reads these files and injects up to 8 lessons per agent into each agent's `system_prompt` via `learnings_seed`. This is the flywheel: cycles accumulate evidence, forge reads evidence, agents become more specialized.

The `memory-curator` agent is responsible for deduplicating and distilling raw findings. The 8-lesson cap per agent is a hard limit enforced in synthesis — do not bypass it.

---

## Concurrent agents

Agents within a cycle execute in isolated git worktrees to prevent branch collisions. Key parameters:

- **Default parallelism:** 8 concurrent agents (`MAX_PARALLEL_AGENTS` default)
- **Hard maximum:** 40 concurrent agents
- **Override:** `export MAX_PARALLEL_AGENTS=16`
- **Per-cycle cap:** `maxExecutePhaseParallelism` in `autonomous.yaml`

Each worktree is allocated as `agent-<agentId>-<sessionId>` and checked out on a branch like `autonomous/agent-coder-abc123`. The concurrency gate queues callers when saturated and force-releases stale slots after 30 minutes to prevent deadlock.

**CRITICAL for multi-agent work:** When running parallel agents in a Claude Code session, always commit and push in a single atomic bash call. Concurrent agents switch git branches between bash calls, and stash pollution leaks untracked files across branches.

---

## Lessons (7 cumulative from the 5-cycle arc)

These lessons are baked into every agent's `learnings_seed` and into this document for AI-agent operators:

1. **Use a general-purpose subagent for implementation** — `feature-dev:*` skills are read-only planning tools, not code writers. Dispatch a generic implementation subagent for any task that modifies files.

2. **Share a types stub in every parallel dispatch** — When dispatching multiple agents to work on the same codebase in parallel, include a minimal shared-types snippet in each agent's prompt. Without it, agents independently invent incompatible interface shapes that cause merge conflicts.

3. **Use `js-yaml.dump()` for YAML serialization, never template strings** — CodeQL flags backslash-escape gaps in template-string YAML as high-severity ReDoS. Always use `js-yaml`'s `dump()` function.

4. **Use `execFile` not `exec` for subprocess calls** — `exec` passes the command through a shell, which allows shell injection when user-controlled input is embedded. `execFile` bypasses the shell entirely.

5. **No `+`-prefixed test files in SvelteKit `src/routes/`** — SvelteKit treats any file matching `+*.svelte` or `+*.ts` inside `src/routes/` as a route or layout. Test files placed there cause build failures. All test files belong under `tests/` or `__tests__/`.

6. **Use `String.includes()` for user-controlled-input matching, not regex** — Regex patterns applied to user-controlled strings are flagged by CodeQL as potential ReDoS vulnerabilities. For simple substring checks, use `String.includes()` or `String.startsWith()`.

7. **Do not assert `existsSync` on gitignored paths in tests** — Gitignored files (build artifacts, generated files, local config) are not guaranteed to be present in CI. Assert the logical behavior of the code, not the presence of generated files.

---

## Wave 5 capabilities (v23.5)

The following capabilities shipped in the v23.5 night-shift arc and are available to operators and agents:

### Per-item resume (T1)

Each cycle item writes a checkpoint to `.agentforge/cycles/<id>/checkpoints/<item-id>.json`.
Use `--resume <cycle-id>` to re-enter a cycle at the first incomplete item.
Stale checkpoints (>72 h) block unattended runs unless `--resume` is explicitly passed.

### Skill flywheel curator (T2 + T7)

`agentforge skills propose-from-learnings` reads `.agentforge/memory/*.jsonl`, clusters findings, and writes proposals to `.agentforge/flywheel/proposals/`.
Approve, reject, or revert proposals at `/flywheel/proposals` in the dashboard or via `agentforge skills revert <slug>`.
See [docs/runbooks/skill-flywheel.md](docs/runbooks/skill-flywheel.md) for triage criteria.

### MCP server (T3)

`packages/mcp-server/` is a stdio MCP server used by Codex and other MCP hosts. The Codex plugin exposes `af_codex_readiness`, `af_cycle_preview`, and `af_cycle_status`.
Configure in any MCP host via `.mcp.json`.

### `/durability` dashboard page (T4)

`http://localhost:4751/durability` shows the checkpoint ring, per-guard status, and resume controls.
Backed by `GET /api/v5/durability`.

### Unattended guards (T5)

Set `AGENTFORGE_UNATTENDED=1` to activate five pre-flight guards before a cycle starts:
budget headroom, clean working tree, test baseline, stale-checkpoint check, disk space.
Any failing guard aborts with a non-zero exit and a human-readable message.
See [docs/runbooks/unattended-cycle.md](docs/runbooks/unattended-cycle.md) for recovery steps.

### Replay and coverage CLI (T6)

`agentforge cycle replay <cycle-id>` — re-runs the execute phase with the same item set.
`agentforge cycle coverage <cycle-id>` — prints per-item test-coverage delta.

---

## Development commands

```bash
# Install dependencies
corepack enable && corepack pnpm install

# Build all packages
corepack pnpm build

# Run all tests
corepack pnpm test

# Run a specific test file
corepack pnpm exec vitest run tests/genesis/team-designer.test.ts

# Type-check (no emit)
corepack pnpm exec tsc -b --noEmit

# Lint
corepack pnpm exec eslint .

# Full verification gate (lint + versions + build + dashboard check)
corepack pnpm verify:gates

# Start the development server
agentforge start
# or:
corepack pnpm --filter @agentforge/server dev
```

---

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `AGENTFORGE_RUNTIME` | `auto` | Execution transport: `auto`, `sdk`, `cli`, `anthropic-sdk`, `claude-cli`, `claude-code-compat`, `codex-cli`, `openai-sdk` |
| `AGENTFORGE_FORGE_STRATEGY` | `legacy` | Forge pipeline: `legacy` (deterministic) or `agent-driven` (Opus synthesis) |
| `MAX_PARALLEL_AGENTS` | `8` | Max concurrent agents in the execute phase (hard cap: 40) |
| `ANTHROPIC_API_KEY` | — | Required when `AGENTFORGE_RUNTIME=sdk` |
| `GH_TOKEN` | — | GitHub token (`repo` scope); required for PR creation in the release phase |

---

## Required versions

- Node.js `>=22.13.0`
- pnpm (via Corepack)
- TypeScript strict mode, NodeNext module resolution
- ESM only — all imports must end in `.js`, Node builtins must use the `node:` prefix

---

## Related docs

- [External Project Quickstart](docs/quickstart-external-project.md) — full walkthrough for a new user
- [Runtime Modes](docs/runtime-modes.md) — `AGENTFORGE_RUNTIME` deep-dive
- [Autonomous Loop Guide](docs/guides/autonomous-loop.md) — 9-phase cycle internals
- [Configuration Reference](docs/guides/autonomous-config-reference.md) — all `autonomous.yaml` options
- [API Reference](docs/api-reference.md) — v5 REST endpoint catalog
- [Troubleshooting](docs/external-project-troubleshooting.md) — common failure modes
