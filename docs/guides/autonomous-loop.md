# Autonomous Development Loop

**An end-to-end workflow where AgentForge takes one operator directive, decomposes it, executes it with your forged team, verifies the result, and opens a pull request — all without manual intervention.**

---

## Overview

The Autonomous Development Loop is AgentForge's most powerful feature. It transforms your team from a manual dispatch system into a self-directed development engine.

There are two ways to drive a cycle:

1. **Objective-driven epic cycles (primary)** — you supply one high-level goal and a budget; AgentForge decomposes it into a dependency-ordered epic and ships it as **one PR** with a spend report. This is the recommended loop for all new work.
2. **The signal-backlog loop (legacy)** — AgentForge harvests `TODO(autonomous)` markers, test failures, and cost anomalies into a multi-item sprint. Retained for compatibility; superseded by objective mode.

### What It Does

A single invocation of an objective cycle:

1. **Decomposes** — The epic planner turns your objective into child work items sized against your budget
2. **Waves** — Children are ordered into dependency waves; each wave runs in parallel
3. **Executes** — Dispatches your agent team in isolated git worktrees, with a deterministic per-child verify
4. **Integrates** — Every verified child merges onto one local integration branch
5. **Reviews** — A structured Opus review judges the integration branch as one coherent feature
6. **Releases** — Opens **one** pull request on GitHub, with a planned-vs-actual spend report

The result is a **production-ready PR** ready for human code review and merge.

### When to Use It

- **Feature delivery** — Hand AgentForge a concrete feature or refactor objective and a dollar budget
- **Sprint automation** — Run autonomous cycles on a schedule (nightly, weekly)
- **Regression fixes** — Auto-fix test failures detected in CI
- **Dependency updates** — Bulk-apply version upgrades and security patches
- **Code quality** — Auto-apply linting, refactoring, and style improvements

### When NOT to Use It

- High-stakes architectural decisions → require human `TODO(strategy)` review first
- Security vulnerabilities → run in supervised mode with approval gates
- Cross-team coordination → coordinate manually, then mark work as autonomous

---

## The Objective Loop (primary)

Objective mode is the primary loop: one directive in, one PR out. The full
operator guide — flags, budget-band math, artifacts, troubleshooting — lives in
**[Objective Mode](./objective-mode.md)**; this section is the flow summary.

```bash
# Rehearse the decomposition first (planner + validation only, ~$0.50–$2)
agentforge cycle preview --objective "Add per-agent cost tracking to the dashboard" --budget-usd 50

# Run it
agentforge cycle run --objective "Add per-agent cost tracking to the dashboard" --budget 50
```

Every objective cycle moves through these steps (riding the same 9-phase
scheduler: audit → plan → assign → execute → test → review → gate → release →
learn — the epic path changes what the phases *do*, not their order):

1. **Digest** — The `epic-planner` agent explores the repository with read-only tools (`Read`, `Glob`, `Grep`) so the plan is grounded in the actual tree, plus any accumulated knowledge-base notes from prior cycles.

2. **Decompose** — The planner emits an `EpicPlan`: child items with declared `files[]`, cost estimates, complexity, and predecessor edges. The plan is validated deterministically — acyclic dependency graph, every predecessor present, child estimates within the budget band — with exactly one repair retry on failure. Written to `decomposition.json`.

3. **Waves with per-child deterministic verify** — Children are layered into dependency waves; children in the same wave execute in parallel, each in an isolated git worktree. After each child finishes, a **deterministic verifier** (no LLM) runs a scoped typecheck and the related tests using the repo's lockfile-detected toolchain (`pnpm-lock.yaml` → corepack pnpm, `yarn.lock` → yarn, anything else → npx/npm), and fails any child that touched a file missing from its declared `files[]`.

4. **Integration** — Each verified child merges onto a local integration branch (`codex/epic-<id>`) in a dedicated worktree. Conflicts surface at integration time, wave by wave — not at PR time.

5. **Structured epic review** — One strong-model (Opus) structured review judges the whole integration branch as a single coherent feature, replacing the legacy per-item CEO gate. The verdict (`APPROVE` / `REQUEST_CHANGES` with `faultedItems`) is written to `phases/epic-review.json`; `REQUEST_CHANGES` drives a bounded fix-up loop that re-runs only the faulted children.

6. **VERIFY** — The deterministic test/build/typecheck gate still runs on the integrated result. The epic review never replaces it.

7. **One PR + spend report** — The release phase pushes the integration branch and opens **one** pull request. The learn phase writes `spend-report.json` (planned vs actual cost per child, overhead, budget utilization) and appends to `cycle-ledger.jsonl`, which feeds cost priors so future plans on this repo use observed actuals.

There is also a top-level shorthand:

```bash
agentforge objective "Add per-agent cost tracking to the dashboard" --budget 50
```

---

## Legacy: the signal-backlog loop

> **Deprecation note:** The 5-stage signal-backlog loop below is the original
> autonomous loop. It still works (`agentforge cycle run` without
> `--objective`), but it is **legacy/secondary**: forensics on crumb-sized
> backlog cycles showed most of the budget going to overhead rather than code.
> Prefer [objective mode](./objective-mode.md) for new work; expect the signal
> loop to receive maintenance only.

Every signal-backlog cycle moves through these stages in sequence:

### Stage 1: PLAN — Identify Work

The cycle starts by asking: **"What should we work on?"**

This stage:

1. **Scans for proposals** — Finds work using three sources:
   - `TODO(autonomous)` markers in code (structured like `// TODO(autonomous): fix X in src/lib/foo.ts`)
   - Test failures detected in recent runs
   - Cost anomalies or performance regressions

2. **Scores candidates** — The `backlog-scorer` agent (Opus-class, strategic) evaluates each candidate by:
   - Confidence (is it clearly defined?)
   - Impact (how many users/systems does it affect?)
   - Effort (Haiku estimate: 1-2 days of work?)
   - Risk (does it touch critical paths?)

3. **Ranks by ROI** — Sorts candidates by `confidence × impact / effort`, capping at your budget limit

4. **Approval gate** — If total cost exceeds budget:
   - Prompts you to approve the overage (TTY prompt + `.agentforge/approval.txt` file option)
   - Uses a conservative fallback ranking if the agent is unavailable

The output: **a sprint plan** with 2-5 high-confidence work items assigned to team members.

### Stage 2: STAGE — Generate Sprint

The cycle generates the actual sprint manifest.

This stage:

1. **Predicts implementation** — For each work item, `SprintPredictor` (Sonnet) estimates:
   - Which files will change
   - Which team members should implement
   - Rough line count and complexity

2. **Plans assignments** — `AutoDelegationPipeline` maps work items to agents:
   - Architects handle system design
   - Coders handle implementation
   - Test engineers handle test coverage
   - Security auditor handles security review

3. **Generates manifest** — Creates `.agentforge/cycles/{cycleId}/sprint.yaml` with:
   - 2-5 work items
   - Per-item effort estimates (in tokens)
   - Agent assignments
   - Success criteria (tests must pass, coverage ≥ threshold)

### Stage 3: EXECUTE — Run the Sprint

The cycle runs your agent team in parallel.

This stage:

1. **Dispatches agents** — Sends each work item to its assigned agent(s) via real Anthropic API calls

2. **Tracks progress** — Monitors:
   - Token consumption (vs. budget)
   - Time elapsed (vs. max duration)
   - Intermediate outputs (file writes, code generation)

3. **Implements work** — Each agent:
   - Reads relevant code files
   - Implements the change
   - Writes files to disk
   - Reports completion

4. **Handles failures** — If an agent fails:
   - Retries once with more context
   - On second failure, marks item as incomplete
   - Continues with other items (tolerates up to 50% failure rate)

The output: **modified source files** in your working tree, ready for testing.

### Stage 4: VERIFY — Test & Validate

The cycle verifies correctness.

This stage:

1. **Runs test suite** — Executes your test command (default: `npm test`) against the modified code

2. **Parses results** — Extracts:
   - Total tests run
   - Passed / failed / skipped counts
   - Per-file failure details

3. **Compares to baseline** — Checks:
   - Did we regress (break tests that were passing)?
   - Are we above the test-pass floor (default: 95%)?

4. **Fails fast if needed** — If failures exceed tolerance:
   - Keeps a diagnostic commit on `autonomous/vX.Y.Z-failed` branch
   - Rolls back working tree to last known good
   - Kills the cycle with reason `testFloor`

5. **Type-checks** — Optionally runs `tsc --noEmit` (configurable)

The output: **verified code** that passes your quality gates.

### Stage 5: COMMIT & REVIEW

The cycle commits and opens a PR.

This stage:

1. **Bumps version** — Applies semver rules (major/minor/patch) based on change impact:
   - Feature (new capability) → minor bump
   - Fix (bug or regression) → patch bump
   - Architecture or dependency change → major bump (configurable)

2. **Creates commit** — Makes a real git commit with:
   - Structured message: `feature: <title>\n\n<impact summary>\n\nCo-Authored-By: AgentForge ...`
   - Authorship tagged as `agentforge@yourteam.com`

3. **Creates branch** — Pushes to `autonomous/vX.Y.Z` branch

4. **Opens PR** — Via `gh` CLI, creates a pull request with:
   - Title: `v{version}: {work item summary}`
   - Body: Cycle summary, cost report, test results
   - Reviewer: Assigned to you (configurable)
   - Labels: `autonomous`, `cycleId`, version tag

The output: **a ready-to-review PR** visible on GitHub.

---

## Configuration

### Setup: `.agentforge/autonomous.yaml`

Create this file in your project root to control autonomous cycles:

```yaml
# .agentforge/autonomous.yaml
budget:
  perCycleUsd: 50          # Max total cost per cycle
  perItemUsd: 10           # Max cost per work item
  allowOverageApproval: true  # Prompt user if over budget?

limits:
  maxItemsPerSprint: 5     # Max work items per cycle
  maxDurationMinutes: 120  # Timeout if cycle runs >2 hours
  maxConsecutiveFailures: 3  # Kill after 3 agent failures

quality:
  testPassRateFloor: 0.95  # Fail if <95% tests pass
  allowRegression: false   # Reject if we broke passing tests
  requireBuildSuccess: true  # Must `npm run build` succeed
  requireTypeCheckSuccess: true  # Must `tsc --noEmit` pass

git:
  branchPrefix: 'autonomous'
  baseBranch: 'main'
  refuseCommitToBaseBranch: true
  includeDiagnosticBranchOnFailure: true  # Keep failed branch for debugging
  maxFilesPerCommit: 100

pr:
  draft: false             # Open as ready-to-review?
  assignReviewer: 'username'  # GitHub username or null
  labels: ['autonomous', 'bot']
  titleTemplate: 'v{version}: {summary}'

sourcing:
  lookbackDays: 7          # Scan last 7 days of history
  includeTodoMarkers: true # Include TODO(autonomous) markers
  minProposalConfidence: 0.6  # Min 60% confidence to include

testing:
  command: 'npm test'      # Test command to run
  typeCheck: 'tsc --noEmit'  # Type-check command
```

These settings apply to both loops. In objective mode the `--budget` flag
overrides `budget.perCycleUsd` (precedence: `--budget` flag >
`AUTONOMOUS_BUDGET_USD` env > `autonomous.yaml`), and the planner sizes the
epic against that number directly.

### Kill Switches: Safety & Control

The cycle monitors these limits and **kills the cycle early** if any are exceeded:

| Kill Switch | Condition | What Happens |
|---|---|---|
| **Budget overage** | Planned cost > `perCycleUsd` at plan time | Prompts for approval; kills if rejected. (Mid-cycle, crossing `perCycleUsd` is warn-only — the cycle continues; in objective mode the `--budget` flag sizes the plan up front) |
| **Duration timeout** | Elapsed time > `maxDurationMinutes` | Kills immediately, keeps current progress |
| **Test floor** | Test pass rate < `testPassRateFloor` | Rolls back, commits diagnostic branch, kills |
| **Build failure** | `npm run build` exits non-zero | Rolls back, kills |
| **Type check failure** | `tsc --noEmit` fails | Rolls back, kills |
| **Consecutive failures** | >3 agent calls fail in a row | Kills to avoid wasting budget |
| **Regression detection** | Previously-passing test now fails | Rolls back, kills |
| **Manual stop** | File `.agentforge/STOP_CYCLE` exists | Kills gracefully on next phase boundary |

### Folder Structure

After a cycle completes, you'll have:

```
your-project/
  .agentforge/
    cycles/
      {cycleId}/
        ├── manifest.json         # Cycle metadata
        ├── plan.json             # Ranked work items
        ├── sprint.yaml           # Agent assignments
        ├── exec.log              # Execution transcript
        ├── test-results.json     # Test suite results
        ├── cycle.log             # Structured timeline
        ├── pr.json               # PR details + URL
        └── cost-report.json      # Token spend breakdown
    autonomous.yaml              # Configuration (you create this)
    STOP_CYCLE                   # Create to pause (read by daemon)
```

---

## Running a Cycle

### Prerequisites

1. **Team manifest** — Run `forge` or `genesis` to generate `.agentforge/team.yaml`
2. **Objective-mode agents** — Objective cycles invoke `epic-planner` (decomposition) and `ceo` (epic review) by ID. On a fresh repo, hand-add `.agentforge/agents/epic-planner.yaml` and `.agentforge/agents/ceo.yaml` until the forge ships them — without these the runtime falls back to a generic agent for planning and review
3. **Configuration** — Create `.agentforge/autonomous.yaml` (or use defaults)
4. **Git** — Working tree must be clean (commit or stash changes first)
5. **Claude Code Authentication** — Be logged into Claude Code (Max plan recommended). See [API Reference § 1 — Authentication](../api-reference.md#-1--authentication)
6. **GitHub CLI** — `gh` must be installed and authenticated (`gh auth login`)

### Run a Single Cycle

```bash
# Objective mode (primary): one directive, one PR
agentforge cycle run --objective "your goal here" --budget 50

# Legacy signal-backlog mode
agentforge cycle run --project-root /path/to/your-project
```

This:
1. Loads `.agentforge/autonomous.yaml`
2. Instantiates your team
3. Plans (decomposes, in objective mode), executes, tests, commits, and opens a PR
4. Exits non-zero on error or a tripped kill switch

### Check Cycle Status

```bash
ls -lh .agentforge/cycles/
# Lists all cycle runs
```

### Review the PR

The cycle outputs:

```
✓ Created PR: https://github.com/yourorg/yourrepo/pull/1234
```

Click the link, review the changes, and merge if satisfied.

### Debug a Failed Cycle

If the cycle fails, check:

1. **Cycle log**:
   ```bash
   cat .agentforge/cycles/{cycleId}/cycle.log
   ```

2. **Execution transcript**:
   ```bash
   cat .agentforge/cycles/{cycleId}/exec.log
   ```

3. **Diagnostic branch** (if test floor was breached):
   ```bash
   git log --oneline autonomous/vX.Y.Z-failed
   ```

4. **Cost report**:
   ```bash
   cat .agentforge/cycles/{cycleId}/cost-report.json | jq .
   ```

---

## Understanding the Output

### PR Description

The PR auto-populated description includes:

```markdown
## Autonomous Sprint v6.4.2

**Items:** 3 work items completed
**Cost:** $12.34 (24.6% of $50 budget)
**Tests:** 247 passed, 0 failed (100%)
**Execution time:** 18 minutes

### Work Completed
- [x] Fix: Migrate workspace-adapter to postgres (assigned to coder)
- [x] Feature: Add CORS support to API (assigned to architect)
- [x] Test: Increase coverage for auth module (assigned to test-engineer)

### Cost Breakdown
- Plan phase: $0.50 (agent scoring)
- Execute phase: $9.20 (agent implementation)
- Test phase: $1.50 (test runner)
- Review phase: $1.14 (code review agent)

### Kill Switches
- Budget: ✓ OK ($12.34 < $50.00)
- Test floor: ✓ OK (100% > 95%)
- Duration: ✓ OK (18m < 120m)
```

### Cycle Manifest

`.agentforge/cycles/{cycleId}/manifest.json`:

```json
{
  "cycleId": "20260407-143022-abc123",
  "version": "6.4.2",
  "stages": {
    "plan": {
      "status": "completed",
      "duration": "2m",
      "proposals": 8,
      "selected": 3
    },
    "execute": {
      "status": "completed",
      "duration": "12m",
      "itemsCompleted": 3,
      "itemsFailed": 0
    },
    "verify": {
      "status": "completed",
      "duration": "4m",
      "testsPassed": 247,
      "testsFailed": 0
    },
    "commit": {
      "status": "completed",
      "branch": "autonomous/v6.4.2",
      "commit": "3a7f8d2c..."
    },
    "review": {
      "status": "completed",
      "pr": "https://github.com/yourorg/repo/pull/1234"
    }
  },
  "costUsd": 12.34,
  "budgetUsd": 50.00,
  "exitCode": 0
}
```

---

## Advanced: Marking Work for Autonomy

### TODO(autonomous) Markers

Use special comments to flag code for autonomous processing:

```typescript
// TODO(autonomous): migrate workspace-adapter to postgres
// This is blocking the multi-tenant roadmap. Estimate 2-3 days.
export const query = (sql: string) => db.raw(sql);
```

The marker format:
- **Comment prefix required** — Must start with `//`, `/*`, `*`, `<!--`, or `#`
- **Pattern** — `TODO(autonomous): DESCRIPTION`
- **Optional context** — Add extra detail on following lines

Examples:

```typescript
// TODO(autonomous): fix memory leak in compression module
// Affects large file uploads. See issue #1234.

/* TODO(autonomous): upgrade @types/node to v20 */

<!-- TODO(autonomous): add health check endpoint to dashboard API -->

# TODO(autonomous): refactor theme system to use CSS variables
# This enables dark mode support more easily.
```

The scanner **ignores** these (not autonomous work):
```typescript
const pattern = /TODO\\(autonomous\\): should not match/;
const text = "TODO(autonomous): embedded in string";
```

### Confidence Scores

The scorer assigns confidence based on clarity:

| Confidence | Criteria | Example |
|---|---|---|
| **High (0.9+)** | Specific task, clear acceptance criteria | "Fix memory leak in compression module causing OOM on uploads >100MB" |
| **Medium (0.6-0.8)** | Well-defined but some ambiguity | "Upgrade @types/node, ensure tests pass" |
| **Low (<0.6)** | Vague or requires investigation | "Improve performance" |

High-confidence items are executed first; low-confidence items may be deferred or require approval.

### Filtering Work by Domain

Tag work items to control which agents work on them:

```typescript
// TODO(autonomous): [architecture] redesign cache layer for distributed systems
// Routed to: Architect, Senior Engineer
```

Supported tags: `[architecture]`, `[security]`, `[performance]`, `[ux]`, `[ops]`, `[research]`, `[testing]`

Agents that don't match the tag will not be assigned the work.

---

## Cost & Budget

### Understanding Costs

Each phase costs different amounts:

| Phase | Typical Cost | Driver |
|---|---|---|
| **Plan** | $0.50 | Scanning proposals + agent scoring |
| **Stage** | $0.20 | Prediction + assignment (usually cached) |
| **Execute** | 80% of total | Real agent implementations |
| **Verify** | $1-3 | Running test suite + parsing results |
| **Commit** | Minimal | Git operations (free) |
| **Review** | 5-10% | Code review agent feedback |

### Cost Saving Tips

1. **Increase `minProposalConfidence`** — Skip low-confidence items
2. **Set `maxItemsPerSprint: 2`** — Smaller sprints, lower cost
3. **Schedule during off-hours** — Avoid API rate limits
4. **Cache test results** — Skip re-running expensive tests
5. **Use Haiku for scoring** — Faster/cheaper proposals (tradeoff: lower quality scoring)

### Over-Budget Cycles

If `perCycleUsd` is exceeded:

1. **Prompt mode** — You're asked to approve in TTY
2. **File mode** — Write your approval to `.agentforge/approval.txt`:
   ```
   cycle_id: 20260407-143022-abc123
   approved_by: sean
   timestamp: 2026-04-07T14:30:22Z
   extra_budget_usd: 25.00
   reason: Unexpected complexity in module refactor
   ```
3. **Rejection** — Cycle kills and keeps current progress on `autonomous/vX.Y.Z-partial` branch

---

## Troubleshooting

### Cycle Kills at PLAN Stage

**Symptom:** "Budget exceeded at plan stage"

**Causes:**
- Backlog is too large
- `minProposalConfidence` is too low (including weak candidates)
- Scorer is over-estimating costs

**Fix:**
- Lower `maxItemsPerSprint` to 2-3 items
- Increase `minProposalConfidence` to 0.7+
- Remove vague `TODO(autonomous)` markers

---

### Cycle Kills at TEST Stage (Test Floor)

**Symptom:** "Test pass rate 85% < 95% floor"

**Causes:**
- Agent introduced a breaking change
- Existing test was flaky and now failing
- Test dependencies changed

**Fix:**
1. Inspect the diagnostic branch:
   ```bash
   git checkout autonomous/v6.4.2-failed
   npm test  # Run locally to confirm
   ```
2. Identify the failing test
3. File a bug report or mark that item as `TODO(strategic)` for manual review
4. Delete the diagnostic branch when done:
   ```bash
   git branch -D autonomous/v6.4.2-failed
   ```

---

### High Token Usage / Cost Overruns

**Symptom:** "Phase used $8 / $10 item budget"

**Causes:**
- Agent is re-reading large files multiple times
- Complex tasks take many turns
- Hidden dependencies not in scope estimate

**Fix:**
- Reduce item scope ("split large TODO markers")
- Pre-index files in agent context (future feature)
- Use `--model claude-haiku` for cheaper estimation (trades quality)

---

## Next Steps: Scheduling & Dashboards

### Cron-Based Cycles

Once you're confident in your configuration:

```bash
# Run daily at 9 AM
0 9 * * * cd /path/to/project && agentforge cycle run --objective "..." --budget 50
```

### Monitoring Dashboard

Start the operator dashboard with `agentforge start` and open
`http://localhost:4751`. It shows cycle history, live phase progress, cost
trends, agent activity, and — for objective cycles — the **Epic** tab
(children, waves, dependency arrows), the **Spend** tab (planned vs actual per
child), and the epic-review verdict card on `/cycles/<id>`.

---

## Glossary

| Term | Definition |
|---|---|
| **Cycle** | One complete plan → execute → test → commit → review run |
| **Stage** | One of 5 phases: plan, stage, execute, verify, commit+review |
| **Phase** | Generic term for any execution step (used interchangeably with "stage") |
| **Work item** | A single task, usually from a `TODO(autonomous)` marker |
| **Backlog** | All proposed work items for a cycle (before scoring/selection) |
| **Kill switch** | A safety limit (budget, duration, test floor) that halts the cycle |
| **Diagnostic branch** | A git branch created on failure, kept for debugging |
| **Cycle ID** | Unique identifier: `{date}-{time}-{hash}` (e.g., `20260407-143022-abc123`) |
| **Cost report** | JSON summary of token spend per phase |

---

## See Also

- **[Objective Mode](./objective-mode.md)** — The primary loop: flags, budget-band math, artifacts, troubleshooting
- **[Configuration Reference](./autonomous-config-reference.md)** — Deep dive into `autonomous.yaml` options
- **[API Reference](../api-reference.md)** — REST endpoints including `GET /api/v5/cycles/:id` epic artifacts
- **[Architecture](../design.md#autonomous-loop)** — Design decisions and rationale
- **[Troubleshooting](./autonomous-troubleshooting.md)** — Common issues and fixes
