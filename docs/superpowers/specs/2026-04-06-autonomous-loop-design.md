# AgentForge Autonomous Development Loop — Design Spec

**Date:** 2026-04-06
**Version target:** v6.4.0 (first autonomous cycle output)
**Status:** Approved
**Approach:** Supervised Loop + Phase Auto-Advance (Approach B from brainstorming)
**Implementation estimate:** ~18 new source files, ~2,800 LOC, ~75 new tests

---

## 1. Executive Summary

AgentForge v6.3 shipped real agent execution via `AgentRuntime.runStreaming()`, phase-to-agent mapping (audit→researcher, plan→CTO, assign→AutoDelegationPipeline, execute→parallel dispatch, test→backend-qa, review→code-reviewer, gate→CEO), career integration, and hiring pipeline. What it does not have is the glue that turns those pieces into an end-to-end loop that can plan, execute, test, commit, and open a PR without a human pressing nine buttons.

This spec defines that glue: a new `packages/core/src/autonomous/` module containing a `CycleRunner` that orchestrates one end-to-end development cycle, a `PhaseScheduler` that auto-advances between sprint phases, real subprocess wrappers for vitest and git, a `gh`-based PR opener, an agent-driven scoring pipeline that decides what the next sprint should work on, and a centralized `KillSwitch` that enforces budget, duration, and regression limits.

The first cycle produces **v6.4.0** — AgentForge's first autonomous sprint. From v6.4.0 onward, AgentForge writes its own sprint plans, executes them, verifies them with real tests, and opens real PRs for human review. The persistent daemon, durable state, and horizontal scale work is explicitly deferred to the *next* cycle, which AgentForge will build itself — the "bootstrap paradox" is the intentional design.

---

## 2. Context: Where v6.3 Stands

### 2.1 What works (verified against current code)

- **Real Anthropic API execution** — `packages/core/src/agent-runtime/agent-runtime.ts` exposes `run()` and `runStreaming()` methods that invoke the Anthropic SDK with real API keys, track costs per call against `MODEL_PRICING`, and persist cost entries to SQLite via `WorkspaceAdapter.recordCost()`.
- **Sprint phase pipeline** — `packages/server/src/routes/v5/sprint-orchestration.ts` exposes HTTP routes that run phase-specific agents for each of the 9 phases (audit, plan, assign, execute, test, review, gate, release, learn). Each phase transition is currently driven by a `PATCH /api/v5/sprints/:version/advance` HTTP call.
- **Agent roster** — 138 agents in `.agentforge/agents/*.yaml` including CEO, CTO, COO, CFO, VP Engineering, tech leads, and specialists. Each has a `system` prompt, model tier, and skills list.
- **Auto-delegation** — `packages/server/src/lib/auto-delegation.ts` implements keyword-based delegation from CTO technical plans to team assignments.
- **Career integration** — `postTaskHook` fires after every agent run, recording task memories, exercising skills, evaluating level-ups, and emitting promotion recommendations.
- **Self-correction scaffolding** — `packages/core/src/self-correction/` contains `Guardrails`, `GitCheckpoint`, `RegressionDetector`, and `DeadEndTracker` classes. The logic is there; the subprocess wiring is not.
- **Canary deployments** — `CanaryManager` supports feature flag traffic splitting and auto-rollback at configurable error-rate thresholds.
- **Resilience layer** — `packages/core/src/resilience/` provides `RetryPolicy`, `TimeoutWrapper`, and `HealthMonitor` (rolling-window circuit breaker).
- **Test count at baseline** — 3,948 tests passing as of commit `3e6839c`.

### 2.2 Critical gaps (the reason this spec exists)

| Capability | Status in v6.3 | Evidence |
|---|---|---|
| Live agent execution via Anthropic API | Working | `agent-runtime.ts:113` (`runStreaming`) |
| Phase pipeline dispatches real agents | Working | `sprint-orchestration.ts` phase handlers |
| **Auto-advance between phases** | Missing | Every phase transition requires an HTTP PATCH call |
| **Real test runner (shells `vitest`)** | Missing | `sprint-evaluator.ts:13` comment: "In production, would shell out to vitest" |
| **Real git ops (commit/branch/rollback)** | Missing | `git-checkpoint.ts:35` comment: "Not implemented — production git integration is future work" |
| **Backlog → next sprint bridge** | Missing | `SelfProposalEngine`, `SprintPredictor`, `SprintPlanner` exist but no code calls them in sequence |
| **Autonomous scheduler/daemon** | Missing | `SprintPromoter.runCycle()` exists but uses dry-run `SprintRunner` |
| `SprintRunner` wired to `AgentRuntime` | Missing | `sprint-runner.ts:40` throws `'Production execution not yet wired — use dryRun: true'` |
| Durable state for proposals/branches/canaries | Missing | All `Map<>` in-memory, lost on restart |

### 2.3 Two parallel sprint execution universes

An important structural finding: v6.3 has two disconnected paths for sprint execution:

1. **`SprintRunner`** (`packages/core/src/sprint/sprint-runner.ts`) — the *planned* autonomous path. Clean interface, integrated with `SprintPromoter.runCycle()`. Throws on production execution, only supports dry-run.
2. **`sprint-orchestration.ts`** (`packages/server/src/routes/v5/`) — the *real* path. Calls live `AgentRuntime`, but requires HTTP PATCH per phase. Used by the dashboard and CLI.

This spec unifies these paths by extracting phase handlers from `sprint-orchestration.ts` into plain async functions in a new `packages/server/src/lib/phase-handlers.ts`, then having both the HTTP routes and the new `PhaseScheduler` call those functions directly.

---

## 3. Goals and Non-Goals

### 3.1 Goals

1. **Supervised autonomous loop** — AgentForge plans, executes, tests, commits, and opens a PR. Human reviews and merges.
2. **Self-proposed work** — the system scans sessions, cost anomalies, test failures, and `TODO(autonomous)` markers to decide what to work on next. No human-curated backlog required.
3. **Agent-driven scoring** — a new `backlog-scorer` agent ranks candidates, estimates costs, and flags over-budget items for approval.
4. **Real test and real git** — no fake subprocess calls. `vitest` runs for real, `git` runs for real, `gh pr create` runs for real.
5. **Configurable safety** — `.agentforge/autonomous.yaml` defines budget, limits, quality gates, and kill-switch criteria.
6. **Auditable by default** — every cycle produces `.agentforge/cycles/{cycleId}/` with structured logs of every decision, agent call, test result, git operation, and PR detail.
7. **Scale-compatible** — architecture does not preclude a future daemon, horizontal scaling, or durable state. Avoid choices that would require rewriting core modules to scale.

### 3.2 Non-goals (explicitly deferred)

These are reserved for the *second* autonomous cycle — the first sprint AgentForge writes about itself:

- **Persistent daemon** — a long-running process that loops cycles continuously. The current design is CLI-invoked: one cycle per `npm run autonomous:cycle` call.
- **Durable state for in-memory stores** — `SelfProposalEngine`, `SprintPlanner`, `DeadEndTracker`, `CanaryManager`, `GitBranchManager`, `EscalationProtocol` all remain in-process `Map<>` stores. They do not need to survive restarts to run a single supervised cycle.
- **Horizontal scale infrastructure** — no work queue, no Postgres, no distributed coordination. The current single-process Fastify server and SQLite database are sufficient for supervised cycles.
- **Multi-workspace autonomous cycles** — one cycle operates on one workspace at a time.
- **Cross-cycle learning transfer** — each cycle is independent. Knowledge extraction happens within a cycle; there is no mechanism to feed last cycle's learnings into this cycle's scoring beyond what `SelfProposalEngine` already reads from session history.
- **Automatic PR merging** — the human reviews and merges. Auto-merge is a conscious follow-up decision.

### 3.3 The bootstrap paradox

Every capability in section 3.2 is deferred with the explicit expectation that the *first autonomous cycle* (v6.4.0, produced by running this spec's output) will include sprint items to build them. The spec targets the minimum complete loop. The loop, once closed, builds its own next iteration.

---

## 4. Key Decisions

These are the locked-in decisions from the design session. Each drove specific spec content.

| Decision | Value | Source |
|---|---|---|
| Autonomy level | Supervised loop (PR-based) | Q1 answer |
| Work sourcing | Self-proposals from metrics | Q2 answer |
| Budget | $50/cycle, configurable via `.agentforge/autonomous.yaml` | Q3 answer |
| Version bumping | Full semver (major/minor/patch) with tag-driven rules | Section 2 refinement |
| Proposal ranking | Agent-driven (`backlog-scorer`), with 3-strike fallback to static | Section 2 refinement |
| Budget overflow | Prompt for human approval on overage | Section 2 refinement |
| All decisions logged | `.agentforge/cycles/{cycleId}/` structured logs | Section 2 refinement |
| Phase auto-advance | Event-driven via in-process EventBus | Section 3 |
| Phase handler extraction | Refactor `sprint-orchestration.ts` into plain async functions | Section 3 |
| Execute phase failure threshold | ≤50% item failures tolerated before phase-fail | Section 3 |
| Diagnostic branch on failure | Keep — local-only commit on `autonomous/vX.Y.Z-failed` | Section 4 |
| Secret scan patterns | ANTHROPIC, OpenAI, GitHub PAT, AWS, private keys | Section 4 |
| PR reviewer | Auto-assign `seandonvaughan` | Section 4 |
| Scoring fallback | 3-strike ladder: retry → simpler schema → static ranking | Section 2 refinement |
| Logging approach | Filesystem (`.agentforge/cycles/{id}/`), no new DB tables | Section 1 |

---

## 4.1. Authentication Model (Added in v6.4.1)

**Critical design decision missed in v6.4.0 — corrected here.**

### The gap in v6.4.0

The original v6.4.0 spec inherited `AgentRuntime`'s implementation from v5.x, which uses the Anthropic SDK directly with `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`. This:

1. Requires users to have a separate Anthropic API key even if they have a Claude Max/Pro plan
2. Bills autonomous cycle calls against the API quota, not the plan quota
3. Would double-bill users who have both a plan *and* an API key
4. Cannot use the OAuth credentials stored by a logged-in Claude Code session

### The v6.4.1 fix: `claude -p` subprocess

`AgentRuntime.run()` now shells out to the `claude` CLI with `--output-format json`:

```bash
claude -p \
  --model claude-opus-4-6 \
  --output-format json \
  --no-session-persistence \
  --system-prompt "$AGENT_SYSTEM_PROMPT" \
  <<< "$USER_TASK"
```

The subprocess inherits the parent process's environment (including any OAuth tokens Claude Code has already loaded) and authenticates via the logged-in session. No `ANTHROPIC_API_KEY` required.

### Why not the Anthropic SDK with OAuth?

The Anthropic SDK does not expose a "use the logged-in Claude Code session" mode. The only supported auth paths are:
- `ANTHROPIC_API_KEY` environment variable
- Explicit `apiKey` parameter to the constructor
- Bedrock / Vertex / Foundry provider credentials

The `claude` CLI, in contrast, is built on top of the same auth layer as the Claude Code TUI — it reads OAuth tokens from the system keychain or plugin cache. Shelling out to `claude -p` is the only way to inherit a Claude Code session from another process.

### Cost accounting

The `claude` CLI reports `total_cost_usd` in its JSON output, reflecting actual billed tokens (including cache creation/read overhead that a local `MODEL_PRICING` calculation would miss). v6.4.1 uses this value as the authoritative cost source. The existing `MODEL_PRICING` table is retained as a fallback for the rare case where the CLI omits cost.

### Known token overhead

The `claude` CLI injects a default Claude Code system context (~51K tokens on our test call, written as `cache_creation_input_tokens`) on every invocation. Using `--system-prompt` replaces the default system prompt with the agent's own, but the baseline overhead remains. For a $50/cycle budget, this still comfortably allows 600–1000 agent calls per cycle. A future patch should investigate minimizing this overhead without losing OAuth-based auth.

### Streaming

v6.4.1 degrades `AgentRuntime.runStreaming()` — it delegates to `run()` and invokes `onChunk`/`onEvent` callbacks once at the end with the full result. Dashboard consumers will see phases transition from "running" → "completed" without live token deltas. Proper streaming via `claude -p --output-format stream-json --include-partial-messages` is deferred to a future patch.

### Interface bridging: `RuntimeAdapter`

`ScoringPipeline` expects a `RuntimeForScoring` service interface (`run(agentId, task, options)` → narrower result shape), while `AgentRuntime` is instantiated per-agent with a config (`new AgentRuntime(config, adapter)`). v6.4.1 adds a `RuntimeAdapter` class (`packages/core/src/autonomous/runtime-adapter.ts`) that:

1. Implements `RuntimeForScoring`
2. Lazily loads agent configs from `.agentforge/agents/{agentId}.yaml` on first use
3. Caches `AgentRuntime` instances per agentId for subsequent calls within a cycle
4. Translates `RunOptions`/`RunResult` to the `{output, usage, costUsd, durationMs, model}` shape

The CLI command (`packages/cli/src/commands/autonomous.ts`) should construct a `RuntimeAdapter` and pass it as `options.runtime` to `CycleRunner`. The `CycleRunnerOptions.runtime` type signature (`RuntimeForScoring`) is unchanged.

---

## 5. Architecture

### 5.1 Process model

One Node.js process per cycle invocation. The CLI command `npm run autonomous:cycle` loads configuration, instantiates a `CycleRunner`, and exits after either:

1. A PR has been opened successfully (exit code 0), or
2. A kill switch has tripped (exit code 2), or
3. An unexpected error has been raised (exit code 1).

Within a single cycle, sprint phases auto-advance via the existing in-process `EventBus`. The CLI is intentionally a dumb entry point; all real orchestration lives in `packages/core/src/autonomous/`. This makes the future daemon trivial: a 20-line loop calling `CycleRunner.start()` in a sleep cycle.

### 5.2 Module map

```
packages/core/src/autonomous/              [NEW]
├── cycle-runner.ts                        # Orchestrates one end-to-end cycle
├── proposal-to-backlog.ts                 # SelfProposalEngine → BacklogItem[]
├── scoring-pipeline.ts                    # backlog-scorer agent → ranked items
├── budget-approval.ts                     # Overrun approval gate (TTY + file)
├── sprint-generator.ts                    # SprintPredictor + SprintPlanner wiring
├── phase-scheduler.ts                     # EventBus → auto-advance between phases
├── kill-switch.ts                         # Cost/duration/regression/manual monitors
├── version-bumper.ts                      # Semver logic with tag-driven rules
├── cycle-logger.ts                        # Structured per-cycle log writer
├── config-loader.ts                       # Parses .agentforge/autonomous.yaml
├── pr-body-renderer.ts                    # Markdown PR body template
├── exec/
│   ├── real-test-runner.ts                # execFile('npx', ['vitest', 'run', ...])
│   ├── git-ops.ts                         # Real git subprocess with safety guards
│   └── pr-opener.ts                       # gh pr create with dry-run support
├── types.ts                               # CycleConfig, CycleResult, CycleStage enum
└── index.ts                               # Barrel export

packages/cli/src/commands/                 
└── autonomous.ts                          [NEW] CLI entry wired to commander

packages/server/src/lib/                   
└── phase-handlers.ts                      [NEW] Extracted from sprint-orchestration.ts

packages/server/src/routes/v5/
└── sprint-orchestration.ts                [PATCH] Thin wrappers + event publishing

.agentforge/
├── autonomous.yaml                        [NEW] Cycle configuration
└── agents/
    └── backlog-scorer.yaml                [NEW] Scoring agent

package.json                               [PATCH] Add "autonomous:cycle" npm script

tests/autonomous/                          [NEW]
├── unit/
│   ├── version-bumper.test.ts
│   ├── config-loader.test.ts
│   ├── cycle-logger.test.ts
│   ├── proposal-to-backlog.test.ts
│   ├── sprint-generator.test.ts
│   ├── scoring-pipeline.test.ts
│   ├── budget-approval.test.ts
│   ├── kill-switch.test.ts
│   ├── phase-scheduler.test.ts
│   ├── cycle-runner.test.ts
│   ├── pr-body-renderer.test.ts
│   └── exec/
│       ├── real-test-runner.test.ts
│       ├── git-ops.test.ts
│       └── pr-opener.test.ts
├── integration/
│   ├── phase-handlers-http.test.ts        # Regression: HTTP routes still work
│   ├── phase-handlers-direct.test.ts      # Direct function calls work identically
│   ├── real-test-runner-integration.test.ts  # Real vitest against fixture project
│   ├── git-ops-integration.test.ts        # Real git against tmp repo
│   └── full-cycle.test.ts                 # E2E smoke: mocked Anthropic, real git, dry-run PR
└── fixtures/
    ├── mock-anthropic.ts
    ├── tmp-git-repo.ts
    ├── tmp-workspace.ts
    ├── canned-scoring-response.json
    ├── canned-vitest-report.json
    ├── fake-sprint.yaml
    └── response-bank/                     # Per-agent canned responses
```

**Totals:** 18 new source files (16 in `packages/core/src/autonomous/`, 1 CLI, 1 extracted phase-handlers), 2 patched files, 1 new agent YAML, 1 new config file, ~75 new tests. Estimated ~2,800 LOC of new code (plus ~600 LOC of extracted code in `phase-handlers.ts`).

### 5.3 Data flow

```
CLI: npm run autonomous:cycle
  │
  ├─ ConfigLoader: read .agentforge/autonomous.yaml → CycleConfig
  ├─ CycleRunner.start():
  │  │
  │  ├─ STAGE 1: PLAN
  │  │  ├─ ProposalToBacklog:
  │  │  │   ├─ Query SQLite: failed sessions, cost anomalies, test outcomes
  │  │  │   ├─ Scan codebase for TODO(autonomous) markers
  │  │  │   ├─ SelfProposalEngine.fromSessions() → proposals
  │  │  │   └─ Filter by minProposalConfidence → BacklogItem[]
  │  │  └─ ScoringPipeline:
  │  │      ├─ Gather grounding: history, cost medians, team state
  │  │      ├─ Invoke backlog-scorer agent via AgentRuntime
  │  │      ├─ Validate ScoringResult schema (3-strike retry)
  │  │      └─ Return { withinBudget, requiresApproval }
  │  │
  │  ├─ BudgetApproval (if requiresApproval.length > 0):
  │  │  ├─ Write .agentforge/cycles/{id}/approval-pending.json
  │  │  ├─ TTY mode: inline prompt [y/N/edit]
  │  │  ├─ Non-TTY mode: poll approval-decision.json
  │  │  └─ Write approval-decision.json with outcome
  │  │
  │  ├─ STAGE 2: STAGE
  │  │  └─ SprintGenerator:
  │  │      ├─ VersionBumper: next version from item tags
  │  │      ├─ SprintPredictor.predict() → selected items
  │  │      ├─ SprintPlanner.plan() → sprint JSON
  │  │      ├─ Write .agentforge/sprints/v{next}.json
  │  │      └─ WorkspaceAdapter.createSprint() → DB row
  │  │
  │  ├─ STAGE 3: RUN
  │  │  └─ PhaseScheduler.run(sprintId):
  │  │      ├─ Subscribe to sprint.phase.completed events
  │  │      ├─ Trigger audit → (completion event) → auto-advance → plan → ...
  │  │      │  ├─ Each phase invokes runXxxPhase() from phase-handlers.ts
  │  │      │  ├─ Kill switch checked between phases
  │  │      │  └─ Logger records per-phase result
  │  │      └─ Resolves when learn phase completes
  │  │
  │  ├─ STAGE 4: VERIFY
  │  │  ├─ RealTestRunner.run():
  │  │  │   ├─ execFile('npx', ['vitest', 'run', '--reporter=json', ...])
  │  │  │   ├─ Parse JSON report → TestResult
  │  │  │   └─ Save to .agentforge/cycles/{id}/tests.json
  │  │  ├─ RegressionDetector.check() with real counts
  │  │  └─ KillSwitch.checkPostVerify(testResult, regression)
  │  │      └─ Trip on: testFloor, regression
  │  │
  │  ├─ STAGE 5: COMMIT
  │  │  ├─ GitOps.commitCycle():
  │  │  │   ├─ Safety gate: in git repo, clean tree, not on base branch
  │  │  │   ├─ Create autonomous/v{version} branch
  │  │  │   ├─ Stage specific files (never -A)
  │  │  │   ├─ Scan staged diff for secrets
  │  │  │   ├─ Commit with HEREDOC message + Co-Authored-By
  │  │  │   ├─ Verify still on feature branch
  │  │  │   └─ Push to origin
  │  │  └─ On test failure + includeDiagnosticBranchOnFailure:
  │  │      └─ Create autonomous/v{version}-failed (local only, no push)
  │  │
  │  └─ STAGE 6: REVIEW
  │     ├─ PR body renderer: scoring, tests, cost, files
  │     └─ PROpener.open():
  │         ├─ Verify gh installed + authed
  │         ├─ gh pr create --body-file - (body via stdin)
  │         ├─ Apply labels, assign seandonvaughan as reviewer
  │         └─ Return PR URL + number
  │
  ├─ Write final cycle.json with terminal stage
  └─ Exit: 0 (completed) / 1 (error) / 2 (killed)
```

The `KillSwitch` is checked at five explicit boundaries: between phases, after scoring, after tests, before push, and continuously via signal handlers (SIGINT/SIGTERM) and STOP file watching.

---

## 6. Cycle Lifecycle

### 6.1 Cycle stages

```typescript
// packages/core/src/autonomous/types.ts

export enum CycleStage {
  PLAN = 'plan',          // Proposal → backlog → scoring
  STAGE = 'stage',        // Write sprint JSON, persist to DB
  RUN = 'run',            // PhaseScheduler executes all 9 phases
  VERIFY = 'verify',      // Real vitest + regression check
  COMMIT = 'commit',      // Real git branch + commit + push
  REVIEW = 'review',      // gh pr create, print URL
  // Terminal states:
  KILLED = 'killed',      // Kill switch trip
  FAILED = 'failed',      // Uncaught error
  COMPLETED = 'completed',// Successful terminal state
}
```

### 6.2 Concrete types

```typescript
// packages/core/src/autonomous/types.ts

export interface CycleConfig {
  budget: {
    perCycleUsd: number;            // default 50
    perItemUsd: number;             // default 10
    perAgentUsd: number;            // default 15
    allowOverageApproval: boolean;  // default true
  };
  limits: {
    maxItemsPerSprint: number;      // default 20
    maxDurationMinutes: number;     // default 180
    maxConsecutiveFailures: number; // default 5
    maxExecutePhaseFailureRate: number; // default 0.5
  };
  quality: {
    testPassRateFloor: number;      // default 0.95
    allowRegression: boolean;       // default false
    requireBuildSuccess: boolean;   // default true
    requireTypeCheckSuccess: boolean; // default true
  };
  git: {
    branchPrefix: string;           // default "autonomous/"
    baseBranch: string;             // default "main"
    refuseCommitToBaseBranch: boolean; // default true
    includeDiagnosticBranchOnFailure: boolean; // default true
    maxFilesPerCommit: number;      // default 100
  };
  pr: {
    draft: boolean;                 // default false
    assignReviewer: string | null;  // default "seandonvaughan"
    labelPrefix: string;            // default "autonomous"
    labels: string[];               // default ["autonomous", "needs-review"]
    titleTemplate: string;          // default "autonomous(v{version}): {summary}"
  };
  sourcing: {
    lookbackDays: number;           // default 7
    minProposalConfidence: number;  // default 0.6
    includeTodoMarkers: boolean;    // default true
    todoMarkerPattern: string;      // default "TODO\\(autonomous\\)|FIXME\\(autonomous\\)"
  };
  testing: {
    command: string;                // default "npm run test:run"
    timeoutMinutes: number;         // default 20
    reporter: string;               // default "json"
    saveRawLog: boolean;            // default true
    buildCommand: string;           // default "npm run build"
    typeCheckCommand: string;       // default "npx tsc --noEmit"
  };
  scoring: {
    agentId: string;                // default "backlog-scorer"
    maxRetries: number;             // default 3
    fallbackToStatic: boolean;      // default true
  };
  logging: {
    logDir: string;                 // default ".agentforge/cycles"
    retainCycles: number;           // default 50
  };
  safety: {
    stopFilePath: string;           // default ".agentforge/cycles/{cycleId}/STOP"
    secretScanEnabled: boolean;     // default true
    verifyCleanWorkingTreeBeforeStart: boolean; // default true
    workingTreeWhitelist: string[]; // default [".agentforge/cycles/**", ".agentforge/audit.db-*"]
  };
}

export interface CycleResult {
  cycleId: string;                  // UUID
  sprintVersion: string;            // e.g. "6.4.0"
  stage: CycleStage;                // terminal stage
  startedAt: string;                // ISO 8601
  completedAt: string;              // ISO 8601
  durationMs: number;
  cost: {
    totalUsd: number;
    budgetUsd: number;
    byAgent: Record<string, number>;
    byPhase: Record<string, number>;
  };
  tests: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    passRate: number;
    newFailures: string[];          // tests that broke during this cycle
  };
  git: {
    branch: string;
    commitSha: string | null;       // null if stage < COMMIT
    filesChanged: string[];
  };
  pr: {
    url: string | null;             // null if stage < REVIEW
    number: number | null;
    draft: boolean;
  };
  killSwitch?: {
    reason: KillReason;
    detail: string;
    stageAtTrip: CycleStage;
    triggeredAt: string;
  };
  scoringFallback?: 'static';       // present if scoring agent failed and fell back
}

export type KillReason =
  | 'budget'
  | 'duration'
  | 'regression'
  | 'testFloor'
  | 'buildFailure'
  | 'typeCheckFailure'
  | 'consecutiveFailures'
  | 'manualStop'
  | 'manualStopFile';
```

### 6.3 Stage 1: PLAN — proposal-to-backlog pipeline

The `ProposalToBacklog` bridge queries SQLite within `config.sourcing.lookbackDays`:

- `sessions` table where `status = 'failed'` — agents that got stuck
- `agent_costs` with anomaly flag — cost spikes from cost-autopilot
- `task_outcomes` where `success = 0` — dead-end tracker signal
- `test_outcomes` — flaky test files tracked by RegressionDetector

Then calls `SelfProposalEngine.fromSessions()` to generate proposals with confidence scores, filters by `minProposalConfidence` (default 0.6), and also scans the codebase for `TODO(autonomous)` and `FIXME(autonomous)` markers. The `(autonomous)` qualifier is required — plain `TODO` / `FIXME` are ignored to avoid scraping random human comments.

**Marker format:** The marker must be preceded only by comment characters (`//`, `/*`, `*`, `<!--`, `#`) plus optional text. Markers embedded in strings, regex literals, or object literals are rejected by line-level prefix matching, preventing false positives from documentation strings or mock data within source comments. Test files and fixture directories are excluded to prevent ingesting escaped markers as real backlog items.

Each proposal and marker becomes a `BacklogItem` with:
- `priority: "P0" | "P1" | "P2"` based on proposal type
- `estimatedCostUsd` using historical median for similar items
- `tags` for team routing and version-bumper classification

### 6.4 Stage 1 (cont.): Agent-driven scoring

Hardcoded ranking is explicitly rejected. Scoring is an agent-driven step that runs inside the cycle before sprint generation.

**New agent:** `.agentforge/agents/backlog-scorer.yaml`

```yaml
id: backlog-scorer
name: Backlog Scorer
model: sonnet
seniority: senior
system: |
  You are the Backlog Scorer for AgentForge's autonomous development loop.
  
  Given a set of candidate work items and recent system telemetry, produce
  a ranked list with cost estimates, confidence scores, and explicit rationale
  for every decision.
  
  Your output is budget-bounded: flag items that would push the cycle over
  budget so a human can approve the overage. Never exceed the stated budget
  in your selected set without explicit approval markers.
  
  Consider:
  - Impact: how many recent failures would this item resolve?
  - Cost: what's the historical median for items of this size?
  - Dependencies: does this item depend on others in the backlog?
  - Risk: what's the chance this change breaks existing behavior?
  - Team fit: which agent is best suited for this work?
  
  Your output is structured JSON matching the ScoringResult schema.
skills:
  - proposal-analysis
  - cost-estimation
  - dependency-detection
output_format: structured_json
```

**New module:** `packages/core/src/autonomous/scoring-pipeline.ts` (~200 lines)

Responsibilities:
1. Gather grounding data from SQLite (session history, cost medians, team state)
2. Format as structured context for `backlog-scorer`
3. Invoke `AgentRuntime.run()` with `response_format: json_schema`
4. Validate against `ScoringResult` schema
5. Return `{ withinBudget: RankedItem[]; requiresApproval: RankedItem[] }`

**Scoring output schema:**

```typescript
export interface ScoringResult {
  rankings: RankedItem[];
  totalEstimatedCostUsd: number;
  budgetOverflowUsd: number;    // 0 if under budget
  summary: string;               // short rationale for the whole ranking
  warnings: string[];            // e.g. "3 items depend on v6.3 hiring pipeline"
}

export interface RankedItem {
  itemId: string;
  title: string;
  rank: number;                  // 1 = highest priority
  score: number;                 // 0..1
  confidence: number;            // 0..1
  estimatedCostUsd: number;
  estimatedDurationMinutes: number;
  rationale: string;             // agent's reasoning
  dependencies: string[];        // other itemIds
  suggestedAssignee: string;     // agent id
  suggestedTags: string[];       // feeds version-bumper
  withinBudget: boolean;         // scorer's own classification
}
```

**Three-strike fallback ladder:**

| Strike | Retry strategy |
|---|---|
| 1 | Retry with clarified prompt: "previous response failed schema validation: <detail>" |
| 2 | Retry with simpler schema: drop `dependencies` and `suggestedAssignee`, keep `rank`/`cost`/`rationale` |
| 3 | Fall back to static ranking: P0 first, then P1, then P2, within-budget truncation |

On fallback to strike 3, `CycleResult.scoringFallback = 'static'` is set so you can see in logs that the agent-driven path failed. The cycle still proceeds, but with a visible signal that scoring degraded.

### 6.5 Stage 1 (cont.): Budget approval gate

If `requiresApproval[]` is non-empty, the `BudgetApproval` module writes `.agentforge/cycles/{cycleId}/approval-pending.json`:

```json
{
  "cycleId": "...",
  "requestedAt": "2026-04-06T15:00:00Z",
  "withinBudget": {
    "items": [ /* RankedItem[] */ ],
    "totalCostUsd": 47.50
  },
  "overflow": {
    "items": [ /* RankedItem[] */ ],
    "additionalCostUsd": 11.00
  },
  "newTotalUsd": 58.50,
  "budgetUsd": 50.00,
  "agentSummary": "Items 1-6 fit in $50. Item 7 (migrate workspace-adapter) would add $11 for an $8 saving per future cycle."
}
```

**Dual approval collection:**

- **TTY mode** (interactive CLI): inline prompt via readline
  ```
  Budget overrun requested:
    Within budget: $47.50 for 6 items
    Overflow:      $11.00 for 1 item (migrate workspace-adapter)
    New total:     $58.50 / $50.00 budget
  
  Approve overage? [y/N/edit]:
  ```
- **Non-TTY mode** (future daemon): emit `autonomous.approval.pending` SSE event, poll `.agentforge/cycles/{cycleId}/approval-decision.json` until populated, then proceed.

Decision written to `approval-decision.json`:

```json
{
  "cycleId": "...",
  "decidedAt": "2026-04-06T15:01:30Z",
  "decision": "approved" | "rejected" | "edited",
  "approvedItems": [ "item-id-1", "item-id-2", ... ],
  "rejectedItems": [ "item-id-7" ],
  "finalBudgetUsd": 58.50,
  "decidedBy": "seandonvaughan" // process.env.USER or dashboard principal
}
```

Cycle resumes with the approved item set. If rejected, cycle proceeds with only the within-budget items. If the entire request is rejected (no items approved), the cycle exits with `stage: FAILED` and reason "user rejected all scored items".

### 6.6 Stage 2: STAGE — sprint generation

`SprintGenerator` (`packages/core/src/autonomous/sprint-generator.ts`, ~150 lines):

```typescript
async generate(approvedItems: RankedItem[]): Promise<SprintPlan> {
  const currentVersion = await this.adapter.getLatestSprintVersion();
  const nextVersion = bumpVersion(
    currentVersion, 
    approvedItems.flatMap(i => i.suggestedTags),
    this.config.sprint?.versionBumpOverride
  );
  
  const prediction = SprintPredictor.predict({
    backlog: approvedItems.map(toBacklogItem),
    budget: this.config.budget.perCycleUsd,
    maxItems: this.config.limits.maxItemsPerSprint,
    history: await this.adapter.getSprintHistory(10),
  });
  
  const plan = SprintPlanner.plan({
    version: nextVersion,
    items: prediction.selected,
    budget: this.config.budget.perCycleUsd,
    teamSize: prediction.requiredTeamSize,
  });
  
  const sprintJsonPath = `.agentforge/sprints/v${nextVersion}.json`;
  await writeFile(sprintJsonPath, JSON.stringify(plan, null, 2));
  await this.adapter.createSprint(plan);
  
  return plan;
}
```

### 6.7 Version bumper rules

```typescript
// packages/core/src/autonomous/version-bumper.ts (~60 lines)

export function bumpVersion(
  current: string,
  itemTags: string[],
  override?: 'major' | 'minor' | 'patch',
): string {
  const { major, minor, patch } = parseSemver(current);
  const tier = override ?? determineTier(itemTags);
  
  switch (tier) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

function determineTier(tags: string[]): 'major' | 'minor' | 'patch' {
  const MAJOR_TAGS = new Set(['breaking', 'architecture', 'platform', 'major-ui', 'rewrite']);
  const MINOR_TAGS = new Set(['feature', 'capability', 'enhancement', 'new']);
  // Patch: fix, bug, security, patch, chore, docs, refactor
  
  if (tags.some(t => MAJOR_TAGS.has(t))) return 'major';
  if (tags.some(t => MINOR_TAGS.has(t))) return 'minor';
  if (tags.some(t => ['fix','bug','security','patch','chore','docs','refactor'].includes(t))) return 'patch';
  return 'minor'; // default for autonomous sprints (feature work)
}

function parseSemver(v: string): { major: number; minor: number; patch: number } {
  // Handle legacy 2-segment versions (e.g. "6.3" → "6.3.0")
  const parts = v.replace(/^v/, '').split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]! };
}
```

**Bump rules:**

| Sprint item tags | Bump |
|---|---|
| `breaking`, `architecture`, `platform`, `major-ui`, `rewrite` | **major** (v6.4.0 → v7.0.0) |
| `feature`, `capability`, `enhancement`, `new` | **minor** (v6.4.0 → v6.5.0) |
| `fix`, `bug`, `security`, `patch`, `chore`, `docs`, `refactor` | **patch** (v6.4.0 → v6.4.1) |
| None / unclear | **minor** (autonomous default) |
| Explicit override via `sprint.meta.versionBump` | As specified |

### 6.8 Stages 4–6

Stages `VERIFY`, `COMMIT`, and `REVIEW` are covered in section 8 (Real Execution Layer).

---

## 7. Phase Auto-Advance

### 7.1 The refactor: extract phase handlers

`packages/server/src/routes/v5/sprint-orchestration.ts` currently embeds all phase logic inside HTTP route handlers. The refactor extracts each phase handler into a plain async function in a new file.

**New file:** `packages/server/src/lib/phase-handlers.ts`

```typescript
import { nowIso } from '@agentforge/shared';
import type { AgentRuntime } from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { EventBus } from '@agentforge/shared';

export type PhaseName = 
  | 'audit' | 'plan' | 'assign' | 'execute' 
  | 'test' | 'review' | 'gate' | 'release' | 'learn';

export interface PhaseContext {
  sprintId: string;
  sprintVersion: string;
  adapter: WorkspaceAdapter;
  bus: EventBus;
  runtime: AgentRuntime;
  cycleId?: string;   // set when invoked from a cycle
}

export interface PhaseResult {
  phase: PhaseName;
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  costUsd: number;
  agentRuns: AgentRunSummary[];
  itemResults?: SprintItemResult[];   // only for execute phase
  error?: string;
}

export async function runAuditPhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runPlanPhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runAssignPhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runExecutePhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runTestPhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runReviewPhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runGatePhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runReleasePhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }
export async function runLearnPhase(ctx: PhaseContext): Promise<PhaseResult> { /* existing logic */ }

export const PHASE_HANDLERS: Record<PhaseName, (ctx: PhaseContext) => Promise<PhaseResult>> = {
  audit: runAuditPhase,
  plan: runPlanPhase,
  // ... etc.
};

export const PHASE_SEQUENCE: PhaseName[] = [
  'audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'
];

export function nextPhase(current: PhaseName): PhaseName | null {
  const idx = PHASE_SEQUENCE.indexOf(current);
  return idx === -1 || idx === PHASE_SEQUENCE.length - 1 ? null : PHASE_SEQUENCE[idx + 1]!;
}
```

**Patch to `sprint-orchestration.ts`:** Replace embedded handlers with thin wrappers:

```typescript
// Before (existing ~1055 lines):
fastify.post('/api/v5/sprints/:version/run-phase', async (req, reply) => {
  // 150 lines of phase logic mixed with HTTP concerns
});

// After:
fastify.post('/api/v5/sprints/:version/run-phase', async (req, reply) => {
  const ctx: PhaseContext = buildCtxFromRequest(req);
  const currentPhase = await getCurrentPhase(ctx.sprintId);
  const handler = PHASE_HANDLERS[currentPhase];
  const result = await handler(ctx);
  return reply.send(result);
});
```

### 7.2 Event publishing

Each phase handler publishes events at start and end. For the execute phase specifically, per-item events are also published.

```typescript
// Pseudocode for runAuditPhase (same pattern in every phase)
export async function runAuditPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = nowIso();
  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase: 'audit',
    cycleId: ctx.cycleId,
    startedAt,
  });
  
  try {
    // ... existing audit logic: run researcher agent, collect findings ...
    const result: PhaseResult = { /* ... */ };
    
    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      phase: 'audit',
      cycleId: ctx.cycleId,
      result,
      completedAt: nowIso(),
    });
    
    return result;
  } catch (err) {
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase: 'audit',
      cycleId: ctx.cycleId,
      error: err instanceof Error ? err.message : String(err),
      failedAt: nowIso(),
    });
    throw err;
  }
}
```

**New EventBus topics:**
- `sprint.phase.started` — phase transition begins
- `sprint.phase.completed` — phase finished successfully
- `sprint.phase.failed` — phase hit an unrecoverable error
- `sprint.phase.item.started` — individual item dispatched (execute phase only)
- `sprint.phase.item.completed` — individual item finished (execute phase only)

### 7.3 PhaseScheduler

```typescript
// packages/core/src/autonomous/phase-scheduler.ts (~250 lines)

export class PhaseScheduler {
  private currentPhase: PhaseName | null = null;
  private unsubscribers: (() => void)[] = [];
  private resolvePromise: ((result: SprintRunSummary) => void) | null = null;
  private rejectPromise: ((err: Error) => void) | null = null;
  private phaseResults: Map<PhaseName, PhaseResult> = new Map();

  constructor(
    private readonly ctx: PhaseContext,
    private readonly killSwitch: KillSwitch,
    private readonly logger: CycleLogger,
  ) {}

  /**
   * Run a sprint end-to-end, auto-advancing through all phases.
   * Resolves when LEARN phase completes; rejects if killed or failed.
   */
  async run(): Promise<SprintRunSummary> {
    return new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this.subscribe();
      void this.triggerPhase('audit');
    });
  }

  private subscribe(): void {
    const onCompleted = (event: PhaseCompletedEvent) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      
      this.phaseResults.set(event.phase, event.result);
      this.logger.logPhaseResult(event.phase, event.result);
      
      // Kill switch check between phases
      const trip = this.killSwitch.checkBetweenPhases({
        cumulativeCostUsd: this.getCostSoFar(),
        consecutiveFailures: this.getConsecutiveFailures(),
      });
      if (trip) return this.fail(new CycleKilledError(trip));
      
      // Execute-phase failure threshold check
      if (event.phase === 'execute' && this.exceedsFailureThreshold(event.result)) {
        return this.fail(new PhaseFailedError('execute', 'Exceeded maxExecutePhaseFailureRate'));
      }
      
      const next = nextPhase(event.phase);
      if (!next) return this.complete();
      
      void this.triggerPhase(next);
    };

    const onFailed = (event: PhaseFailedEvent) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      this.logger.logPhaseFailure(event.phase, event.error);
      this.fail(new PhaseFailedError(event.phase, event.error));
    };

    this.unsubscribers.push(
      this.ctx.bus.subscribe('sprint.phase.completed', onCompleted),
      this.ctx.bus.subscribe('sprint.phase.failed', onFailed),
    );
  }

  private async triggerPhase(phase: PhaseName): Promise<void> {
    this.currentPhase = phase;
    this.logger.logPhaseStart(phase);
    
    try {
      const handler = PHASE_HANDLERS[phase];
      await handler(this.ctx);
      // Handlers publish their own completion events
    } catch (err) {
      this.ctx.bus.publish('sprint.phase.failed', {
        sprintId: this.ctx.sprintId,
        phase,
        cycleId: this.ctx.cycleId,
        error: err instanceof Error ? err.message : String(err),
        failedAt: nowIso(),
      });
    }
  }
  
  // complete(), fail(), cleanup(), getCostSoFar(), etc.
}
```

### 7.4 Failure handling

**Single-agent phases** (audit, plan, review, gate, release, learn):
- Agent failure → phase failure → cycle failure.
- Retry is the agent's responsibility via `DeadEndTracker`, not the phase's.

**Execute phase** (parallel item dispatch):

| Condition | Phase result | Cycle continues? |
|---|---|---|
| All items completed | `completed` | Yes |
| Some items failed, majority (>50%) completed | `completed` with failures recorded | Yes (failed items become next cycle's proposals) |
| Majority (≥50%) failed | `failed` | No (kill switch treats as regression-like) |
| All items blocked | `blocked` | No (cycle exits, no PR) |

The 50% threshold is configurable via `autonomous.yaml` at `limits.maxExecutePhaseFailureRate`.

---

## 8. Real Execution Layer

### 8.1 `RealTestRunner`

```typescript
// packages/core/src/autonomous/exec/real-test-runner.ts (~200 lines)

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passRate: number;
  durationMs: number;
  failedTests: FailedTest[];
  newFailures: string[];   // compared against priorSnapshot
  rawOutputPath: string;
  exitCode: number;
}

export class RealTestRunner {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig['testing'],
    private readonly priorSnapshot: TestResult | null,
  ) {}

  async run(cycleId: string): Promise<TestResult> {
    const outputFile = path.join(this.cwd, '.agentforge/cycles', cycleId, 'test-results.json');
    await mkdir(path.dirname(outputFile), { recursive: true });

    const cmdParts = this.config.command.split(' ');
    const args = [
      ...cmdParts.slice(1),
      '--',
      '--reporter=json',
      '--outputFile', outputFile,
    ];
    const timeoutMs = this.config.timeoutMinutes * 60_000;

    let stdout = '', stderr = '', exitCode = 0;
    const startedAt = Date.now();

    try {
      const result = await execFileAsync(cmdParts[0]!, args, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      exitCode = err.code ?? 1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
      if (err.killed || err.signal === 'SIGTERM') {
        throw new TestRunTimeoutError(timeoutMs);
      }
    }

    // Save raw output for forensics
    const rawPath = path.join(path.dirname(outputFile), 'tests-raw.log');
    await writeFile(rawPath, stdout + '\n--- STDERR ---\n' + stderr);

    if (!existsSync(outputFile)) {
      throw new TestRunnerError(
        `vitest did not produce output file (exit ${exitCode}): ${stderr.slice(0, 500)}`
      );
    }

    return this.parseVitestJson(
      JSON.parse(await readFile(outputFile, 'utf8')),
      outputFile,
      startedAt,
      exitCode,
    );
  }

  async typeCheck(): Promise<TypeCheckResult> { /* npx tsc --noEmit */ }
  async build(): Promise<BuildResult> { /* npm run build */ }
  
  private parseVitestJson(raw: any, rawPath: string, startedAt: number, exitCode: number): TestResult {
    const passed = raw.numPassedTests ?? 0;
    const failed = raw.numFailedTests ?? 0;
    const skipped = raw.numPendingTests ?? 0;
    const total = passed + failed + skipped;
    
    const failedTests: FailedTest[] = [];
    for (const file of raw.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') {
          failedTests.push({
            file: file.name,
            suite: assertion.ancestorTitles?.join(' > ') ?? '',
            name: assertion.title,
            error: assertion.failureMessages?.[0] ?? '',
            snippet: (assertion.failureMessages?.[0] ?? '').slice(0, 500),
          });
        }
      }
    }
    
    const newFailures = this.priorSnapshot
      ? failedTests
          .filter(t => !this.priorSnapshot!.failedTests.some(p => p.file === t.file && p.name === t.name))
          .map(t => `${t.file}::${t.name}`)
      : [];
    
    return {
      passed, failed, skipped, total,
      passRate: total > 0 ? passed / total : 0,
      durationMs: Date.now() - startedAt,
      failedTests,
      newFailures,
      rawOutputPath: rawPath,
      exitCode,
    };
  }
}
```

**Why prior snapshot?** `newFailures` is the load-bearing signal for regression detection. A test that was failing before the cycle doesn't count as a regression caused by *this* cycle. Prior snapshot is captured at cycle start by running the same test command against the clean working tree. That's one extra ~5-minute test run per cycle, but it's the only way to honestly attribute breakage.

### 8.2 `GitOps` — the safety-critical module

```typescript
// packages/core/src/autonomous/exec/git-ops.ts (~300 lines)

export class GitOps {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig['git'],
    private readonly logger: CycleLogger,
  ) {}

  async verifyPreconditions(): Promise<void> {
    // 1. In a git repo
    const topLevel = (await this.git(['rev-parse', '--show-toplevel'])).stdout;
    if (!topLevel) throw new GitSafetyError('Not a git repository');

    // 2. Current branch is not the base branch
    const currentBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (this.config.refuseCommitToBaseBranch && currentBranch === this.config.baseBranch) {
      throw new GitSafetyError(
        `REFUSED: cycle would operate on base branch '${this.config.baseBranch}'.`
      );
    }

    // 3. Working tree is clean (except whitelisted paths)
    const dirty = await this.getDirtyFiles();
    const unexpected = dirty.filter(f => !this.isWhitelisted(f));
    if (unexpected.length > 0) {
      throw new GitSafetyError(
        `REFUSED: unexpected modified files:\n${unexpected.join('\n')}`
      );
    }

    // 4. gh CLI is authenticated
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    } catch {
      throw new GitSafetyError('gh CLI is not authenticated. Run `gh auth login` first.');
    }

    // 5. Base branch is up to date with origin
    await this.git(['fetch', 'origin', this.config.baseBranch]);
    const baseHead = (await this.git(['rev-parse', `origin/${this.config.baseBranch}`])).stdout.trim();
    const localBaseHead = (await this.git(['rev-parse', this.config.baseBranch])).stdout.trim();
    if (baseHead !== localBaseHead) {
      throw new GitSafetyError(
        `REFUSED: local ${this.config.baseBranch} is out of sync with origin.`
      );
    }
  }

  async createBranch(version: string, suffix: string = ''): Promise<string> {
    const branch = `${this.config.branchPrefix}v${version}${suffix}`;
    if (await this.branchExists(branch)) {
      throw new GitSafetyError(
        `REFUSED: branch ${branch} already exists — previous cycle may be uncleaned`
      );
    }
    await this.git(['checkout', '-b', branch, this.config.baseBranch]);
    this.logger.logGitEvent({ type: 'branch-created', branch });
    return branch;
  }

  async stage(files: string[]): Promise<void> {
    if (files.length === 0) throw new GitSafetyError('No files to stage');
    if (files.length > this.config.maxFilesPerCommit) {
      throw new GitSafetyError(
        `REFUSED: ${files.length} files exceeds maxFilesPerCommit (${this.config.maxFilesPerCommit}).`
      );
    }
    
    for (const file of files) {
      if (file.includes('..') || file.startsWith('/')) {
        throw new GitSafetyError(`REFUSED: suspicious path: ${file}`);
      }
      const resolved = path.resolve(this.cwd, file);
      if (!resolved.startsWith(path.resolve(this.cwd))) {
        throw new GitSafetyError(`REFUSED: path outside repo: ${file}`);
      }
      if (DANGEROUS_PATHS.some(p => file.match(p))) {
        throw new GitSafetyError(`REFUSED: dangerous pattern: ${file}`);
      }
    }

    // Explicit `--` separator, never `-A` or `.`
    await this.git(['add', '--', ...files]);

    const staged = (await this.git(['diff', '--cached', '--name-only'])).stdout.split('\n').filter(Boolean);
    this.logger.logGitEvent({ type: 'staged', files: staged });
  }

  async scanStagedForSecrets(): Promise<void> {
    const diff = (await this.git(['diff', '--cached'])).stdout;
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(diff)) {
        throw new GitSafetyError(`REFUSED: secret pattern matched: ${pat}`);
      }
    }
  }

  async commit(message: string): Promise<string> {
    // Use -F - (read from stdin) to avoid shell escaping
    await execFileAsync('git', ['commit', '-F', '-'], {
      cwd: this.cwd,
      input: message,
      timeout: 120_000,
    });
    
    const sha = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    
    // Verify we're still on the feature branch (catches hook weirdness)
    const currentBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (currentBranch === this.config.baseBranch) {
      throw new GitSafetyError(`POST-COMMIT PANIC: landed on ${this.config.baseBranch}`);
    }
    
    this.logger.logGitEvent({ type: 'committed', sha, message });
    return sha;
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', '-u', 'origin', branch]);
    this.logger.logGitEvent({ type: 'pushed', branch });
  }

  async rollbackCommit(branch: string, sha: string): Promise<void> {
    const current = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (current !== branch) {
      throw new GitSafetyError(`Cannot rollback: not on branch ${branch}`);
    }
    await this.git(['reset', '--hard', `${sha}~1`]);
    this.logger.logGitEvent({ type: 'rolled-back', branch, fromSha: sha });
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    // Always execFile, never exec — no shell interpretation
    return execFileAsync('git', args, { cwd: this.cwd, maxBuffer: 50 * 1024 * 1024 });
  }
}

const DANGEROUS_PATHS = [
  /^\.env$/,
  /^\.env\./,
  /credentials\.json$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /\.secret$/,
];

const SECRET_PATTERNS = [
  /ANTHROPIC_API_KEY\s*=\s*['"]?sk-ant-/,
  /OPENAI_API_KEY\s*=\s*['"]?sk-/,
  /ghp_[a-zA-Z0-9]{36}/,               // GitHub PAT
  /AKIA[0-9A-Z]{16}/,                  // AWS access key
  /aws_secret_access_key/i,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];
```

**Ten safety guarantees encoded in `GitOps`:**

1. Never runs in a non-git directory.
2. Never commits if there are no changes.
3. Never commits directly to `main` (or configured `baseBranch`).
4. Never uses `git add -A` or `git add .` — only explicit paths.
5. Refuses paths that escape the repo root (traversal prevention).
6. Refuses paths matching dangerous patterns (`.env`, `.pem`, `id_rsa`, etc.).
7. Scans staged diff for common secret patterns before committing.
8. Verifies post-commit that we're still on the feature branch (catches git hooks moving HEAD).
9. Uses `git commit -F -` (stdin) for commit messages — no shell interpolation.
10. All subprocess calls use `execFile`, never `exec` — no shell parsing.

### 8.3 `PROpener`

```typescript
// packages/core/src/autonomous/exec/pr-opener.ts (~200 lines)

export interface PROpenRequest {
  branch: string;
  baseBranch: string;
  title: string;         // < 70 chars
  body: string;          // full markdown
  draft: boolean;
  labels: string[];
  reviewers?: string[];
  dryRun?: boolean;      // test-only flag
}

export class PROpener {
  constructor(private readonly cwd: string) {}

  async open(req: PROpenRequest): Promise<PROpenResult> {
    if (req.dryRun) {
      return {
        url: `https://github.com/dry-run/autonomous-test/pull/1`,
        number: 1,
        draft: req.draft,
      };
    }
    
    await this.requireGhInstalled();
    await this.requireGhAuthed();

    const args = [
      'pr', 'create',
      '--title', req.title,
      '--body-file', '-',           // body via stdin
      '--base', req.baseBranch,
      '--head', req.branch,
    ];
    if (req.draft) args.push('--draft');
    for (const label of req.labels) args.push('--label', label);
    for (const reviewer of req.reviewers ?? []) args.push('--reviewer', reviewer);

    const result = await execFileAsync('gh', args, {
      cwd: this.cwd,
      input: req.body,
      timeout: 60_000,
    });
    
    const url = result.stdout.trim().split('\n').pop() ?? '';
    const number = this.parsePrNumber(url);
    
    return { url, number, draft: req.draft };
  }
}
```

### 8.4 `KillSwitch`

```typescript
// packages/core/src/autonomous/kill-switch.ts (~250 lines)

export type KillReason = 
  | 'budget' | 'duration' | 'regression' | 'testFloor'
  | 'buildFailure' | 'typeCheckFailure'
  | 'consecutiveFailures' | 'manualStop' | 'manualStopFile';

export interface KillSwitchTrip {
  reason: KillReason;
  detail: string;
  triggeredAt: string;
  stageAtTrip: CycleStage;
}

export class KillSwitch {
  private tripped: KillSwitchTrip | null = null;
  private readonly stopFilePath: string;

  constructor(
    private readonly config: CycleConfig,
    private readonly cycleId: string,
    private readonly cycleStartedAt: number,
    private readonly cwd: string,
  ) {
    this.stopFilePath = path.join(cwd, '.agentforge/cycles', cycleId, 'STOP');
    this.installSignalHandlers();
  }

  checkBetweenPhases(state: {
    cumulativeCostUsd: number;
    consecutiveFailures: number;
  }): KillSwitchTrip | null {
    if (this.tripped) return this.tripped;

    if (existsSync(this.stopFilePath)) {
      return this.trip('manualStopFile', `STOP file at ${this.stopFilePath}`, 'run');
    }
    
    if (state.cumulativeCostUsd >= this.config.budget.perCycleUsd) {
      return this.trip('budget', 
        `Cumulative cost $${state.cumulativeCostUsd.toFixed(2)} exceeds limit $${this.config.budget.perCycleUsd}`,
        'run');
    }
    
    const elapsedMin = (Date.now() - this.cycleStartedAt) / 60000;
    if (elapsedMin >= this.config.limits.maxDurationMinutes) {
      return this.trip('duration',
        `Duration ${elapsedMin.toFixed(1)}m exceeds limit ${this.config.limits.maxDurationMinutes}m`,
        'run');
    }
    
    if (state.consecutiveFailures >= this.config.limits.maxConsecutiveFailures) {
      return this.trip('consecutiveFailures',
        `${state.consecutiveFailures} consecutive failures`,
        'run');
    }
    
    return null;
  }

  checkPostVerify(testResult: TestResult, regression: RegressionResult): KillSwitchTrip | null {
    if (this.tripped) return this.tripped;
    
    if (testResult.passRate < this.config.quality.testPassRateFloor) {
      return this.trip('testFloor',
        `Pass rate ${(testResult.passRate * 100).toFixed(1)}% below floor ${(this.config.quality.testPassRateFloor * 100).toFixed(1)}%`,
        'verify');
    }
    
    if (regression.detected && !this.config.quality.allowRegression) {
      return this.trip('regression', regression.reason, 'verify');
    }
    
    return null;
  }

  trip(reason: KillReason, detail: string, stage: CycleStage): KillSwitchTrip {
    if (this.tripped) return this.tripped;
    this.tripped = {
      reason,
      detail,
      triggeredAt: nowIso(),
      stageAtTrip: stage,
    };
    return this.tripped;
  }

  isTripped(): boolean { return this.tripped !== null; }
  getTrip(): KillSwitchTrip | null { return this.tripped; }

  private installSignalHandlers(): void {
    const handler = (sig: string) => {
      this.trip('manualStop', `Received ${sig}`, 'run');
    };
    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
  }
}
```

**Kill switch check points:**

| Check point | Who checks | What can trip |
|---|---|---|
| Between phases | `PhaseScheduler.onCompleted` | budget, duration, consecutiveFailures, manualStopFile |
| After scoring | `CycleRunner.runStage1` | budget (scoring itself) |
| After real tests | `CycleRunner.runStage4` | testFloor, regression, buildFailure, typeCheckFailure |
| Before push | `CycleRunner.runStage5` | manualStop, final budget sanity |
| SIGINT / SIGTERM | Signal handlers (always-on) | manualStop |
| STOP file | All phase checks | manualStopFile |

Once tripped, the trip is sticky: every subsequent check returns the same trip. `CycleRunner.start()` catches `CycleKilledError` in a top-level try/finally and:

1. Writes final `cycle.json` with `stage: KILLED` and trip reason
2. Preserves working-tree state for inspection (no cleanup)
3. Logs full trip context
4. CLI exits with code 2

---

## 9. Configuration (`.agentforge/autonomous.yaml`)

```yaml
# .agentforge/autonomous.yaml
# AgentForge autonomous cycle configuration
# See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md

budget:
  perCycleUsd: 50             # hard ceiling per cycle
  perItemUsd: 10              # single sprint item
  perAgentUsd: 15             # single agent across a cycle
  allowOverageApproval: true  # prompt for approval on overrun

limits:
  maxItemsPerSprint: 20       # scoring agent cannot exceed this
  maxDurationMinutes: 180     # 3 hours wall clock
  maxConsecutiveFailures: 5   # item-level failures before trip
  maxExecutePhaseFailureRate: 0.5  # > 50% item failures = phase failed

quality:
  testPassRateFloor: 0.95     # < 95% → kill
  allowRegression: false      # never ship a regression
  requireBuildSuccess: true   # `npm run build` must pass
  requireTypeCheckSuccess: true  # `npx tsc --noEmit` must pass

git:
  branchPrefix: "autonomous/"
  baseBranch: "main"
  refuseCommitToBaseBranch: true      # HARD SAFETY
  includeDiagnosticBranchOnFailure: true  # keep commits on *-failed branches
  maxFilesPerCommit: 100              # anomaly cap

pr:
  draft: false
  assignReviewer: "seandonvaughan"    # auto-assign
  labelPrefix: "autonomous"
  labels: ["autonomous", "needs-review"]
  titleTemplate: "autonomous(v{version}): {summary}"

sourcing:
  lookbackDays: 7
  minProposalConfidence: 0.6
  includeTodoMarkers: true
  todoMarkerPattern: "TODO\\(autonomous\\)|FIXME\\(autonomous\\)"

testing:
  command: "npm run test:run"
  timeoutMinutes: 20
  reporter: "json"
  saveRawLog: true
  buildCommand: "npm run build"
  typeCheckCommand: "npx tsc --noEmit"

scoring:
  agentId: "backlog-scorer"
  maxRetries: 3
  fallbackToStatic: true

logging:
  logDir: ".agentforge/cycles"
  retainCycles: 50

safety:
  stopFilePath: ".agentforge/cycles/{cycleId}/STOP"
  secretScanEnabled: true
  verifyCleanWorkingTreeBeforeStart: true
  workingTreeWhitelist:
    - ".agentforge/cycles/**"
    - ".agentforge/audit.db-*"
```

**`ConfigLoader`** (~80 lines) parses this with a zod schema, merges over sane defaults, and returns a frozen `CycleConfig`. Missing file → uses all defaults with a warning. Malformed file → hard error (never silently fall back to defaults when the user clearly tried to configure something).

---

## 10. Logging (`.agentforge/cycles/{cycleId}/`)

Every cycle produces a self-contained directory of structured logs. No new DB tables.

```
.agentforge/cycles/
└── {cycleId}/                      # UUID
    ├── cycle.json                  # terminal CycleResult
    ├── scoring.json                # full ScoringResult + grounding context
    ├── approval-pending.json       # if budget overrun occurred
    ├── approval-decision.json      # if budget overrun occurred
    ├── phases/
    │   ├── audit.json              # phase result + agent response (truncated)
    │   ├── plan.json
    │   ├── assign.json
    │   ├── execute.json            # with per-item detail
    │   ├── test.json
    │   ├── review.json
    │   ├── gate.json
    │   ├── release.json
    │   └── learn.json
    ├── tests.json                  # parsed TestResult
    ├── test-results.json           # raw vitest JSON output
    ├── tests-raw.log               # raw stdout+stderr
    ├── git.json                    # branch, sha, files, commit message
    ├── pr.json                     # PR URL, number, body
    ├── events.jsonl                # append-only full event stream
    └── STOP                        # (optional) user-created file to abort cycle
```

`CycleLogger` (~120 lines) has one method per log type: `logPhaseResult()`, `logTestRun()`, `logGitEvent()`, `logPREvent()`, `logEvent()` (for `events.jsonl`), `logCycleResult()`. Each method is a plain file write — no buffering, no async queues. When something goes wrong, the log is always on disk.

**Retention:** `logging.retainCycles: 50` means the 50 most recent cycle directories are kept. Older ones are purged at cycle start by `CycleLogger.prune()` — a simple sort-by-mtime + unlink loop.

---

## 11. Testing Strategy

### 11.1 Test targets

- **Unit tests:** ~60 (all modules, all safety guards, all fallback paths)
- **Integration tests:** ~12 (real subprocess against tmp dirs, mocked Anthropic)
- **E2E smoke test:** ~3 (full cycle + kill switch trip + budget overrun)
- **Total new tests:** ~75 → brings baseline from 3,948 to ~4,020+

### 11.2 Mocking strategy

| Dependency | Strategy | Why |
|---|---|---|
| Anthropic API | Mock `AgentRuntime.run()` / `runStreaming()` with canned responses | Deterministic, free, fast |
| Git | **Real** git against `os.tmpdir()/{uuid}` repos | Mocks lie; real git is fast |
| `gh` CLI | Mock `execFile` for gh, verify args | No good way to stand up a fake GitHub |
| vitest subprocess | Unit: mock `execFile`. Integration: one real run against fixture project | Balance of realism and speed |
| Filesystem | Real FS in `os.tmpdir()/{uuid}`, cleanup in `afterEach` | Easy and accurate |
| SQLite | `better-sqlite3(':memory:')` per test | Already how v6 tests work |
| EventBus | Real in-memory bus | Already deterministic |
| Signal handlers | Direct invocation of handler functions | Cannot send real SIGINT in tests |
| Time | `vi.useFakeTimers()` where elapsed ms matters | vitest built-in |
| TTY detection | Stub `process.stdin.isTTY` and readline prompt | Test both interactive and non-interactive |

### 11.3 Safety-guard tests (the non-negotiable ones)

These are the tests that would fail the moment a future refactor silently deletes a safety check:

```typescript
// tests/autonomous/unit/exec/git-ops.test.ts
describe('GitOps safety guards', () => {
  it('refuses to commit when current branch is baseBranch', async () => { /* ... */ });
  it('refuses to stage files outside the repo', async () => { /* ... */ });
  it('refuses to commit when staged diff contains ANTHROPIC_API_KEY', async () => { /* ... */ });
  it('refuses to commit when staged diff contains GitHub PAT', async () => { /* ... */ });
  it('refuses to commit when staged diff contains AWS access key', async () => { /* ... */ });
  it('refuses to commit when staged diff contains private key', async () => { /* ... */ });
  it('never invokes `git add -A` or `git add .`', async () => { /* ... */ });
  it('rollbackCommit resets to pre-commit state', async () => { /* ... */ });
  it('refuses when branch already exists', async () => { /* ... */ });
  it('refuses dangerous paths (.env, .pem, id_rsa)', async () => { /* ... */ });
});

// tests/autonomous/unit/kill-switch.test.ts
describe('KillSwitch trip reasons', () => {
  it('trips on budget overrun', async () => { /* ... */ });
  it('trips on duration overrun', async () => { /* ... */ });
  it('trips on testFloor violation', async () => { /* ... */ });
  it('trips on regression detected', async () => { /* ... */ });
  it('trip is sticky — subsequent checks return same trip', async () => { /* ... */ });
  it('trips on SIGINT', async () => { /* ... */ });
  it('trips on STOP file creation', async () => { /* ... */ });
  // plus all other reasons
});
```

### 11.4 TDD implementation order

Each step has its tests written first, failing, then implemented:

1. `types.ts` — no tests (pure type definitions)
2. `version-bumper.ts` + test (pure function, table-driven)
3. `config-loader.ts` + test (yaml parse, defaults, zod validation)
4. `kill-switch.ts` + test (every trip condition)
5. `pr-body-renderer.ts` + test (snapshot-based)
6. `cycle-logger.ts` + test (file writes, dir structure)
7. `proposal-to-backlog.ts` + test (mocked adapter)
8. `scoring-pipeline.ts` + test (mocked runtime, schema validation, retry/fallback)
9. `sprint-generator.ts` + test (happy path, budget overflow)
10. `git-ops.ts` + unit tests + integration test (real git)
11. `real-test-runner.ts` + unit tests + integration test (real vitest)
12. `pr-opener.ts` + test (mocked execFile, dry-run wiring)
13. `budget-approval.ts` + test (TTY vs file mode)
14. **Regression suite** for existing sprint-orchestration HTTP routes
15. Extract `phase-handlers.ts` from `sprint-orchestration.ts`
16. Verify HTTP regression tests pass unchanged
17. Add direct-call tests for phase-handlers
18. Add event publishing to handlers
19. `phase-scheduler.ts` + test (event flow, kill switch between phases)
20. `cycle-runner.ts` + test (stage machine, error paths)
21. E2E: `full-cycle.test.ts` — mocked Anthropic, real git, dry-run PR
22. CLI: `packages/cli/src/commands/autonomous.ts` + manual smoke test

### 11.5 Coverage targets

| Module class | Branch coverage | Rationale |
|---|---|---|
| Safety (`git-ops`, `kill-switch`) | 95%+ | Catastrophic if broken |
| Orchestration (`cycle-runner`, `phase-scheduler`) | 85%+ | Main execution path |
| Data (`proposal-to-backlog`, `scoring-pipeline`) | 80%+ | Easier to test with mocks |
| Pure helpers (`pr-body-renderer`, `version-bumper`) | 90%+ | Should be trivial |
| Subprocess wrappers (`real-test-runner`, `pr-opener`) | 75%+ | Error marshalling lines |

### 11.6 Manual smoke test (after unit+integration tests pass)

Procedure for proving end-to-end behavior against the real repo before declaring done:

1. `git checkout -b smoke-test/autonomous-v1`
2. Write a temporary `.agentforge/autonomous.yaml` with `budget.perCycleUsd: 5` (cheap smoke)
3. Add one `TODO(autonomous): add a comment to README.md explaining the autonomous loop` marker
4. Run `npm run autonomous:cycle`
5. Observe:
   - Scoring agent runs and returns valid JSON
   - Sprint v6.4.0 JSON generated
   - Phase scheduler runs audit → ... → learn
   - Real vitest runs and passes
   - Git branch `autonomous/v6.4.0` created
   - Commit created, pushed
   - PR opened with rendered body
6. Verify `.agentforge/cycles/{cycleId}/` contains expected logs
7. Manually review the PR (should be a trivial README comment addition)
8. Clean up: delete branch, close PR, remove smoke config

If this passes, the feature ships.

---

## 12. File Inventory

### 12.1 New source files (15)

| Path | Purpose | LOC estimate |
|---|---|---|
| `packages/core/src/autonomous/types.ts` | Type definitions | 150 |
| `packages/core/src/autonomous/config-loader.ts` | Parse autonomous.yaml | 80 |
| `packages/core/src/autonomous/version-bumper.ts` | Semver with tag rules | 60 |
| `packages/core/src/autonomous/kill-switch.ts` | Safety monitors | 250 |
| `packages/core/src/autonomous/cycle-logger.ts` | Structured logs | 120 |
| `packages/core/src/autonomous/pr-body-renderer.ts` | Markdown template | 100 |
| `packages/core/src/autonomous/proposal-to-backlog.ts` | Bridge module | 180 |
| `packages/core/src/autonomous/scoring-pipeline.ts` | Agent-driven scoring | 220 |
| `packages/core/src/autonomous/budget-approval.ts` | Overrun gate | 150 |
| `packages/core/src/autonomous/sprint-generator.ts` | Predictor+Planner wiring | 150 |
| `packages/core/src/autonomous/phase-scheduler.ts` | Event-driven advance | 250 |
| `packages/core/src/autonomous/cycle-runner.ts` | Top-level orchestrator | 300 |
| `packages/core/src/autonomous/exec/real-test-runner.ts` | Shell vitest | 200 |
| `packages/core/src/autonomous/exec/git-ops.ts` | Real git ops | 300 |
| `packages/core/src/autonomous/exec/pr-opener.ts` | gh pr create | 200 |
| `packages/core/src/autonomous/index.ts` | Barrel | 20 |
| `packages/cli/src/commands/autonomous.ts` | CLI entry | 80 |
| `packages/server/src/lib/phase-handlers.ts` | Extracted phase logic | 600 (moved) |

**Approximate total: ~2,000 LOC** (not counting moved code in phase-handlers.ts, which is extraction only)

### 12.2 Modified files (2)

| Path | Change |
|---|---|
| `packages/server/src/routes/v5/sprint-orchestration.ts` | Replace embedded handlers with thin wrappers calling phase-handlers.ts; add event publishing |
| `package.json` | Add `"autonomous:cycle": "npm run build && node packages/cli/dist/commands/autonomous.js"` script |

### 12.3 New agent YAML (1)

| Path | Purpose |
|---|---|
| `.agentforge/agents/backlog-scorer.yaml` | Sonnet-tier scoring agent |

### 12.4 New config (1)

| Path | Purpose |
|---|---|
| `.agentforge/autonomous.yaml` | Cycle configuration |

### 12.5 New test files (~20)

See section 5.2 module map. ~75 new tests total.

---

## 13. Implementation Phases

The work is organized into 6 phases following the TDD order in section 11.4. Each phase is independently reviewable and has its own acceptance criteria.

### Phase 1: Pure logic (no external deps)
- **Files:** types.ts, version-bumper.ts, config-loader.ts, cycle-logger.ts, pr-body-renderer.ts
- **Tests:** ~25 unit tests
- **Acceptance:** All modules pass tests; no external dependencies used.

### Phase 2: Safety and data modules
- **Files:** kill-switch.ts, proposal-to-backlog.ts, sprint-generator.ts
- **Tests:** ~25 unit tests with mocked adapters
- **Acceptance:** Every kill reason has a test; proposal bridge handles empty backlog, filtered backlog, and confidence thresholds.

### Phase 3: Subprocess wrappers
- **Files:** real-test-runner.ts, git-ops.ts, pr-opener.ts
- **Tests:** ~30 unit tests + ~6 integration tests (real git, real vitest)
- **Acceptance:** Every safety guard in git-ops has a negative test; real-test-runner parses a real vitest report; pr-opener has dry-run mode.

### Phase 4: Phase handler extraction (refactor)
- **Files:** phase-handlers.ts (NEW), sprint-orchestration.ts (PATCH)
- **Tests:** Regression suite for existing HTTP routes + new direct-call tests
- **Acceptance:** All v6.3 HTTP route tests pass unchanged; direct function calls produce identical results; new events published at start/end of each phase.

### Phase 5: Autonomous orchestration
- **Files:** scoring-pipeline.ts, budget-approval.ts, phase-scheduler.ts, cycle-runner.ts
- **Tests:** ~20 unit tests with mocked runtime + EventBus
- **Acceptance:** Scoring pipeline handles all 3 fallback strikes; budget approval works in both TTY and file modes; phase scheduler auto-advances through all 9 phases in a test fixture; cycle-runner drives all 6 stages.

### Phase 6: Integration + E2E + CLI
- **Files:** full-cycle.test.ts, autonomous.ts (CLI), `.agentforge/autonomous.yaml`, `.agentforge/agents/backlog-scorer.yaml`
- **Tests:** ~3 integration + 1 E2E smoke test
- **Acceptance:** Full cycle runs end-to-end against a tmp workspace with mocked Anthropic, real git, and dry-run PR; produces a valid `cycle.json`; CLI exits 0 on success, 2 on kill switch; manual smoke test against the real repo succeeds.

---

## 14. Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Agent writes a commit that breaks main | Low | Never commit directly to main (`refuseCommitToBaseBranch: true`); always feature branch; human reviews PR |
| Scoring agent returns malformed JSON | Medium | 3-strike fallback ladder; static ranking as final fallback |
| Secret leaks in committed code | Low | Secret scan patterns before commit; `execFile` never runs shell |
| Budget runaway | Low | KillSwitch checks cost between every phase; single phase overshoot bounded to ~$3-8 |
| Regression test slips through | Low | `newFailures` comparison against prior snapshot; `allowRegression: false` by default |
| vitest timeout mid-run | Medium | 20-minute default timeout; partial results captured if possible |
| Git hook moves HEAD unexpectedly | Low | Post-commit branch verification; rollback available |
| `gh pr create` fails after commit+push | Medium | Cycle exits with commit+push preserved; user can manually open PR; no data loss |
| Scoring agent itself burns budget | Medium | Scoring is counted against cycle budget; KillSwitch checks after scoring |
| Phase scheduler stuck on missed event | Low | Per-phase timeout; can be added in a follow-up if needed |
| Concurrent cycles race on sprint JSON | N/A | Only one cycle at a time in MVP (single-process CLI) |
| Recovery from partial failure | Medium | Every stage writes to `cycle.json` immediately; next cycle can read state; failed cycles leave diagnostic branches |

---

## 15. Future Work (Explicitly Deferred)

These items are intentionally excluded from this spec and are expected to be delivered by AgentForge itself in the first autonomous cycle (v6.4.0) or later:

1. **Persistent daemon** — `packages/core/src/autonomous/daemon.ts`: a long-running process that loops cycles continuously with configurable sleep intervals. ~20 lines wrapping `CycleRunner.start()` in a loop.

2. **Durable state for in-memory stores** — Replace `Map<>` in `SelfProposalEngine`, `SprintPlanner`, `DeadEndTracker`, `CanaryManager`, `GitBranchManager`, `EscalationProtocol` with SQLite-backed repositories via new adapter methods.

3. **Work queue for scale** — BullMQ or a simple DB-backed job table; worker pool for parallel agent dispatch.

4. **Horizontal scale** — Move `WorkspaceAdapter` from SQLite to a Postgres-compatible interface; run multiple Fastify instances behind a load balancer.

5. **Multi-workspace cycles** — Coordinate cycles across multiple `.agentforge/` workspaces simultaneously.

6. **Cross-cycle learning transfer** — Feed one cycle's retrospective into the next cycle's scoring grounding (beyond what `SelfProposalEngine` already reads from sessions).

7. **Automatic PR merging** — Once confidence in the loop is high, add opt-in auto-merge when all checks pass and kill switch is clean.

8. **Real-time dashboard integration** — Live cycle visualization in the dashboard with per-phase progress, cost burn-down, and kill-switch status.

9. **Hiring trigger at cycle start** — Check team utilization and trigger `TeamScaler` before planning; hired agents join the cycle.

10. **Phase-level cooperative cancellation** — `AbortController` threaded through `AgentRuntime` for mid-phase kill switch preemption.

11. **Baseline test snapshot caching** — Avoid re-running all tests for prior snapshot on every cycle; cache last known-good state.

12. **Cycle replay** — Reconstruct and re-execute a past cycle from its `events.jsonl` for debugging.

Each of these deferred items is a clean sprint-sized unit of work. The first autonomous cycle can pick 2-3 of these as its sprint items.

---

## 16. Appendix A — `backlog-scorer` agent YAML

```yaml
# .agentforge/agents/backlog-scorer.yaml
id: backlog-scorer
name: Backlog Scorer
model: sonnet
seniority: senior
team: strategy
layer: planning

system: |
  You are the Backlog Scorer for AgentForge's autonomous development loop.
  Your job is to take a set of candidate work items (proposals from session
  failures, cost anomalies, test flakiness, and TODO(autonomous) markers) and
  rank them into an executable sprint, flagging items that would push the
  cycle over budget for human approval.
  
  You will receive:
  - candidateItems: array of proposed work items with type, title, description, tags
  - historyContext: recent sprint history, cost medians per item type, team state
  - budgetUsd: the hard budget for this cycle
  - maxItems: the cap on items per sprint
  
  You must produce:
  - rankings: ordered list of items with rank, score, confidence, estimatedCostUsd, 
              rationale, dependencies, suggestedAssignee, suggestedTags, withinBudget
  - totalEstimatedCostUsd: sum of estimates
  - budgetOverflowUsd: amount over budget (0 if within)
  - summary: one-paragraph rationale
  - warnings: array of flags (e.g., dependencies, risks)
  
  Ranking principles:
  1. Impact: prefer items that resolve the most recent failures
  2. Cost: use historical medians; conservative estimates
  3. Dependencies: items that unblock others rank higher
  4. Risk: balance novelty against regression risk
  5. Team fit: suggest the agent with the right skills
  
  Output MUST be valid JSON matching the ScoringResult schema.
  Do not include any text outside the JSON object.

skills:
  - proposal-analysis
  - cost-estimation
  - dependency-detection
  - budget-planning

output_format: structured_json

tools:
  - WorkspaceAdapter.getSprintHistory
  - WorkspaceAdapter.getCostMedians
  - WorkspaceAdapter.getTeamState
```

---

## 17. Appendix B — Acceptance criteria (success definition)

This spec is considered successfully implemented when **all** of the following are true:

### Functional
- [ ] `npm run autonomous:cycle` executes end-to-end and opens a real PR on a throwaway smoke test
- [ ] PR is assigned to `seandonvaughan` as reviewer and labeled `autonomous` + `needs-review`
- [ ] PR body contains scoring rationale, test results, cost breakdown, and file list
- [ ] `.agentforge/cycles/{cycleId}/` contains all expected structured logs
- [ ] Kill switch trips correctly on: budget overrun, test failure, regression, SIGINT, STOP file
- [ ] Cycle respects `autonomous.yaml` configuration (budget, limits, quality gates)
- [ ] Version bumper produces correct semver for each tag combination
- [ ] Scoring agent fallback ladder works when schema validation fails

### Quality
- [ ] ~75 new tests passing, bringing total to ~4,020+
- [ ] All safety-guard tests in `git-ops.test.ts` and `kill-switch.test.ts` passing
- [ ] `phase-handlers-http.test.ts` regression suite passing (no v6.3 breakage)
- [ ] `phase-handlers-direct.test.ts` parity tests passing
- [ ] `full-cycle.test.ts` E2E smoke passing
- [ ] `npm run build` passes with 0 TypeScript errors
- [ ] Coverage targets met per section 11.5

### Safety
- [ ] `GitOps` cannot commit to `main` in any code path
- [ ] `GitOps` cannot stage `.env`, `.pem`, or private key files
- [ ] `GitOps` never invokes `git add -A` or `git add .`
- [ ] `PROpener` refuses to run without gh CLI auth
- [ ] `KillSwitch` is sticky and cannot be un-tripped within a cycle
- [ ] Secrets scan catches ANTHROPIC_API_KEY, GitHub PAT, AWS access key, private keys

### Observability
- [ ] Every cycle decision is logged to `.agentforge/cycles/{cycleId}/`
- [ ] `events.jsonl` provides a replayable event stream for post-mortems
- [ ] `cycle.json` includes terminal stage, cost, tests, git, PR, and kill switch context
- [ ] CLI exits with distinct codes: 0 (success), 1 (error), 2 (kill switch)

---

## 18. Decision Log

All decisions were captured during the design session on 2026-04-06 with user `seandonvaughan`:

| # | Decision | Rationale |
|---|---|---|
| 1 | Supervised loop (PR-based) | First-cycle safety; human reviews and merges |
| 2 | Self-proposals from metrics | Closest to true autonomy; system notices its own pain |
| 3 | `.agentforge/autonomous.yaml`, $50 cap, generous defaults | Flexibility + conservative initial budget |
| 4 | Full semver with tag rules | `v6.4.0 → v6.5.0` minor, `v6.4.0 → v6.4.1` patch, `v6.4.0 → v7.0.0` major |
| 5 | Dynamic agent-driven scoring | Hardcoded ranking is too brittle; agent can refine over time |
| 6 | Budget overrun approval | User approves overages explicitly; no silent overspend |
| 7 | Everything logged | Auditable by default for trust |
| 8 | Single-process CLI for MVP, daemon deferred | Bootstrap paradox; daemon is first autonomous sprint's work |
| 9 | No new DB tables | Filesystem logs are more debuggable and sufficient |
| 10 | EventBus for phase advance | Observable, decoupled, scales to daemon later |
| 11 | Refactor phase handlers into plain functions | Unified callable surface for HTTP + events + tests |
| 12 | Execute-phase failure threshold 50% | Balanced: tolerates a few failures, kills on majority |
| 13 | Diagnostic branch on test failure | Easier post-mortem than dirty working tree |
| 14 | Secret scan patterns: ANTHROPIC, OpenAI, GitHub PAT, AWS, private keys | Covers the most common leakage vectors |
| 15 | Auto-assign `seandonvaughan` as reviewer | User is the sole approver for autonomous PRs |
| 16 | 3-strike fallback to static ranking | Cycle continues even if scoring agent degrades |

---

## End of spec
