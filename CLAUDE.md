# AgentForge — CLAUDE.md

**Audience:** An AI agent (or human developer) opening this repository for the first time.

AgentForge is a Claude-first autonomous development product. It scans a software project, forges an AI agent team specialized to that project, and develops the project autonomously through **objective-driven epic cycles**: you give it an objective and a budget, and it returns one reviewed, verified pull request with a spend report. Every cycle accumulates learnings, so the forged agents become more specialized over time.

AgentForge is one product, not a plugin of any host. Codex is optional auxiliary capacity — used only when the `codex` binary resolves on PATH **and** passes identity validation; the product works Claude-only.

---

## Repository layout

```
packages/
  cli/          — canonical CLI surface (`agentforge` binary)
  core/         — forge pipeline, epic/cycle orchestration, runtime services
  server/       — Fastify v5 REST + SSE API server
  dashboard/    — SvelteKit operator UI (http://localhost:4751)
  db/           — WorkspaceAdapter + SQLite schema helpers
  shared/       — shared types and utilities
  embeddings/   — vector embeddings subsystem
  executor/     — autonomous cycle executor
  mcp-server/   — stdio MCP server (`af_*` tools) for Claude Code and other MCP hosts
  plugins-sdk/  — plugin authoring helpers
  skills-catalog/ — skill catalog and governance helpers

src/            — legacy compatibility shims (forward to packages/)
plugins/agentforge-codex/ — optional Codex auxiliary-capacity wrapper
tests/          — vitest test suites (mirrors packages/ structure)
.agentforge/    — workspace data: agents/, team.yaml, memory/, knowledge/, cycles/
```

---

## What AgentForge is

AgentForge scans a software project's source tree, dependency graph, git history, and engineering conventions and forges an optimized AI agent team specialized to develop that project autonomously. The forged agents each own a well-scoped subsystem, with capability tiers that route work by judgment density:

| Tier | Model | Used for |
|---|---|---|
| `fable` | `claude-fable-5` | The highest-judgment seats: epic decomposition, architecture, final verdicts |
| `opus` | Claude Opus 4.8 | Strategic policy and the heaviest implementation seats |
| `sonnet` | Claude Sonnet 4.6 | Implementation, quality, and cycle-framework seats |
| `haiku` | Claude Haiku | Utility work: linting, memory curation, file reading |

---

## Current team composition

The v25 team lives in `.agentforge/agents/` and `.agentforge/team.yaml`. It contains **34 specialist agents** organized in five buckets (`rd-strategist` and `rd-reviewer` were removed in v25):

### Judgment (Fable, xhigh)

| Agent | Domain |
|---|---|
| `chief-architect` | Monorepo topology, cross-package contracts, ADRs |
| `epic-planner` | Objective → grounded epic decomposition, dependency DAG, wave scheduling |
| `ceo` | Gate-phase verdicts, final release judgment |

### Strategic (Opus, xhigh)

| Agent | Domain |
|---|---|
| `forge-engine-architect` | Forge pipeline design end-to-end |
| `autonomy-strategist` | Autonomous loop policy, budget gates, self-correction |
| `backlog-scorer` | Audit/plan scoring, backlog prioritization |

### Heavy implementation (Opus, high)

| Agent | Domain |
|---|---|
| `executor-runtime-engineer` | Cycle executor, Planner/Executor step shapes |
| `fastify-v5-engineer` | All `/api/v5/*` Fastify routes, SSE bridge, DM/inbox/KB routes |
| `auth-security-engineer` | Auth plugin, RBAC, security gate |
| `code-reviewer` | Review-phase findings, structured epic review |

### Implementation, quality, and framework seats (Sonnet, high)

| Agent | Domain |
|---|---|
| `fastify-v6-shim-engineer` | v6 path-rewriting shim, namespace compatibility |
| `db-workspace-engineer` | WorkspaceAdapter, SQLite schema, migrations |
| `embeddings-engineer` | Vector embeddings subsystem |
| `plugin-sdk-engineer` | Plugin authoring SDK, Claude Code plugin integration |
| `cli-engineer` | CLI commands, Commander registration, `agentforge demo` |
| `scanner-engineer` | File scanner, language detection, CI provider detection |
| `reforge-genesis-engineer` | Reforge diff engine, genesis flow |
| `svelte-cycles-engineer` | `/cycles` and `/cycles/:id` dashboard pages |
| `svelte-agents-engineer` | `/agents` and `/agents/:id` dashboard pages |
| `svelte-runner-engineer` | `/runner`, `/live`, `/jobs`, `/workspaces` pages |
| `svelte-component-atoms-engineer` | Shared Svelte 5 component atoms |
| `shared-utils-engineer` | Cross-package utilities in `@agentforge/shared` |
| `pr-merge-manager` | PR lifecycle, GitHub API, merge queue |
| `test-engineer` | Vitest suites, coverage, test strategy |
| `ci-build-engineer` | CI config, build pipeline, turbo tasks |
| `architect` | Plan-phase seat in the cycle runner |
| `researcher` | Audit-phase seat: backlog, memory, and history research |
| `coder` | Generalist implementation seat |
| `backend-qa` | Test-phase seat |
| `scorer-evaluator` | Step-score evaluation, rubric grading |

### Utility (Haiku, medium)

| Agent | Domain |
|---|---|
| `yaml-doctor` | YAML serialization, agent manifest linting |
| `memory-curator` | JSONL memory files, flywheel curation |
| `file-reader` | File reading, context assembly |
| `data-analyst` | Learn-phase seat, memory distillation |

---

## Running a cycle

Objective-driven epic cycles are the primary flow.

The primary way to use AgentForge is to hand it an objective and a budget:

```bash
agentforge cycle run --objective "Ship an operator console for epic cycles" --budget 50
```

The cycle then runs end-to-end:

1. **Grounded decomposition** — the `epic-planner` (fable tier) explores the actual repository with `Read`/`Glob`/`Grep` tools before writing the plan; every path in the plan must be grounded. The plan is budget-banded: `spendable = (budget − 6) / 1.2` (the $6 is fixed gate/judgment overhead; dividing by 1.2 reserves 20% for fix-ups), and the children's estimated costs must sum to **0.7–1.0× spendable** or the plan is rejected. Each child item declares a `files[]` list — this is an **enforced contract**, not a hint (see Lesson 12).
2. **Parallel children in isolated worktrees** — each child runs in its own git worktree and is merged only after passing a **deterministic per-child bar** (`child-verify`, no LLM judgment): iron-law checks in code (non-empty diff, declared files touched, spec-required tests present), worktree dependency provisioning using package-manager **completion markers** (not bare `node_modules` existence), a scoped typecheck and the affected tests using **lockfile-detected** commands (pnpm/yarn/npx), with changed test files force-included and `testing.knownFlakyTestFiles` excluded.
3. **Single integration branch** — passing children merge into one local integration branch `codex/epic-<id>` held in a dedicated worktree.
4. **Structured epic review** — a strong-model reviewer returns `APPROVE` or `REQUEST_CHANGES`; unparseable output becomes `TRIAGE` (approve-equivalent), **never an auto-REJECT** — the deterministic VERIFY stage remains the release authority. Every fault must cite an exact plan `itemId`; unknown ids are dropped, and faulted items get at most **2 funded fix-up rounds** that re-run precisely the faulted items.
5. **Full-suite VERIFY → ONE PR** — the full test suite runs against the integration branch, then exactly one PR is opened from `codex/epic-<id>` with a spend report in the body.
6. **Terminal artifacts** — every completed cycle writes `completed.json` (the CycleResult snapshot), `spend-report.json` (planned-vs-actual reconciliation), and one `cycle-ledger.jsonl` row — the calibration feed that grounds future planners' cost estimates.

### Rehearse the decomposition cheaply

```bash
agentforge cycle preview --objective "Ship an operator console" --budget-usd 50
```

Runs the planner + validation only — no cycle, no git, no execution.

### Resume an interrupted cycle

Per-item completion is checkpointed in `.agentforge/cycles/<id>/checkpoint-execute.json` (aggregated `completedItemIds[]`); phase-level state is in `checkpoint-cycle.json`.

```bash
agentforge cycle run --resume <cycle-id>
```

Stale checkpoints (>72 h) block unattended runs unless `--resume` is explicitly passed.

### Legacy signal cycles (secondary)

`agentforge cycle run` without `--objective` runs the older 9-phase signal-backlog loop (`audit → plan → assign → execute → test → review → gate → release → learn`). It still works but is secondary and slated for deletion — prefer objective mode.

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

## Runtime resolution (Claude-first)

AgentForge is Claude-first. The default `auto` resolver prefers the Anthropic SDK, then the Claude Code compatibility transport, then the Codex CLI, then the OpenAI SDK — and when agent tools are requested, the Claude Code transport is preferred outright.

**Codex is auxiliary, never required.** The availability gate uses Codex only when the binary resolves (`AGENTFORGE_CODEX_BIN` → PATH) **and** passes identity validation (a wrong binary answering on PATH is rejected). Under the split-tier routing policy, `auto` routes sonnet-tier implementation children to Codex `gpt-5.5` at high effort when it is available; **judgment and security work always stays on Claude** (the anthropic profile's alternate chain is `anthropic-sdk` only — Codex is deliberately absent).

`AGENTFORGE_RUNTIME` is an escape hatch for pinning a transport explicitly:

| Value | Transport |
|---|---|
| `auto` | Claude-first resolver (default): prefers the Anthropic SDK, then the Claude Code compatibility transport, then the Codex CLI, then the OpenAI SDK when available |
| `sdk` / `anthropic-sdk` | Anthropic SDK (requires `ANTHROPIC_API_KEY`) |
| `cli` / `claude-cli` / `claude-code-compat` | Claude Code CLI compatibility transport |
| `codex-cli` | Codex CLI transport |
| `openai-sdk` | OpenAI-compatible SDK transport |

Precedence: `AGENTFORGE_RUNTIME` env var > `runtime:` in `.agentforge/autonomous.yaml` > hardcoded `auto`.

### Cycle configuration

`.agentforge/autonomous.yaml` controls cycle parameters:

```yaml
runtime: auto     # escape hatch: auto | sdk | cli | anthropic-sdk | claude-cli | claude-code-compat | codex-cli | openai-sdk

budget:
  perCycleUsd: 30
  allowOverageApproval: true

limits:
  maxItemsPerSprint: 5
  maxExecutePhaseParallelism: 8

quality:
  testPassRateFloor: 0.95

testing:
  knownFlakyTestFiles: []     # excluded from per-child scoped test runs

git:
  branchPrefix: autonomous/
  baseBranch: main

pr:
  draft: false
  assignReviewer: your-github-username
```

---

## Forge pipeline

The agent-driven forge runs four phases:

```
Phase A — Recon        5 parallel recon agents emit structured JSON
Phase B — Synthesis    A strong model reads all recon artifacts and writes every agent's system_prompt
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

**Phase B synthesis** produces a `TeamPlan` (Zod-validated JSON). Each agent entry carries `id`, `tier`, `category`, `owns_subsystems`, `capability_tags`, `system_prompt`, `auto_include_files`, and `learnings_seed`. The tier enum is `fable | opus | sonnet | haiku` (the `.claude/agents` mirror emits the full model id `claude-fable-5` for the fable tier, since Claude Code has no `fable` alias). Synthesis is guarded against host-framing drift: forged prompts describe AgentForge as the product, never as a plugin of Claude Code or Codex.

**Phase C validation** runs deterministic checks: `auto_include_files` exist, `owns_subsystems` are non-empty, system prompt references real paths, no domain contradictions, no duplicate prompts. Produces `.agentforge/forge/validation-report.json`.

**Phase D routing** reads every agent YAML and emits `.agentforge/routing-index.json` mapping `capability_tags` and `owns_subsystems` to agent IDs for dispatch routing.

**Output files written by forge:**

```
.agentforge/agents/<id>.yaml          — AgentTemplate-compatible YAML per agent
.claude/agents/<id>.md                — Claude Code frontmatter + system_prompt
.agentforge/team.yaml                 — team manifest
.agentforge/forge/team-plan.json      — raw synthesis output (audit trail)
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

### Agent-driven forge

To use the agent-driven synthesis pipeline, set `AGENTFORGE_FORGE_STRATEGY`:

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

## Claude Code integration

```bash
agentforge claude setup
```

Wires a project for Claude Code sessions: merges an `agentforge` entry into the project's `.mcp.json` (requires a built `packages/mcp-server/dist/index.js` — run `corepack pnpm build` first) and re-emits any missing `.claude/agents/<id>.md` mirrors from the committed `.agentforge/agents/` YAMLs, so a Claude Code session can dispatch the forged team directly.

`packages/mcp-server/` is a stdio MCP server exposing `af_agent_dispatch`, `af_agent_invoke`, `af_codex_readiness`, `af_cycle_events`, `af_cycle_preview`, `af_cycle_status`, `af_kb_lookup`, `af_kb_search`, and `af_memory_query`. It works in any MCP host via `.mcp.json`.

---

## Memory and learning loop

Every gate verdict and code review finding flows back into agent learnings automatically. Memory files accumulate in `.agentforge/memory/`:

```
.agentforge/memory/
  cycle-outcome.jsonl       # per-cycle result records
  gate-verdict.jsonl        # pass/fail with reasoning
  review-finding.jsonl      # per-agent review findings
  agents/<id>.jsonl         # per-agent personal memory (v25)
```

Starting from the second forge (or after an explicit `agentforge team forge`), the synthesis agent reads these files and injects up to 8 lessons per agent into each agent's `system_prompt` via `learnings_seed`. This is the flywheel: cycles accumulate evidence, forge reads evidence, agents become more specialized.

The `memory-curator` agent is responsible for deduplicating and distilling raw findings. The 8-lesson cap per agent is a hard limit enforced in synthesis — do not bypass it.

### Knowledge notes (v24)

`.agentforge/knowledge/entities.jsonl` is an append-only knowledge store of entity notes extracted during audit and review phases. Relevant notes are retrieved and injected into both child item prompts and the epic-planner prompt, so plans and implementations are grounded in accumulated project knowledge.

### Per-agent memory (v25)

Each agent has a personal memory file at `.agentforge/memory/agents/<id>.jsonl`. The write path records assigned items plus any `LEARNED:` notes the agent emits in its final report; the read path injects a `## Your history` block into that agent's prompt on its next run. Browse per-agent memory on the `/memory` dashboard page and on each agent's detail page.

### Skill flywheel

`agentforge skills propose-from-learnings` reads `.agentforge/memory/*.jsonl`, clusters findings, and writes proposals to `.agentforge/flywheel/proposals/`. Approve or revert at `/flywheel/proposals` in the dashboard or via `agentforge skills approve-proposal <id>` (add `--revert` to undo). See [docs/runbooks/skill-flywheel.md](docs/runbooks/skill-flywheel.md) for triage criteria.

---

## Dashboard and API

```bash
agentforge start    # http://localhost:4751
```

- **Agent editor** — edit an agent's prompt, tier, effort, skills, and tools from the agent detail page; changes go through `PATCH /api/v5/agents/:id`, are audit-logged, and the `.claude/agents` mirrors are regenerated.
- **Epic artifacts API** — `GET /api/v5/cycles/:id/decomposition`, `GET /api/v5/cycles/:id/epic-review`, and `GET /api/v5/cycles/:id/spend-report` serve the epic plan, review verdict, and spend reconciliation for any cycle.
- **`/durability`** — checkpoint ring, per-guard status, and resume controls, backed by `GET /api/v5/durability`.
- **`/memory`**, **`/flywheel/proposals`**, **`/knowledge`** — memory browser, skill-proposal triage, knowledge bases.

### Unattended guards

Set `AGENTFORGE_UNATTENDED=1` to activate five pre-flight guards before a cycle starts: budget headroom, clean working tree, test baseline, stale-checkpoint check, disk space. Any failing guard aborts with a non-zero exit and a human-readable message. See [docs/runbooks/unattended-cycle.md](docs/runbooks/unattended-cycle.md) for recovery steps.

### Replay and coverage CLI

`agentforge replay step-scores` — step-score aggregates grouped by (agent, capability tag).
`agentforge skills coverage` — skill coverage report across the team.

---

## Concurrent agents

Agents within a cycle execute in isolated git worktrees to prevent branch collisions. Key parameters:

- **Default parallelism:** 8 concurrent agents (`MAX_PARALLEL_AGENTS` default)
- **Hard maximum:** 40 concurrent agents
- **Override:** `export MAX_PARALLEL_AGENTS=16`
- **Per-cycle cap:** `maxExecutePhaseParallelism` in `autonomous.yaml`

Each worktree is allocated as `agent-<agentId>-<sessionId>` and checked out on its own branch. The concurrency gate queues callers when saturated and force-releases stale slots after 30 minutes to prevent deadlock. On the epic path, children merge into the single integration branch `codex/epic-<id>` rather than opening per-agent PRs.

**CRITICAL for multi-agent work:** When running parallel agents in a Claude Code session, always commit and push in a single atomic bash call. Concurrent agents switch git branches between bash calls, and stash pollution leaks untracked files across branches.

---

## Lessons (12 cumulative)

These lessons are baked into every agent's `learnings_seed` and into this document for AI-agent operators:

1. **Use a general-purpose subagent for implementation** — `feature-dev:*` skills are read-only planning tools, not code writers. Dispatch a generic implementation subagent for any task that modifies files.

2. **Share a types stub in every parallel dispatch** — When dispatching multiple agents to work on the same codebase in parallel, include a minimal shared-types snippet in each agent's prompt. Without it, agents independently invent incompatible interface shapes that cause merge conflicts.

3. **Use `js-yaml.dump()` for YAML serialization, never template strings** — CodeQL flags backslash-escape gaps in template-string YAML as high-severity. Always use `js-yaml`'s `dump()` function.

4. **Use `execFile` not `exec` for subprocess calls** — `exec` passes the command through a shell, which allows shell injection when user-controlled input is embedded. `execFile` bypasses the shell entirely.

5. **No `+`-prefixed test files in SvelteKit `src/routes/`** — SvelteKit treats any file matching `+*.svelte` or `+*.ts` inside `src/routes/` as a route or layout. Test files placed there cause build failures. All test files belong under `tests/` or `__tests__/`.

6. **Use `String.includes()` for user-controlled-input matching, not regex** — Regex patterns applied to user-controlled strings are flagged by CodeQL as potential ReDoS vulnerabilities. For simple substring checks, use `String.includes()` or `String.startsWith()`.

7. **Do not assert `existsSync` on gitignored paths in tests** — Gitignored files (build artifacts, generated files, local config) are not guaranteed to be present in CI. Assert the logical behavior of the code, not the presence of generated files.

8. **Register every v5 route in BOTH boot paths** — new routes must be registered in `registerV5Routes` (adapter mode) AND in `server.ts` behind the no-adapter guard. An unguarded duplicate registration kills the full-stack boot; a missing one 404s in no-adapter mode.

9. **FS-reading routes need per-route rate limiting** — any route that reads the filesystem must carry a per-route `@fastify/rate-limit` config (`config: { rateLimit: { ... } }`) or CodeQL blocks the PR.

10. **CodeQL path injection needs resolve+startsWith containment** — match-then-use validation alone is not credited by the analyzer. Use the `safeJoin` pattern (`resolve(join(base, ...))` then verify the result `startsWith` the base + separator) so CodeQL can trace a sanitized value.

11. **Worktree toolchains need lockfile detection + completion markers** — never hardcode `pnpm exec` for child worktrees (external repos may be npm/yarn); detect from the lockfile. And gate dependency provisioning on the package manager's install **completion marker** (`node_modules/.modules.yaml` for pnpm, `.package-lock.json` for npm), not bare `node_modules` existence — killed runs leave partial trees that an existence check happily skips.

12. **Plan `files[]` scope is enforced** — a child's declared `files[]` is a contract checked by per-child verify. Declare every file the child will edit, including registration entry points (route indexes, command registries), or the child fails its bar.

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
| `AGENTFORGE_RUNTIME` | `auto` | Transport escape hatch: `auto`, `sdk`, `cli`, `anthropic-sdk`, `claude-cli`, `claude-code-compat`, `codex-cli`, `openai-sdk` |
| `AGENTFORGE_FORGE_STRATEGY` | `legacy` | Forge pipeline: `legacy` (deterministic) or `agent-driven` (synthesis) |
| `MAX_PARALLEL_AGENTS` | `8` | Max concurrent agents in the execute phase (hard cap: 40) |
| `AGENTFORGE_UNATTENDED` | — | Set to `1` to activate the five pre-flight guards |
| `AUTONOMOUS_BUDGET_USD` | — | Per-cycle budget; overridden by `--budget` |
| `AGENTFORGE_CODEX_BIN` | — | Absolute path to the real Codex CLI (else PATH resolution + identity validation) |
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
- Objective Mode Guide (`docs/guides/objective-mode.md`) — objective-driven epic cycles end-to-end; shipping with the operator-console epic
- [Runtime Modes](docs/runtime-modes.md) — `AGENTFORGE_RUNTIME` deep-dive
- [Autonomous Loop Guide](docs/guides/autonomous-loop.md) — legacy 9-phase cycle internals
- [Configuration Reference](docs/guides/autonomous-config-reference.md) — all `autonomous.yaml` options
- [API Reference](docs/api-reference.md) — v5 REST endpoint catalog
- [Troubleshooting](docs/external-project-troubleshooting.md) — common failure modes
