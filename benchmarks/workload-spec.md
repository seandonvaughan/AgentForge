# Benchmark Workload Specification

## Purpose

Measure the **merged-PR success rate** and **cost per cycle** of an autonomous
AgentForge cycle against a fixed, repeatable workload. Results are
independently verifiable against the live GitHub API so they cannot be faked
by a static JSON file.

---

## Fixed workload

The benchmark targets **3 well-scoped backlog items** chosen to exercise the
full cycle pipeline (audit → plan → assign → execute → test → review → gate →
release → learn) without ballooning cost:

| # | Item | Category | Success signal |
|---|------|----------|----------------|
| 1 | Add a `GET /api/v5/ping` health endpoint that returns `{ok:true,ts:<ISO>}` | backend | Tests pass, PR merged |
| 2 | Add a `benchmarks/smoke.test.ts` that imports and invokes `verifyBenchmarkResult` | quality | New test file present and green |
| 3 | Emit a `benchmark.cycle.completed` event on the internal message bus after each cycle finishes | instrumentation | Event type appears in the executor source |

These items are intentionally small: each is achievable by a single Sonnet
agent in one pass. Total expected cost: **$5–$15** depending on model routing
and retry count.

---

## Metrics captured

| Field | Source | Description |
|-------|--------|-------------|
| `cycleId` | `cycle.json.cycleId` | Unique identifier for the run |
| `tasksAttempted` | plan.json item count | How many items the plan decomposed |
| `mergedPRs` | `cycle.json.pr` + GitHub API | PRs that reached `merged` state |
| `testsPassed` | `cycle.json.tests.passed` | Test count at end of cycle |
| `usd` | `cycle.json.cost.totalUsd` | Actual spend |
| `budgetUsd` | `cycle.json.cost.budgetUsd` | Hard cap configured for the run |
| `model` | `cycle.json.providerUsage` (primary key) | Dominant provider/model used |
| `ts` | `cycle.json.completedAt` | Wall-clock completion time |

---

## Budget cap

**Hard cap: $20 USD per benchmark run.**

The runner passes `--budget 20` to `agentforge cycle run`. If `cost.totalUsd`
exceeds `budgetUsd` at any point the gate rejects the cycle and the benchmark
records `ok: false`.

---

## Verification (the ungameable core)

After every run the harness calls `verifyBenchmarkResult(result, {ghCheck})`
where `ghCheck(prNumber)` calls the live GitHub API:

```
gh api repos/seandonvaughan/AgentForge/pulls/<n> --jq .merged
```

A result passes verification **only when all of the following hold**:

1. No required field (`cycleId`, `usd`, `budgetUsd`, `ts`) is `undefined`/`null`.
2. `usd <= budgetUsd`.
3. Every PR number in `mergedPRs` returns `merged: true` from GitHub.

Faking a merged PR in the result JSON is defeated by condition 3: the mock in
the unit test proves that a result claiming a non-merged PR fails immediately.

---

## How to run

### Dry-run (no spend, CI-safe)

Read an existing cycle and verify it:

```bash
node benchmarks/run-cycle-benchmark.mjs \
  --dry-run \
  --cycle <cycleId>
```

The `--dry-run` flag is the default. It reads
`.agentforge/cycles/<cycleId>/cycle.json`, builds a result record, and runs
the verification step (using real `gh api` calls if `GH_TOKEN` is set,
otherwise skips live GH checks and records `ghCheckSkipped: true`).

Output is written to `benchmarks/results/<cycleId>.json`.

### Live run (operator-triggered, real spend ~$10–$20)

```bash
export GH_TOKEN=<your-github-token>
node benchmarks/run-cycle-benchmark.mjs \
  --live \
  --budget 20
```

This drives `agentforge cycle run` against the fixed workload under the hard
budget cap, then reads the resulting `cycle.json` and runs verification.

**Do not run `--live` in CI.** The optional `.github/workflows/benchmark.yml`
is `workflow_dispatch` only for this reason.

### Help

```bash
node benchmarks/run-cycle-benchmark.mjs --help
```

---

## Results directory

Each run writes `benchmarks/results/<cycleId>.json`. The directory is tracked
in git via `benchmarks/results/.gitkeep`; individual result files are
gitignored so they do not accumulate noise in the repo.
