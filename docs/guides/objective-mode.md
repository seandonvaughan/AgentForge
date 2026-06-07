# Objective Mode Operator Guide

Objective mode lets an operator give AgentForge one high-level outcome and have the autonomous loop decompose it into an epic, execute the child work in dependency waves, and review the integrated result against the original objective.

Use this guide when you want to drive an objective end to end instead of letting the cycle planner select work from repository signals or `TODO(autonomous)` markers.

## When to Use Objective Mode

Use objective mode for work that should ship as one coherent feature or repair:

- The work has one operator-owned outcome.
- Multiple child tasks may need dependency ordering.
- The final branch should be reviewed as a whole, not as unrelated sprint items.
- You want planned-vs-actual spend artifacts for later cost calibration.

Use a normal autonomous cycle when you want AgentForge to mine available repository signals and pick the next best work items.

## CLI Command

Run objective mode from the CLI with the objective text and a cycle budget:

```bash
agentforge objective "Build the workspace billing export flow" --budget 150
```

If your installed build exposes the transitional cycle-run surface, use the equivalent flag form:

```bash
agentforge cycle run --objective "Build the workspace billing export flow" --budget 150
```

Common options:

| Option | Purpose |
|---|---|
| `--budget <usd>` | Sets the cycle budget used by the decomposition budget band. |
| `--project-root <path>` | Runs against a specific project root. |
| `--workspace <id>` | Runs against a registered workspace. |
| `--dry-run` | Runs the cycle without opening the final PR. |
| `--no-worktrees` | Disables isolated child worktrees and falls back to single-tree execution. |
| `--resume <cycleId>` | Resumes a checkpointed objective cycle. |

Write objectives as operator outcomes with acceptance criteria and the intended consumer. Good objective text gives the decomposer enough signal to choose child boundaries and file scopes.

## Budget Band Math

Objective mode sizes the child plan from the cycle budget before execution begins:

```text
spendable = (budget − 6) / 1.2
required child-estimate band = 0.7–1.0 × spendable
```

The fixed `$6` reserve covers judgment and gate overhead. Dividing by `1.2` keeps a 20% fix-up reserve. The decomposer must make the sum of `children[].estimatedCostUsd` land inside the band.

Examples:

| Budget | Spendable | Valid child estimate total |
|---:|---:|---:|
| `$30` | `$20.00` | `$14.00–$20.00` |
| `$50` | `$36.67` | `$25.67–$36.67` |
| `$150` | `$120.00` | `$84.00–$120.00` |

If the plan is below the lower bound, the objective is probably under-decomposed or missing required work. If it is above the upper bound, reduce scope, raise the budget, or split the objective into multiple cycles.

## Cycle Artifacts

Objective cycles write the normal cycle files under `.agentforge/cycles/{cycleId}/` plus objective-specific artifacts.

| Artifact | What to inspect |
|---|---|
| `objective.json` | The normalized objective passed into the epic planner, including `budgetUsd` when a budget was provided. |
| `decomposition.json` | The epic plan, child tasks, predecessor graph, waves, validation report, and budget-band result. |
| `plan.json` | The flattened executable child items with `parentEpicId`, `wave`, and `predecessors`. |
| `phases/epic-review.json` | The structured whole-epic review verdict, rationale, and any faulted child items. |
| `spend-report.json` | Planned-vs-actual spend reconciliation, including per-item actuals, overhead, utilization, and total spend. |
| `cycle-ledger.jsonl` | One terminal ledger row used as the calibration feed for later objective-mode estimates. |

Fast checks:

```bash
jq '.validationReport.budget' .agentforge/cycles/{cycleId}/decomposition.json
jq '.perItem' .agentforge/cycles/{cycleId}/spend-report.json
tail -n 1 .agentforge/cycles/{cycleId}/cycle-ledger.jsonl | jq .
```

## Dashboard Pages

Objective mode has an operator path in the dashboard:

- `/objective` starts an objective-mode run and captures the objective text, budget, workspace, and dry-run settings.
- `/cycles` marks objective cycles with an objective/epic badge so they can be distinguished from signal-driven cycles.
- `/cycles/{cycleId}` shows the normal cycle timeline plus objective-specific detail.
- The `Epic` tab shows the objective, decomposition, waves, child dependencies, and final epic review.
- The `Spend` tab shows `spend-report.json`, budget utilization, overhead, and per-child planned-vs-actual spend.
- The verdict card summarizes the final epic review state: approved, request changes, or triage.

Use the dashboard for live supervision and artifact drill-down. Use the JSON files when you need deterministic evidence for post-cycle review or regression analysis.

## End-to-End Operator Flow

1. Draft one concrete objective with acceptance criteria and the consumer that will exercise it.
2. Pick a budget large enough that `(budget − 6) / 1.2` leaves realistic child execution room.
3. Start the run from `/objective` or with `agentforge objective "..."`
4. Watch `/cycles` for the objective badge and open the cycle detail page.
5. Review the `Epic` tab after planning to confirm child scope, waves, and dependencies.
6. Watch execution and fix-up progress from the cycle timeline.
7. Review the verdict card and `phases/epic-review.json` when the gate completes.
8. Inspect the `Spend` tab or `spend-report.json` before approving the PR.
9. Use `cycle-ledger.jsonl` after completion to compare this objective against future estimates.

## Failure Handling

If decomposition fails, inspect `decomposition.json` when present and the plan phase output. Common causes are invalid child dependencies, overlapping file scopes, or estimates outside the budget band.

If the epic review requests changes, inspect `phases/epic-review.json`. Faulted items should name the child item and reason. Objective mode treats the final branch as one feature, so request-changes verdicts should map to missing or broken objective requirements rather than general polish.

If spend exceeds expectations, compare `decomposition.json` estimates with `spend-report.json` actuals. The terminal `cycle-ledger.jsonl` row feeds later calibration, but repeated overruns are a signal to raise budgets, split objectives, or narrow acceptance criteria.
