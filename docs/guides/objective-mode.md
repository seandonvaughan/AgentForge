# Objective Mode Operator Guide

Objective mode runs one high-level operator objective as an epic. Instead of
selecting work from `TODO(autonomous)` markers or backlog signals, AgentForge
decomposes the objective into dependency-ordered child work items, executes them
in isolated worktrees, integrates them onto one branch, and reviews the whole
feature against the original objective.

Use objective mode when the desired outcome is larger than a single backlog
item but still concrete enough for an operator to judge. Keep the objective
specific: name the user-visible behavior, important files or subsystems, and
the acceptance checks that prove completion.

## CLI Command

Run objective mode from the package CLI:

```bash
agentforge cycle run \
  --project-root /path/to/project \
  --objective "Ship the operator guide for objective mode and document the dashboard review flow" \
  --budget 50
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--objective <text>` | Enables objective mode and provides the epic objective. |
| `--budget <usd>` | Sets the per-cycle budget for this run. Overrides `AUTONOMOUS_BUDGET_USD` and `.agentforge/autonomous.yaml`. |
| `--dry-run` | Runs the cycle without opening the final PR. |
| `--project-root <path>` | Runs against a specific project root. |
| `--workspace <id>` | Runs against a registered workspace. |
| `--max-agents <count>` | Caps execute-phase parallelism. |
| `--model-cap <tier>` | Caps model tier: `opus`, `sonnet`, or `haiku`. |
| `--effort-cap <effort>` | Caps effort: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--resume <cycleId>` | Resumes a checkpointed cycle. |

`agentforge autonomous:cycle` remains a compatibility alias for `cycle run`, but
operators should prefer `agentforge cycle run`.

## Budget Band Math

Objective mode treats the operator budget as the cycle's total ceiling, not as
the amount the child tasks may spend. The planner first reserves fixed judgment
overhead and a fix-up buffer:

```text
spendable = (budget - 6) / 1.2
```

Then it requires the sum of child `estimatedCostUsd` values to land in the
0.7–1.0 × spendable band:

```text
lower bound = 0.7 x spendable
upper bound = 1.0 x spendable
```

In implementation, spendable never goes below zero. For a $50 objective cycle:

```text
spendable = (50 - 6) / 1.2 = 36.67
target band = 25.67 to 36.67
```

Operator guidance:

| Budget | Spendable | Child estimate band |
| --- | ---: | ---: |
| `$20` | `$11.67` | `$8.17` to `$11.67` |
| `$30` | `$20.00` | `$14.00` to `$20.00` |
| `$50` | `$36.67` | `$25.67` to `$36.67` |
| `$100` | `$78.33` | `$54.83` to `$78.33` |

If decomposition fails with a budget error, either raise `--budget` or narrow
the objective. Do not work around the band by using a vague objective; that
usually produces poorer child boundaries and more review churn.

## What Happens During The Cycle

Objective mode changes the planning path:

1. The audit phase records a deterministic objective digest instead of spending
   an LLM audit on backlog discovery.
2. The plan phase sends the objective to the epic planner.
3. The epic planner writes dependency-ordered children with declared files,
   assignees, estimated cost, complexity, and predecessors.
4. The execute phase runs children in worktrees and respects dependency waves.
5. The test phase uses deterministic verification as the release authority.
6. The gate phase runs one epic review against the integrated branch instead of
   reviewing each child in isolation.
7. The release phase creates one PR for the integrated objective.
8. The learn phase records cycle lessons and terminal spend artifacts.

Signal cycles without `--objective` keep the regular backlog path.

## Artifacts To Inspect

Cycle artifacts are written under `.agentforge/cycles/{cycleId}/`. The most
important objective-mode artifacts are:

| Artifact | Path | Use |
| --- | --- | --- |
| Objective snapshot | `.agentforge/cycles/{cycleId}/objective.json` | Confirms the exact operator objective and budget threaded into planning. |
| Decomposition | `.agentforge/cycles/{cycleId}/decomposition.json` | Shows the epic children, predecessor graph, waves, declared file contracts, and validation report. |
| Plan | `.agentforge/cycles/{cycleId}/plan.json` | Shows the flattened child items that execute phase consumes. |
| Epic review | `.agentforge/cycles/{cycleId}/phases/epic-review.json` | Records the whole-branch review verdict, rationale, and any faulted child items. |
| Legacy gate | `.agentforge/cycles/{cycleId}/phases/gate.json` | Preserves the dashboard-compatible gate verdict. |
| Spend report | `.agentforge/cycles/{cycleId}/spend-report.json` | Reconciles planned child spend with actual execution and overhead spend. |
| Cycle ledger | `.agentforge/memory/cycle-ledger.jsonl` | Appends one terminal row per completed cycle for future cost calibration. |

`decomposition.json` is the first artifact to inspect when an objective cycle
does surprising work. Check that each child has a specific title, acceptance
criteria in the description, a complete `files[]` list, and valid predecessors.

`epic-review.json` is the first artifact to inspect when the gate rejects. In
objective mode, actionable rework comes from `faultedItems`; each fault should
name the child item, relevant files, and the reason it failed the objective.

`spend-report.json` is the first artifact to inspect after completion. Compare:

- `budgetUsd`: the operator ceiling for the whole cycle.
- `totalUsd`: execution plus overhead.
- `executionUsd`: execute-phase spend.
- `overheadUsd`: audit, plan, assign, test, review, and gate spend.
- `perItem[].plannedUsd` vs `perItem[].actualUsd`: planner calibration signal.

The cycle ledger is append-only JSONL. It feeds future planner prompts with
observed child costs from prior completed cycles in the same repository.

## Dashboard Pages

Use the CLI to launch objective mode. The current dashboard launch page exposes
cycle budget and runtime controls, but the objective text is a CLI-only launch
input.

After launch, use these dashboard pages:

| Page | Use |
| --- | --- |
| `/cycles` | Monitor all cycles, filter active or failed runs, compare completed cycles, and spot cost or duration outliers. |
| `/cycles/{cycleId}` | Watch the active phase rail, item table, agents tab, events stream, files/logs tabs, PR tab, and resume/rerun/cancel actions. |
| `/cost` | Review spend by time window, model tier, agent, and top expensive cycles. |
| `/cycles/new` | Launch regular autonomous cycles and inspect recent cycle estimates; use CLI for objective-mode launches. |

For a running objective cycle, keep `/cycles/{cycleId}` open. The cycle detail
page streams events, shows the current stage, surfaces cost against budget, and
links PR and log artifacts when they become available.

## Operator Checklist

Before launch:

- Write an objective with a concrete outcome and acceptance checks.
- Choose a budget whose child estimate band can cover the intended work.
- Make sure the working tree is ready for autonomous execution.
- Prefer keeping worktrees enabled; objective mode uses them to isolate child
  execution and release one integrated PR.

During launch:

- Record the printed `cycleId` and `logDir`.
- Open `/cycles/{cycleId}` in the dashboard.
- Watch early plan events for decomposition or budget-band failures.

After completion:

- Review the PR as one integrated feature against the original objective.
- Inspect `decomposition.json` for child boundaries and dependency quality.
- Inspect `epic-review.json` if the gate requested changes.
- Inspect `spend-report.json` and the ledger row when tuning future budgets.
