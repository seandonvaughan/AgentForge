# AgentForge Autonomous Development Loop: Architecture Guide

**Version:** v6.4.0+  
**Last updated:** 2026-04-07  
**Audience:** Core developers, platform architects, anyone building on the autonomous loop

---

## Overview

The autonomous development loop is the system that enables AgentForge to plan its own work, execute improvements, verify them with real tests, commit code, and open pull requests for human review—all without manual intervention between steps.

This guide describes the **end-to-end architecture** of the autonomous loop: how work flows from discovery through review, what guardrails prevent runaway costs, where decisions are made and logged, and how developers can extend or maintain the system.

**Key premise:** One invocation of `npm run autonomous:cycle` (or equivalent CLI call) runs exactly one complete cycle from proposal discovery through PR opening. No daemon, no background jobs—each cycle is a single, traceable process with auditable logs.

---

## Architecture Overview

### The Six Stages

Every autonomous cycle progresses through six sequential stages. Each stage has specific responsibilities, success criteria, and failure modes:

```
┌─────────────┐
│    PLAN     │  Discover work: scan sessions, costs, tests, TODO markers
│             │  Score proposals: rank by impact, cost, confidence
└──────┬──────┘
       │
┌──────▼──────┐
│    STAGE    │  Generate sprint from scored backlog
│             │  Create sprint JSON, persist to DB
└──────┬──────┘
       │
┌──────▼──────┐
│     RUN     │  Execute all 9 sprint phases (audit→plan→assign→…→learn)
│             │  Auto-advance between phases via event bus
└──────┬──────┘
       │
┌──────▼──────┐
│    VERIFY   │  Run real test suite (vitest)
│             │  Detect regressions, check quality gates
└──────┬──────┘
       │
┌──────▼──────┐
│    COMMIT   │  Create git branch, commit changes, push to origin
│             │  Secret scan, safety guards for base branch
└──────┬──────┘
       │
┌──────▼──────┐
│    REVIEW   │  Open pull request via `gh pr create`
│             │  Populate with cost, scoring, test results
└──────▼──────┘
   EXIT 0 (success)
   or EXIT 2 (killed)
   or EXIT 1 (error)
```

### Process Model

- **Single invocation, single process** — one Node.js process from CLI start to exit
- **No daemon or scheduler** — cycles are triggered by explicit CLI calls (future: cron or webhook)
- **Phases auto-advance** — within a cycle, sprint phases transition automatically via in-process event bus
- **All decisions logged** — `.agentforge/cycles/{cycleId}/` contains structured JSON logs of every decision

### Kill Switches (Safety First)

At five explicit checkpoints between stages, the `KillSwitch` evaluates whether the cycle should continue or abort:

1. **After PLAN** — cost overage, human denial of budget approval
2. **After STAGE** — sprint generation failure
3. **Between RUN phases** — consecutive phase failures, duration limit exceeded
4. **After VERIFY** — test failures below floor, regression detected, build/type-check failures
5. **Before COMMIT** — signal handlers (SIGINT/SIGTERM), manual stop file

If a kill switch trips, the cycle transitions to the `KILLED` stage, logs the reason (budget, duration, regression, testFloor, buildFailure, etc.), and exits with code 2.

---

## Stage 1: PLAN — Discovery and Scoring

### Goal

Discover candidate work items and rank them by impact, cost, and confidence. Determine whether they fit the budget.

### Data Sources

The `ProposalToBacklog` module queries SQLite for work signals within a configurable lookback window (default: 7 days):

1. **Failed sessions** — agents that got stuck, recovered, or timed out
2. **Cost anomalies** — agents with unexpected spending spikes
3. **Test failures** — files with recurring flakes or recent breakage
4. **TODO(autonomous) markers** — explicit work items marked in code comments

Each signal becomes a `BacklogItem` with:
- `id`, `title`, `description`, `priority` (P0/P1/P2)
- `source` (failed-session, cost-anomaly, test-failure, todo-marker)
- `confidence` (0..1, from proposal confidence score or 1.0 for explicit markers)
- `estimatedCostUsd` (from historical medians of similar items)
- `tags` (for team routing and version classification)

### Agent-Driven Scoring

**Why not hardcoded ranking?**  
The autonomous loop must adapt as the codebase evolves. An agent with domain knowledge can weigh trade-offs (fix a P0 crash or add the promised feature?) that static rules cannot capture. Static ranking is a three-strike fallback, not the primary path.

**The backlog-scorer agent** (defined in `.agentforge/agents/backlog-scorer.yaml`):

1. Receives the backlog + grounding context (recent test flakes, cost history, team utilization)
2. Produces a ranked list with rationale for every item
3. Explicitly flags items that would exceed budget
4. Suggests which team member should handle each item
5. Output is **structured JSON** with schema validation

**Scoring output** (`ScoringResult`):

```typescript
interface RankedItem {
  itemId: string;
  rank: number;           // 1 = highest priority
  score: number;          // 0..1, overall ranking score
  confidence: number;     // 0..1, scorer's confidence
  estimatedCostUsd: number;
  estimatedDurationMinutes: number;
  rationale: string;      // why this rank?
  dependencies: string[]; // other items this depends on
  suggestedAssignee: string;
  suggestedTags: string[];
  withinBudget: boolean;
}
```

**Schema validation: Three-strike fallback**

| Strike | Retry strategy |
|---|---|
| 1 | Retry with clarified prompt |
| 2 | Retry with simpler schema (drop optional fields) |
| 3 | Fall back to static ranking (P0 → P1 → P2, within-budget truncation) |

If strike 3 is reached, `CycleResult.scoringFallback = 'static'` is set, visible in logs.

### Budget Approval Gate

If the scorer flags items that would exceed budget, the cycle enters `BudgetApproval`:

1. Writes `.agentforge/cycles/{cycleId}/approval-pending.json` with the request
2. **TTY mode** (interactive): Prompts user inline `[y/N/edit]`
3. **Non-TTY mode** (CI): Polls for `approval-decision.json` (up to a timeout, default 5 min)
4. Writes approval decision and outcome

If rejected, the cycle aborts at PLAN stage with `kill switch: human denial`.

### Output of PLAN

- `BacklogItem[]` (scored and approved)
- `CycleLog.plan` — all proposals, scoring, approval decisions

**Failure modes:**
- No backlog items discovered → proceed with empty sprint (unusual but not fatal)
- Scoring agent fails 3 times → use static ranking (visible in logs)
- Budget overrun + human denial → kill switch → exit

---

## Stage 2: STAGE — Sprint Generation

### Goal

Convert the scored backlog into a concrete sprint plan, assign versions, persist to disk and DB.

### Version Bumping

The `VersionBumper` examines the backlog's `tags` and applies semver rules:

- **Breaking changes** (tags include "breaking") → bump major
- **New features** (tags include "feature") → bump minor
- **Fixes, chores** (default) → bump patch

Version is determined once at STAGE and used for the git branch, commit, and PR title throughout the rest of the cycle.

### Sprint Generation

`SprintGenerator` invokes `SprintPlanner` to build a `Sprint` JSON:

```typescript
interface Sprint {
  version: string;        // e.g. "6.4.0"
  sprintId: string;       // UUID
  title: string;          // e.g. "v6.4.0 — <backlog summary>"
  items: SprintItem[];
  phases: PhaseDefinition[]; // 9 phases: audit, plan, assign, execute, test, review, gate, release, learn
  budget: {
    estimatedTotalUsd: number;
    budgetUsd: number;
    reserve: number;       // budget - estimated
  };
}
```

### Persistence

- Write `.agentforge/sprints/v{version}.json`
- Call `WorkspaceAdapter.createSprint()` to persist to SQLite `sprints` table
- This creates the historical record for cost tracking and learning

### Output of STAGE

- `Sprint` (finalized, versioned, persisted)
- `version` (used for branch/PR naming)
- `CycleLog.stage` — version bumping, sprint JSON

**Failure modes:**
- Sprint generation fails → kill switch → exit with `stage` error
- No items selected → proceed with empty sprint (unusual but not fatal)

---

## Stage 3: RUN — Phase Execution

### Goal

Execute all 9 sprint phases in order, auto-advancing between them. Dispatch agents to real work.

### The Nine Phases

```
audit    → Scan codebase, identify problems and opportunities
plan     → CTO writes technical approach for selected items
assign   → AutoDelegationPipeline routes work to team agents
execute  → Parallel dispatch of work to team members (real coding)
test     → Backend QA agent writes and runs tests
review   → Code-reviewer agent validates quality
gate     → CEO approves before merge (anti-regression, compliance)
release  → Release coordinator prepares deployment
learn    → Team reflects on cycle, records learnings
```

Each phase:

1. Loads phase definition from sprint JSON
2. Invokes corresponding agent via `AgentRuntime`
3. Logs result with tokens, cost, duration
4. Publishes `phase.completed` event to event bus
5. Kill switch checks between phases (cost overage, duration limit, consecutive failures)

### Phase Auto-Advance

`PhaseScheduler`:

1. Subscribes to `phase.completed` events
2. On event, checks kill switch conditions
3. If clear, triggers next phase
4. Resolves when `learn` phase completes (or kill switch trips)

**No HTTP polling, no manual button presses.** Phases drive each other via events.

### Agent Invocation (via `claude -p` subprocess)

Each phase agent is invoked via `AgentRuntime`, which shells out to the `claude` CLI:

```bash
claude -p \
  --model <agentModel> \
  --output-format json \
  --system-prompt "<agentSystemPrompt>" \
  <<< "<phaseTask>"
```

The subprocess:
- Inherits OAuth tokens from Claude Code session (or API key from env)
- Reports `total_cost_usd` for exact cost tracking (including cache overhead)
- Returns structured JSON result

### Output of RUN

- All phase results logged to `.agentforge/cycles/{id}/phases/`
- `CycleLog.run` — per-phase results, total duration, cost by phase
- Git working tree modified (new code, tests, docs)

**Failure modes:**
- Phase execution fails → log result, check kill switch
- Consecutive phase failures (configurable threshold) → kill switch → abort
- Duration limit exceeded between phases → kill switch → abort
- Cost overage detected → kill switch → abort

---

## Stage 4: VERIFY — Testing and Regression Detection

### Goal

Run the real test suite. Detect regressions. Check build and type-check. Enforce quality gates.

### Real Test Runner

`RealTestRunner` invokes the actual test command (default: `npm run test:run`):

```bash
npx vitest run --reporter=json --run
```

Output:

1. Parse vitest's JSON report
2. Extract pass/fail counts, duration, failures
3. Save to `.agentforge/cycles/{id}/tests.json`
4. Compare against baseline to detect new failures

### Regression Detection

`RegressionDetector`:

1. Loads historical test outcomes from SQLite
2. Builds baseline of "known to pass" tests
3. Compares baseline against current test run
4. Identifies new failures (regressions)
5. **Config-controlled:** `allowRegression: false` (default) kills the cycle if any regression detected; `true` allows them (not recommended)

### Quality Gates

Check all configured gates (default: all enabled):

- **Test pass rate floor** (default 95%) — fail if `(passed / total) < 0.95`
- **Regression** — fail if any new failures detected
- **Build success** — run `npm run build`; fail if non-zero exit
- **Type-check success** — run `npx tsc --noEmit`; fail if non-zero exit

### Output of VERIFY

- `.agentforge/cycles/{id}/tests.json` — full vitest report
- `.agentforge/cycles/{id}/build.log`, `typecheck.log` (if failed)
- `CycleLog.verify` — summary, pass rates, regressions

**Failure modes:**
- Test pass rate below floor → kill switch → abort
- Regression detected + allowRegression: false → kill switch → abort
- Build failure → kill switch → abort
- Type-check failure → kill switch → abort

---

## Stage 5: COMMIT — Git Operations

### Goal

Create a feature branch, commit the cycle's work, push to origin. Perform safety checks and secret scans.

### Pre-commit Safety Checks

1. **In a git repo?** Fail if not.
2. **Working tree clean?** Fail if uncommitted changes exist (excluding whitelist patterns like `.agentforge/cycles/**`)
3. **Not on base branch?** Fail if on `main`/`develop` (config: `baseBranch`, default `main`)

### Branching

Create feature branch: `autonomous/v{version}` (e.g., `autonomous/v6.4.0`)

### Staging

Stage files **selectively** — never `git add -A`:

1. Identify files modified by the cycle
2. Stage only those files
3. Verify staged diff is under `maxFilesPerCommit` (default 100)

### Secret Scanning

Scan staged diff for patterns:

- `ANTHROPIC_API_KEY`, `SK-ant-`
- `OpenAI`, `OPENAI_API_KEY`, `sk-`
- GitHub PAT: `ghp_`, `github_pat_`
- AWS keys, private keys (SSH, GPG)

If any pattern matches, **abort commit** and fail the cycle. Prevents leaking credentials.

### Commit Message

Use a HEREDOC template:

```
autonomous(v6.4.0): <summary from backlog>

Scored items:
- Fix crash in parser (cost: $10)
- Add workspace support (cost: $15)

Cycle ID: <cycleId>
Cost: $25 / $50 budget
Test results: 2540 passed, 8 failed, pass rate 0.9968

Co-Authored-By: AgentForge Autonomous System <noreply@agentforge.dev>
```

### Pushing

Push to origin with `--force-with-lease` (safe force push):

```bash
git push origin autonomous/v{version} --force-with-lease
```

### Diagnostic Branch (on Failure)

If the cycle fails after this stage but before completion:

1. Create local-only branch `autonomous/v{version}-failed` (for post-mortem)
2. **Do not push** (local only)
3. Log location for debugging

### Output of COMMIT

- Git branch created and pushed
- Commit SHA recorded
- `.agentforge/cycles/{id}/git.json` — branch, commit SHA, files changed

**Failure modes:**
- Working tree not clean → kill switch → abort (prevents clobbering uncommitted work)
- On base branch → kill switch → abort (safety gate)
- Secret scan matches → kill switch → abort (prevents leak)
- Push fails → kill switch → abort (auth/network issue, probably)

---

## Stage 6: REVIEW — Pull Request

### Goal

Open a pull request on GitHub/GitLab. Provide human reviewer with full context: cost, scoring rationale, test results, files changed.

### PR Body Rendering

`PRBodyRenderer` builds a markdown body:

```markdown
# Autonomous Cycle v6.4.0

**Cycle ID:** <cycleId>  
**Duration:** 45 minutes  
**Cost:** $25.40 / $50.00 budget

## Work Completed

- Fix crash in parser (P0, cost: $10)
- Add workspace support (P1, cost: $15)

## Scoring Rationale

The backlog-scorer ranked these items because:
- Parser crash blocks 3 recent sessions
- Workspace support unblocks downstream features
- Both fit comfortably within budget

## Test Results

- **Pass rate:** 0.9968 (2540 passed, 8 failed, 0 skipped)
- **Regressions:** None
- **Duration:** 12 minutes

## Files Changed

- `packages/core/src/parser.ts` (15 lines added)
- `packages/core/tests/parser.test.ts` (25 lines added)
- `packages/api/src/workspace-adapter.ts` (42 lines added)
- (plus 3 more files)

## Agents Involved

- **Audit:** identified 2 critical issues
- **Plan:** CTO designed parser fix and workspace layer
- **Assign:** routed work to parser-specialist and workspace-lead
- **Execute:** both delivered on time and on budget
- **Test:** QA caught no regressions
- **Review:** code-reviewer approved all changes
- **Gate:** CEO approved release
```

### PR Creation

`PROpener` invokes `gh pr create`:

```bash
gh pr create \
  --title "autonomous(v6.4.0): parser crash fix + workspace support" \
  --body-file - \
  --draft \
  --reviewer seandonvaughan \
  --label "autonomous" \
  --label "needs-review"
```

**Parameters:**
- `--draft` — opens as draft (config: `pr.draft`, default false)
- `--reviewer` — auto-assign reviewer (config: `pr.assignReviewer`, default "seandonvaughan")
- `--label` — apply structured labels for filtering and tracking

### PR Result

- Record PR URL and number
- Return to CLI for final output
- Print: "PR opened: https://github.com/...#123"

### Output of REVIEW

- `.agentforge/cycles/{id}/pr.json` — URL, number, draft status
- `CycleLog.review` — body text, PR metadata
- **Exit with code 0** — cycle completed successfully

**Failure modes:**
- `gh` not installed → fail (dev environment issue, not cycle issue)
- `gh` not authenticated → fail (user needs to run `gh auth login`)
- PR creation fails (API error) → fail with helpful message

---

## Cycle Logging and Auditability

### Directory Structure

Every cycle creates `.agentforge/cycles/{cycleId}/`:

```
.agentforge/cycles/{cycleId}/
├── cycle.json              # Top-level result with all metadata
├── config.json             # Snapshot of CycleConfig used
├── scoring.json            # Backlog-scorer output + validation
├── sprint.json             # Finalized Sprint (copy from .agentforge/sprints/)
├── tests.json              # Vitest JSON report
├── build.log               # Build command output (if failed)
├── typecheck.log           # Type-check output (if failed)
├── git.json                # Branch, commit SHA, files changed
├── pr.json                 # PR URL, number, body
├── events.jsonl            # Event log (one per line)
├── approval-pending.json   # Budget approval request (if needed)
├── approval-decision.json  # Approval outcome (if needed)
├── STOP                    # Created if manual stop requested
├── phases/
│   ├── audit.json
│   ├── plan.json
│   ├── assign.json
│   ├── execute.json
│   ├── test.json
│   ├── review.json
│   ├── gate.json
│   ├── release.json
│   └── learn.json
└── logs/
    ├── runtime.log         # Detailed execution log (if enabled)
    └── ...
```

### Key Metadata in cycle.json

```typescript
interface CycleResult {
  cycleId: string;
  sprintVersion: string;
  stage: CycleStage;          // terminal stage (completed, killed, failed)
  startedAt: string;          // ISO 8601
  completedAt: string;        // ISO 8601
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
    total: number;
    passRate: number;
    newFailures: string[];
  };
  git: {
    branch: string;
    commitSha: string | null;
    filesChanged: string[];
  };
  pr: {
    url: string | null;
    number: number | null;
    draft: boolean;
  };
  killSwitch?: {
    reason: KillReason;
    detail: string;
    stageAtTrip: CycleStage;
    triggeredAt: string;
  };
  scoringFallback?: 'static';
}
```

### Why Structured Logs Matter

1. **Debugging** — when a cycle fails, the logs tell you exactly where and why
2. **Learning** — extract patterns from many cycles (cost, duration, success rate)
3. **Cost accountability** — break down spending by agent and phase
4. **PR context** — reviewer can inspect cycle logs while reviewing PR
5. **Future autonomy** — the system can learn from its own log history

---

## Configuration: `.agentforge/autonomous.yaml`

Every aspect of the cycle is configurable:

```yaml
budget:
  perCycleUsd: 50              # Total budget per cycle
  perItemUsd: 10               # Max per backlog item
  perAgentUsd: 15              # Max per agent invocation
  allowOverageApproval: true   # Prompt for human approval if exceeded

limits:
  maxItemsPerSprint: 20        # Backlog size cap
  maxDurationMinutes: 180      # 3 hours per cycle
  maxConsecutiveFailures: 5    # Phase failures before kill switch
  maxExecutePhaseFailureRate: 0.5  # Allow 50% item failures max

quality:
  testPassRateFloor: 0.95      # Reject if < 95% passing
  allowRegression: false       # Kill switch on any regression
  requireBuildSuccess: true    # Must `npm run build` successfully
  requireTypeCheckSuccess: true

git:
  branchPrefix: "autonomous/"
  baseBranch: "main"
  refuseCommitToBaseBranch: true
  includeDiagnosticBranchOnFailure: true
  maxFilesPerCommit: 100

pr:
  draft: false                 # Open as DRAFT or READY
  assignReviewer: "seandonvaughan"
  labels:
    - "autonomous"
    - "needs-review"

sourcing:
  lookbackDays: 7             # How far back to scan for signals
  minProposalConfidence: 0.6  # 0..1 threshold
  includeTodoMarkers: true    # Scan TODO(autonomous) in code
  todoMarkerPattern: "TODO\\(autonomous\\)|FIXME\\(autonomous\\)"

testing:
  command: "npm run test:run"
  timeoutMinutes: 20
  reporter: "json"
  buildCommand: "npm run build"
  typeCheckCommand: "npx tsc --noEmit"

scoring:
  agentId: "backlog-scorer"
  maxRetries: 3
  fallbackToStatic: true

logging:
  logDir: ".agentforge/cycles"
  retainCycles: 50             # Keep last 50 cycles

safety:
  secretScanEnabled: true
  verifyCleanWorkingTreeBeforeStart: true
  workingTreeWhitelist:
    - ".agentforge/cycles/**"
    - ".agentforge/audit.db-*"
```

---

## Extending the Loop: Common Patterns

### Adding a New Phase Handler

1. Add agent definition to `.agentforge/agents/{newPhase}-agent.yaml`
2. Create `packages/server/src/lib/run{NewPhase}Phase()` async function
3. Wire into `PhaseScheduler.run()` — it auto-discovers from sprint JSON phases
4. Add tests in `tests/autonomous/unit/phase-handlers/`
5. Register phase in sprint-generation logic

**The loop auto-discovers new phases from sprint JSON, so no code changes needed to the orchestrator itself.**

### Adding a New Scoring Signal

1. Query new signal from SQLite (add query to `ProposalToBacklog`)
2. Convert to `BacklogItem` with confidence score
3. Grounding context automatically includes new signal type (add to `ScoringPipeline.gatherGrounding()`)
4. Backlog-scorer agent receives new signal in context
5. No changes to schema, types, or config needed (just context)

### Customizing the PR Template

Edit `PRBodyRenderer.renderBody()` — it's a template function, not hardcoded. Override to include your own sections (deployment steps, rollback plan, etc.).

### Changing Kill Switch Conditions

All kill switch logic lives in `KillSwitch` class — one place to modify, five explicit checkpoints. No changes to orchestration needed.

---

## Troubleshooting: Reading Cycle Logs

### Cycle Completed but Tests Failed

Check `.agentforge/cycles/{cycleId}/tests.json` and the PR comment. If `killSwitch` is absent in `cycle.json`, the cycle ran to completion despite test failures (unusual if `testPassRateFloor: 0.95` is set).

### Cycle Killed — What Happened?

Look for `killSwitch` in `cycle.json`:

```json
{
  "killSwitch": {
    "reason": "budget",
    "detail": "cost $75 exceeds budget $50",
    "stageAtTrip": "run",
    "triggeredAt": "2026-04-07T15:30:00Z"
  }
}
```

Debug based on reason:
- **budget** — scorer overestimated or phases cost more than expected
- **duration** — phases took longer than `maxDurationMinutes`
- **regression** — test suite detected new failures
- **testFloor** — pass rate below configured floor
- **buildFailure** — `npm run build` failed (check `build.log`)
- **typeCheckFailure** — type check failed (check `typecheck.log`)
- **consecutiveFailures** — phase X failed, phase Y failed, threshold exceeded

### Phase Output Is Blank or Sparse

Check `.agentforge/cycles/{cycleId}/phases/{phaseName}.json`:

- Is `status` present? (status: "success" | "failed")
- Is `error` present? (error: "Agent runtime timeout" or similar)
- Is `cost` present? (cost: { inputTokens, outputTokens, usd })
- Is `output` present? (output: agent's structured JSON result or raw string)

If output is missing, the agent didn't produce output (crash, timeout, authentication failure).

### Approval Pending — How to Approve?

If `.agentforge/cycles/{cycleId}/approval-pending.json` exists, the cycle is waiting for budget approval:

**TTY mode:** You should have seen an inline prompt. Answer `y` to approve.

**Non-TTY mode (CI):** Write `.agentforge/cycles/{cycleId}/approval-decision.json`:

```json
{
  "approved": true,
  "approvedBy": "developer@example.com",
  "reason": "Expected spike due to new feature work"
}
```

Cycle will resume automatically (polls up to 5 min by default).

---

## Future Extensions (Bootstrap Paradox)

These capabilities are explicitly deferred — the first completed cycle (v6.4.0) will become a sprint item to implement them:

- **Persistent daemon** — long-running process that schedules cycles continuously
- **Durable state** — in-memory stores (proposals, dead ends, canaries) persisted to DB
- **Horizontal scaling** — work queue, distributed agents, coordination layer
- **Cross-cycle learning** — extract learnings from one cycle, feed into next cycle's scoring
- **Auto-merge** — if all gates pass, auto-merge PR without human review

---

## Glossary

- **Backlog** — set of discovered work items with confidence scores
- **Backlog item** — a single piece of work (fix, feature, chore) with cost/duration estimate
- **Scoring** — agent-driven ranking of backlog items by impact, cost, confidence
- **Sprint** — finalized set of backlog items selected for a cycle, with assigned resources and phases
- **Phase** — one of the 9 stages in sprint execution (audit, plan, assign, execute, test, review, gate, release, learn)
- **Kill switch** — guardrail that aborts the cycle if cost/duration/quality thresholds exceeded
- **Regression** — a test that passed in the baseline but fails in the current run
- **Cycle** — one complete invocation from proposal discovery through PR opening
- **Cycle log** — structured JSON logs in `.agentforge/cycles/{cycleId}/` documenting every decision

---

## Related Reading

- **Design Spec** — `docs/superpowers/specs/2026-04-06-autonomous-loop-design.md` (technical detail, schemas, phase handlers)
- **Implementation Plan** — `docs/superpowers/plans/2026-04-06-autonomous-loop.md` (task breakdown, 26 items)
- **Smoke Test Procedure** — `docs/superpowers/specs/2026-04-06-autonomous-smoke-test.md` (how to validate the loop)
- **Backlog Scoring** — search for `ScoringPipeline` in source code

