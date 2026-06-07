# Objective Mode

**Audience:** operators running a single high-level objective through AgentForge and watching it land as one pull request.

Objective mode turns one plain-English objective into a dependency-ordered **epic**: AgentForge decomposes the objective into child work items, sizes the plan to the money you give it, runs the children (in waves, in isolated worktrees), reviews the whole integration branch as a single coherent feature, and opens **one** PR. It replaces the signal-backlog audit phase and the legacy CEO gate with a budget-aware decomposer and a structured epic review.

Use objective mode when you have a concrete outcome in mind ("add a `/healthz` route and wire it into the status line") rather than letting the cycle pick work from its own signal backlog.

---

## Running an objective cycle

There is no separate top-level `objective` command — objective mode is the `--objective` flag on a normal cycle run:

```bash
agentforge cycle run \
  --objective "Add a /healthz route and surface its status in the dashboard status line" \
  --budget 30 \
  --project-root /path/to/your-project
```

The compatibility alias accepts the same flags:

```bash
agentforge autonomous:cycle --objective "..." --budget 30
```

Key flags:

| Flag | Purpose |
|---|---|
| `--objective <text>` | Decompose this high-level objective into a dependency-ordered epic instead of running the signal backlog. A non-empty value is what switches the cycle into objective mode. |
| `--budget <usd>` | Per-cycle budget in USD. Drives the spendable-band math below. Overrides `AUTONOMOUS_BUDGET_USD` and `budget.perCycleUsd` in `.agentforge/autonomous.yaml`. |
| `--project-root <path>` | Project to run against (defaults to the current directory). |
| `--dry-run` | Run every stage except opening the PR. |

When `--objective` is set, the cycle runs its children in isolated git worktrees and releases them as one epic integration branch — the same worktree-pool path used by multi-PR mode.

---

## Budget band math

The decomposer sizes the plan to **fill the money it is given** — neither leaving budget on the table nor blowing the cap. Two numbers govern this.

**Spendable** is what the plan's children may sum to, after carving out judgment overhead and a fix-up reserve:

```
spendable = (budget − 6) / 1.2
```

- The fixed **$6** is gate/judgment overhead (decomposition + epic review).
- Dividing by **1.2** reserves **20%** of the remaining funds for fix-up work after review.
- Spendable is clamped to a non-negative number, so a budget at or below $6 yields `spendable = 0`.

**The band.** The sum of every child's `estimatedCostUsd` must land inside:

```
[ 0.7 × spendable ,  1.0 × spendable ]
```

An undersized plan (below `0.7 × spendable`) wastes the cycle; an oversized plan (above `1.0 × spendable`) would blow the cap. The planner is told to fill the band with **scope** — more independent children — never by inflating per-child estimates.

**Worked example** (`--budget 30`):

| Quantity | Value |
|---|---|
| Budget | $30.00 |
| Spendable `(30 − 6) / 1.2` | $20.00 |
| Lower bound `0.7 × 20` | $14.00 |
| Upper bound `1.0 × 20` | $20.00 |

So the child `estimatedCostUsd` sum must land between **$14.00 and $20.00**.

**Enforcement.** The band is checked deterministically after decomposition. If the plan falls outside the band, AgentForge issues exactly **one repair retry** with the band restated; if the second attempt is still outside the band, the cycle fails loudly with a `budget` decomposition error rather than silently overspending. Per-repo calibration improves estimates over time: prior cycles' `spend-report.json` actuals are surfaced to the planner alongside the static cost table.

---

## Artifacts

Objective cycles write the following artifacts. Per-cycle files live under `.agentforge/cycles/<cycle-id>/`; the ledger is appended to the workspace memory feed.

| Artifact | Path | What it contains |
|---|---|---|
| `decomposition.json` | `.agentforge/cycles/<id>/decomposition.json` | The wave-layered `EpicPlan` — `epicId`, `rationale`, and `children[]` (each with `id`, `title`, `description`, `files[]`, `capabilityTags[]`, `suggestedAssignee`, `estimatedCostUsd`, `estimatedComplexity`, `predecessors[]`, computed `wave`) — plus the embedded `validationReport` (acyclicity, synthetic file-overlap edges, wave count, and the budget band report). A sibling `objective.json` records the raw objective. |
| `epic-review.json` | `.agentforge/cycles/<id>/phases/epic-review.json` | The structured verdict from reviewing the whole integration branch as one feature: `verdict` (`APPROVE` or `REQUEST_CHANGES`), `rationale`, and `faultedItems[]` (each `{ itemId, reason, files[] }`). `REQUEST_CHANGES` drives the funded fix-up loop, routing the re-run to precisely the faulted plan items. |
| `spend-report.json` | `.agentforge/cycles/<id>/spend-report.json` | Planned-vs-actual reconciliation: `budgetUsd`, `totalUsd`, `executionUsd` (the execute phase), `overheadUsd` (audit + plan + assign + test + review + gate), `utilization` (`totalUsd / budgetUsd`), and `perItem[]` (`{ itemId, title, plannedUsd, actualUsd, status }`). Also rendered as a `### Spend report` table appended to the epic PR body. |
| `cycle-ledger.jsonl` | `.agentforge/memory/cycle-ledger.jsonl` | One JSON row per **completed** cycle (objective or signal): `cycleId`, `epicId`, `objective`, `budgetUsd`, `totalUsd`, `utilization`, `executionUsd`, `overheadUsd`, `prUrl`/`prNumber`, `gateVerdict`, `items` counts, and `completedAt`. This is the calibration feed future plans read to refine cost estimates. |

All artifact writes are best-effort and never fail a cycle that otherwise passed.

### Epic review vs. the legacy gate

On the objective path the legacy CEO gate is replaced by **one** strong-model (Opus) structured review of the full integration branch. The verdict is requested as structured JSON, so a parse failure never auto-rejects — when the model cannot return parseable JSON even after a cheap re-ask, AgentForge emits a `TRIAGE` verdict and approves, leaving the deterministic VERIFY stage as the executable release authority.

---

## Dashboard surfaces

The operator UI (`http://localhost:4751`) surfaces objective cycles through the artifacts above:

- **`/objective`** — the entry point for objective cycles: the decomposed epic (children, waves, and the dependency graph) read from `decomposition.json`, alongside the budget band (spendable, lower/upper bounds, and the planned cost sum) so you can see at a glance whether the plan filled the money it was given.
- **Epic** surface — the wave-by-wave execution view of the integration branch: per-child status, the epic review verdict and `faultedItems` from `epic-review.json`, and any funded fix-up rounds.
- **Spend** surface — the planned-vs-actual breakdown from `spend-report.json`: per-item planned/actual/status, execution vs. overhead split, and the budget-utilization figure, with historical utilization drawn from `cycle-ledger.jsonl`.

---

## Related docs

- [Autonomous Loop Guide](./autonomous-loop.md) — the 9-phase cycle objective mode builds on.
- [Configuration Reference](./autonomous-config-reference.md) — all `.agentforge/autonomous.yaml` options, including `budget.perCycleUsd`.
- [Troubleshooting](./autonomous-troubleshooting.md) — recovering stalled or over-budget cycles.
