# Autonomous Development Loop

**An end-to-end workflow where AgentForge plans sprints, executes them, tests the results, commits to git, and opens pull requests — all without manual intervention.**

---

## Overview

The Autonomous Development Loop is AgentForge's most powerful feature. It transforms your team from a manual dispatch system into a self-directed development engine that scans for work, prioritizes it, executes it, verifies it, and submits it for review — all in one continuous cycle.

### What It Does

A single invocation of the autonomous loop:

1. **Plans** — Scans your codebase for work (`TODO(autonomous)` markers, test failures, performance metrics)
2. **Scores** — Ranks candidates by feasibility and impact, estimates costs
3. **Executes** — Dispatches your agent team to implement the work in parallel
4. **Tests** — Runs the full test suite to verify correctness
5. **Commits** — Makes real git commits with structured messages
6. **Reviews** — Opens a pull request on GitHub for human approval

The result is a **production-ready PR** ready for human code review and merge.

### When to Use It

- **Sprint automation** — Run autonomous cycles on a schedule (nightly, weekly)
- **Backlog processing** — Automatically work through high-confidence items while humans focus on strategy
- **Regression fixes** — Auto-fix test failures detected in CI
- **Dependency updates** — Bulk-apply version upgrades and security patches
- **Code quality** — Auto-apply linting, refactoring, and style improvements

### When NOT to Use It

- High-stakes architectural decisions → require human `TODO(strategy)` review first
- Security vulnerabilities → run in supervised mode with approval gates
- Cross-team coordination → coordinate manually, then mark work as autonomous
- Brand new features → plan manually, execute autonomously

---

## How It Works: The 5 Stages

Every autonomous cycle moves through these stages in sequence:

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

### Kill Switches: Safety & Control

The cycle monitors these limits and **kills the cycle early** if any are exceeded:

| Kill Switch | Condition | What Happens |
|---|---|---|
| **Budget overage** | Total cost > `perCycleUsd` | Prompts for approval; kills if rejected |
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
2. **Configuration** — Create `.agentforge/autonomous.yaml` (or use defaults)
3. **Git** — Working tree must be clean (commit or stash changes first)
4. **Claude Code Authentication** — Be logged into Claude Code (Max plan recommended). See [API Reference § 1 — Authentication](../api-reference.md#-1--authentication)
5. **GitHub CLI** — `gh` must be installed and authenticated (`gh auth login`)

### Run a Single Cycle

```bash
npm run autonomous:cycle
```

This:
1. Loads `.agentforge/autonomous.yaml`
2. Instantiates your team
3. Plans, executes, tests, commits, and opens a PR
4. Exits with status 0 (success), 1 (error), or 2 (kill switch tripped)

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

### Cron-Based Cycles (Future)

Once you're confident in your configuration:

```bash
# Run daily at 9 AM
0 9 * * * cd /path/to/project && npm run autonomous:cycle
```

### Monitoring Dashboard (v7.0)

Coming in v7.0: a web dashboard showing:
- Cycle history and success rates
- Cost trends over time
- Agent performance metrics
- PR review metrics
- Integration with GitHub Actions status

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

- **[Configuration Guide](./autonomous-config.md)** — Deep dive into `autonomous.yaml` options
- **[API Reference](../api/autonomous-api.md)** — Programmatic cycle invocation
- **[Architecture](../design.md#autonomous-loop)** — Design decisions and rationale
- **[Troubleshooting](./autonomous-troubleshooting.md)** — Common issues and fixes
