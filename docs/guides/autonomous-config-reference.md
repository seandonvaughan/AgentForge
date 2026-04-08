# Autonomous Loop Configuration Reference

Complete reference for `.agentforge/autonomous.yaml` options.

---

## Structure Overview

```yaml
budget:          # Cost limits and approval handling
limits:          # Time, item count, and failure tolerances
quality:         # Test thresholds, regression detection, build requirements
git:             # Git and branch naming conventions
pr:              # Pull request creation and assignment
sourcing:        # Work discovery and proposal filtering
testing:         # Test command and type checking
```

---

## budget

**Controls spending and approval gates.**

```yaml
budget:
  perCycleUsd: 50
  perItemUsd: 10
  allowOverageApproval: true
```

### `perCycleUsd` (number, default: 50)

Maximum USD budget for a single cycle. If exceeded:
- With `allowOverageApproval: true` — prompts user for approval
- With `allowOverageApproval: false` — rejects work items until under budget

**Examples:**
- `50` — Budget for small projects, quick experiments
- `100` — Budget for medium sprints with 3-5 work items
- `200` — Budget for major features or large refactors
- `10` — Budget for bug-fix-only cycles

### `perItemUsd` (number, default: 10)

Maximum USD budget per work item. Prevents any single item from consuming too much of the cycle budget.

If a work item's estimated cost exceeds this:
- In **plan stage** — filtered out by scorer
- In **execute stage** — killed immediately to preserve budget

**Typical values:**
- `5` — Force small, focused work items
- `10` — Balance between focus and throughput
- `25` — Allow complex items with multiple implementation paths

### `allowOverageApproval` (boolean, default: true)

Whether to prompt for human approval when budget is exceeded.

With `true`:
1. Cycle collects high-confidence items until budget exceeded
2. Prompts: `Overage of $5.00 — approve? [y/n]`
3. If yes, continues cycle with approved overage
4. If no, kills cycle and keeps current work on `autonomous/vX.Y.Z-partial` branch

With `false`:
1. Strictly respects `perCycleUsd` limit
2. Lower-scored items automatically filtered out
3. No prompt, faster cycle execution

---

## limits

**Controls time, scale, and failure tolerances.**

```yaml
limits:
  maxItemsPerSprint: 5
  maxDurationMinutes: 120
  maxConsecutiveFailures: 3
```

### `maxItemsPerSprint` (number, default: 5)

Maximum work items to include in a single sprint.

Limits the scope of each cycle:
- `2` — Highly focused, fast cycles (8-30 min)
- `5` — Balanced cycles with parallel execution (30-120 min)
- `10` — Large sprints, higher parallelism (60-180 min)

Scorer will stop selecting items once this count is reached, even if budget remains.

### `maxDurationMinutes` (number, default: 120)

Total wall-clock time before the cycle is killed.

Includes:
- Planning (2-5 min)
- Execution (10-60 min)
- Testing (5-20 min)
- Git/PR operations (1-5 min)

If any stage takes longer:
- Current progress is preserved
- Cycle is killed with reason `duration`
- Working tree is rolled back to last checkpoint

**Typical values:**
- `30` — Quick experiments, CI-friendly
- `60` — Standard office hours run
- `120` — Nightly or hands-off cycles
- `240` — Large migrations, can run over lunch

### `maxConsecutiveFailures` (number, default: 3)

How many agent failures in a row before killing the cycle.

If a single work item fails 3 times (with retries):
1. Cycle logs the failure
2. Marks item as incomplete
3. Continues with next item

If **3 items fail consecutively**, cycle is killed to avoid wasting budget.

**Typical values:**
- `1` — Strict mode, any failure stops the cycle
- `3` — Standard, tolerate isolated failures
- `5` — Permissive, only stop on pattern of failures

---

## quality

**Tests, type checking, regression detection.**

```yaml
quality:
  testPassRateFloor: 0.95
  allowRegression: false
  requireBuildSuccess: true
  requireTypeCheckSuccess: true
```

### `testPassRateFloor` (number, 0.0–1.0, default: 0.95)

Minimum test pass rate required to proceed.

If test pass rate falls below this after execution:
1. Cycle creates diagnostic branch `autonomous/vX.Y.Z-failed`
2. Rolls back working tree to pre-execution state
3. Kills with reason `testFloor`
4. Logs failing tests in `.agentforge/cycles/{id}/test-results.json`

**Typical values:**
- `0.95` (95%) — Standard, no regressions tolerated
- `0.90` (90%) — Relaxed, allow 1-2 test failures
- `1.00` (100%) — Strict, all tests must pass
- `0.80` (80%) — Very permissive, used for exploratory cycles

### `allowRegression` (boolean, default: false)

Whether to tolerate breaking previously-passing tests.

With `false` (recommended):
- Regression detector tracks test status before/after
- If any test regressed (was passing, now failing), kills cycle
- More strict than `testPassRateFloor`

With `true`:
- Only checks absolute pass rate against floor
- Allows trading broken tests for new passing tests
- Use only if managing test debt intentionally

### `requireBuildSuccess` (boolean, default: true)

Whether to fail if `npm run build` exits non-zero.

With `true`:
1. After execute phase, runs build command
2. If it fails, kills with reason `buildFailure`
3. Preserves diagnostic branch for investigation

With `false`:
- Skips build step
- Faster cycle, but risks shipping broken code
- Not recommended for production cycles

### `requireTypeCheckSuccess` (boolean, default: true)

Whether to fail if `tsc --noEmit` exits non-zero.

With `true`:
1. After execute phase, runs type check
2. If TypeScript errors found, kills with reason `typeCheckFailure`
3. Helpful for catching errors before test runtime

With `false`:
- Skips type check
- TypeScript errors may be caught in tests
- Useful for projects without strict TS config

---

## git

**Branch naming, safety, and commit behavior.**

```yaml
git:
  branchPrefix: 'autonomous'
  baseBranch: 'main'
  refuseCommitToBaseBranch: true
  includeDiagnosticBranchOnFailure: true
  maxFilesPerCommit: 100
```

### `branchPrefix` (string, default: 'autonomous')

Prefix for branches created by autonomous cycles.

Full branch format: `{branchPrefix}/v{version}` (e.g., `autonomous/v6.4.2`)

**Examples:**
- `autonomous` — Standard prefix
- `auto` — Shorter, if you have many branch names
- `bot/auto` — Hierarchical naming
- `cycle` — Generic prefix

### `baseBranch` (string, default: 'main')

The branch to base new cycles on and push PRs against.

Must exist and be up-to-date before cycle starts.

**Examples:**
- `main` — GitHub default
- `master` — Older convention
- `develop` — For git-flow workflows
- `staging` — For staged deployments

### `refuseCommitToBaseBranch` (boolean, default: true)

Safety switch: prevent accidental commits to base branch.

With `true`:
- Cycle refuses to commit to `baseBranch` (even if cycle branch = base)
- Enforces feature-branch workflow
- Kills with reason `refusedBaseBranchCommit` if violated

With `false`:
- Allows committing directly to base branch (not recommended)
- Useful only if you have no CI requirements

### `includeDiagnosticBranchOnFailure` (boolean, default: true)

Whether to keep a `{branchPrefix}/vX.Y.Z-failed` branch on failure.

With `true`:
- Failed branch is created and pushed
- Contains last known state before rollback
- Useful for debugging
- **Note:** Must delete manually (`git branch -D ...`)

With `false`:
- Failed branch is discarded
- Cleaner branch list, but harder to debug
- Useful if you're confident in your quality gates

### `maxFilesPerCommit` (number, default: 100)

Maximum files to include in a single commit.

If more files change:
- Cycle still commits all files (no truncation)
- But logs a warning
- Useful for detecting unexpectedly large changes

**Typical values:**
- `50` — Strict, many commits might be needed
- `100` — Balanced, allows medium-sized refactors
- `1000` — Permissive, allow large batch changes

---

## pr

**Pull request creation and GitHub integration.**

```yaml
pr:
  draft: false
  assignReviewer: 'username'
  labels: ['autonomous', 'bot']
  titleTemplate: 'v{version}: {summary}'
```

### `draft` (boolean, default: false)

Whether to open PRs as drafts.

With `false` (recommended):
- PR is opened as ready-to-review
- Visible in main PR list
- Allows immediate review and merge

With `true`:
- PR is marked as draft
- Indicates work-in-progress status
- Requires manual promotion to ready-to-review
- Useful if cycles are exploratory

### `assignReviewer` (string or null, default: null)

GitHub username to auto-assign as reviewer.

Examples:
- `'sean'` → assigns `@sean`
- `'security-team'` → assigns `@security-team` (team)
- `null` → no auto-assignment

**Note:** User/team must have read access to the repository.

### `labels` (array of strings, default: `['autonomous', 'bot']`)

GitHub labels to apply to the PR.

Examples:
- `['autonomous']` — Mark as bot-created
- `['autonomous', 'feature']` — Mark as feature
- `['auto', 'review-needed']` — Custom labeling
- `[]` — No labels

Labels must exist in the repository (or GitHub will ignore them).

### `titleTemplate` (string, default: `'v{version}: {summary}'`)

Template for PR title.

Placeholders:
- `{version}` — Semver version (e.g., `6.4.2`)
- `{summary}` — Work item summary (first 60 chars)
- `{count}` — Number of work items
- `{date}` — Cycle date (YYYY-MM-DD format)

**Examples:**
- `'v{version}: {summary}'` → `v6.4.2: Fix memory leak in compression`
- `'[Autonomous] {summary}'` → `[Autonomous] Fix memory leak in compression`
- `'Sprint v{version} ({count} items)'` → `Sprint v6.4.2 (3 items)`

---

## sourcing

**Work discovery: TODO markers, test failures, metrics.**

```yaml
sourcing:
  lookbackDays: 7
  minProposalConfidence: 0.6
  includeTodoMarkers: true
  todoMarkerPattern: 'TODO\\(autonomous\\):\\s*(.*)'
```

### `lookbackDays` (number, default: 7)

How far back to scan for test failures, cost anomalies, and performance regressions.

Examples:
- `1` — Only today's failures (fast, narrow scope)
- `7` — Last week (standard, good balance)
- `30` — Last month (slow, broad scope)

Affects:
- How many test runs to analyze
- How many log entries to scan
- How old a cost anomaly can be

### `minProposalConfidence` (number, 0.0–1.0, default: 0.6)

Minimum confidence score to include a work item.

Scorer assigns confidence based on:
- Specificity of description (high if clear, low if vague)
- Frequency of failures (high if recurring, low if one-off)
- Feasibility (high if similar work done before, low if novel)

**Typical values:**
- `0.3` — Very permissive, include all proposals (quality risk)
- `0.6` — Balanced, most good items included
- `0.8` — Strict, only high-quality items
- `0.95` — Very strict, almost no vague work

Items below this threshold are filtered out by the scorer and not included in the sprint.

### `includeTodoMarkers` (boolean, default: true)

Whether to scan for `TODO(autonomous)` markers in source code.

With `true`:
- Scanner runs `grep` over source tree
- Extracts lines like `// TODO(autonomous): fix X`
- Includes them as proposals

With `false`:
- Only uses test failures and metrics
- Faster scanning
- Useful if TODO markers are out-of-date

### `todoMarkerPattern` (regex string, default: `'TODO\\(autonomous\\):\\s*(.*)'`)

Regex pattern to match TODO markers.

Default pattern:
- Matches `TODO(autonomous):` followed by description
- Captures everything after the colon as description
- Case-sensitive

**Custom patterns:**
- `'FIXME\\(bot\\):\\s*(.*)'` — Use FIXME instead of TODO
- `'\\[AUTONOMOUS\\]\\s*(.*)'` → Use bracket notation

**Note:** Pattern must be a valid JavaScript regex string (escape backslashes).

---

## testing

**Test execution and type checking.**

```yaml
testing:
  command: 'npm test'
  typeCheck: 'tsc --noEmit'
```

### `command` (string, default: `'npm test'`)

Shell command to run the test suite.

Examples:
- `'npm test'` — Standard npm
- `'pnpm test'` — pnpm package manager
- `'make test'` — Makefile-based
- `'vitest run'` — Direct vitest
- `'pytest'` — Python projects
- `'go test ./...'` — Go projects

Cycle will:
1. Execute command in project root
2. Parse stdout/stderr for test results
3. Extract pass/fail counts
4. Compare against `testPassRateFloor`

### `typeCheck` (string, default: `'tsc --noEmit'`)

Shell command to run type checking.

Set to empty string `''` to skip type checking.

Examples:
- `'tsc --noEmit'` — TypeScript
- `'mypy .'` — Python
- `''` — Skip (no type checking)
- `'flow check'` — Flow type checker

Cycle will:
1. Execute command after tests pass
2. If it fails, kill with reason `typeCheckFailure` (if `requireTypeCheckSuccess: true`)

---

## Default Configuration

If `.agentforge/autonomous.yaml` is missing, defaults are:

```yaml
budget:
  perCycleUsd: 50
  perItemUsd: 10
  allowOverageApproval: true

limits:
  maxItemsPerSprint: 5
  maxDurationMinutes: 120
  maxConsecutiveFailures: 3

quality:
  testPassRateFloor: 0.95
  allowRegression: false
  requireBuildSuccess: true
  requireTypeCheckSuccess: true

git:
  branchPrefix: 'autonomous'
  baseBranch: 'main'
  refuseCommitToBaseBranch: true
  includeDiagnosticBranchOnFailure: true
  maxFilesPerCommit: 100

pr:
  draft: false
  assignReviewer: null
  labels: ['autonomous', 'bot']
  titleTemplate: 'v{version}: {summary}'

sourcing:
  lookbackDays: 7
  minProposalConfidence: 0.6
  includeTodoMarkers: true
  todoMarkerPattern: 'TODO\\(autonomous\\):\\s*(.*)'

testing:
  command: 'npm test'
  typeCheck: 'tsc --noEmit'
```

---

## Common Configurations

### Conservative (for production)

```yaml
budget:
  perCycleUsd: 25
  perItemUsd: 5
  allowOverageApproval: false

limits:
  maxItemsPerSprint: 2
  maxDurationMinutes: 60
  maxConsecutiveFailures: 1

quality:
  testPassRateFloor: 0.99
  allowRegression: false
  requireBuildSuccess: true
  requireTypeCheckSuccess: true

pr:
  draft: true  # Always review before auto-merge
  assignReviewer: 'security-lead'
```

### Aggressive (for experimentation)

```yaml
budget:
  perCycleUsd: 100
  perItemUsd: 20
  allowOverageApproval: true

limits:
  maxItemsPerSprint: 10
  maxDurationMinutes: 180
  maxConsecutiveFailures: 5

quality:
  testPassRateFloor: 0.85
  allowRegression: true
  requireBuildSuccess: false
  requireTypeCheckSuccess: false

sourcing:
  minProposalConfidence: 0.3  # Include lower-confidence items
```

### Maintenance (for dependencies, linting)

```yaml
budget:
  perCycleUsd: 50
  perItemUsd: 3
  allowOverageApproval: false

limits:
  maxItemsPerSprint: 20  # Lots of small fixes
  maxDurationMinutes: 90
  maxConsecutiveFailures: 5

quality:
  testPassRateFloor: 0.95
  allowRegression: false

sourcing:
  minProposalConfidence: 0.5  # Include routine work
```

---

## See Also

- **[Autonomous Loop Guide](./autonomous-loop.md)** — User guide and workflow
- **[Troubleshooting](./autonomous-troubleshooting.md)** — Common issues and fixes
