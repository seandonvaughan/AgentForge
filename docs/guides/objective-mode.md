# Objective Mode

**Run a single natural-language objective end-to-end — decompose it into dependency-ordered work items, execute them as a cycle, review the integration branch as one coherent feature, and open a PR — all under an explicit budget cap.**

Objective mode replaces the legacy multi-cycle sprint loop for well-scoped work. You describe _what_ you want done; AgentForge figures out _how_ to divide it.

---

## Quick Start

```bash
agentforge objective "Add Prometheus metrics to the API server" --budget 30
```

That single command:
1. Decomposes the objective into dependency-ordered work items (waves).
2. Runs the full 9-phase autonomous cycle with those items.
3. Reviews the integration branch as one coherent feature.
4. Opens a pull request.

---

## CLI Reference

```
agentforge objective "<text>" --budget <usd> [--project-root <path>]
```

| Option | Required | Default | Description |
|---|---|---|---|
| `<text>` | Yes | — | Natural-language objective to decompose and execute |
| `--budget <usd>` | **Yes** | — | Per-cycle budget cap in USD. No unlimited runs. |
| `--project-root <path>` | No | `process.cwd()` | Project root AgentForge will operate in |

**`--budget` is always required.** Every objective run must have an explicit dollar ceiling. Non-positive and non-numeric values are rejected before any delegation takes place (exit code 1).

The command is a thin alias for `cycle run --objective <text> --budget <usd> --project-root <path>`. All cycle launch controls, worktree isolation, and budget enforcement are inherited automatically.

---

## Budget Band Math

AgentForge enforces a two-level budget constraint on every objective run.

### Spendable amount

```
spendable = (budget − 6) / 1.2
```

- **`$6` fixed overhead** — reserved for judgment/gate phases (plan, audit, review, gate).
- **`/ 1.2`** — reserves an additional 20% of the remainder as a fix-up buffer; the epic-review gate may request changes, and the fix-up loop needs headroom.

For a `--budget 30` run:

```
spendable = (30 − 6) / 1.2 = $20.00
```

### Budget band

The `epic-planner` agent must produce a decomposition whose children's `estimatedCostUsd` values sum inside this window:

```
lower = 0.7 × spendable   (fill at least 70% to avoid wasted cycles)
upper = 1.0 × spendable   (never blow the cap)
```

For `--budget 30` → spendable `$20.00` → band `[$14.00, $20.00]`.

A plan that falls outside the band is rejected with one automatic repair retry. If the repaired plan still misses, the cycle fails loudly — never silently.

> **Iron law:** budget enforcement runs before dispatch, not after. The system always fails-closed.

### Calibrated cost table

The planner uses a re-fit cost table (2026-06-06) based on measured epic cycles:

| Item type | Estimated cost | Typical wall-clock |
|---|---|---|
| small (tests / wiring / docs) | ~$1.50 | ~2 min |
| medium (one module + its tests) | ~$3.50 | ~8 min |
| feature-child (multi-file + tests) | $5–12 | 20–40 min |

Observed actuals from prior cycles in the same repo automatically surface alongside this table and take precedence over the static estimates — the cost model improves each run.

---

## How It Works: The Decomposition Step

Before any agents execute work, the `epic-planner` agent (Opus) decomposes the objective:

1. **Explores the repository** with read-only tools (`Read`, `Glob`, `Grep`) to ground every declared file path.
2. **Emits an `EpicPlan`** — a JSON object containing `epicId`, `rationale`, and `children[]` each with `id`, `title`, `description`, `files[]`, `estimatedCostUsd`, `estimatedComplexity`, and `predecessors[]`.
3. **Wave-layering** — the predecessor graph is topologically sorted into sequential waves. Items within the same wave can execute in parallel; items in later waves wait for prior waves.
4. **Scope contract** — each child may only edit files it declares in `files[]`. A deterministic verifier auto-fails any child that touches an undeclared file. Shared barrel/index files must be routed to a dedicated integration child at the end of the plan, not split across parallel children.

---

## Artifacts

Every objective run writes to `.agentforge/cycles/<cycleId>/`:

| File | Description |
|---|---|
| `objective.json` | Objective metadata: id, title, description, budgetUsd, createdAt |
| `decomposition.json` | Full EpicPlan (all children with wave assignments) + validation report |
| `phases/epic-review.json` | Structured gate verdict: `verdict` (APPROVE/REQUEST_CHANGES), `rationale`, `faultedItems[]` |
| `spend-report.json` | Per-item planned vs actual cost + rolled-up totals and utilization % |

Additionally, one row is appended to `.agentforge/memory/cycle-ledger.jsonl` for every completed run. This file is the calibration feed: future plan phases read it to surface repo-specific observed costs alongside the static cost table.

### `decomposition.json` shape

```json
{
  "epicId": "epic-abc123",
  "rationale": "Split into infrastructure, implementation, and integration waves.",
  "children": [
    {
      "id": "child-1",
      "title": "Bootstrap Prometheus client",
      "files": ["packages/server/src/metrics.ts"],
      "estimatedCostUsd": 3.5,
      "estimatedComplexity": "medium",
      "predecessors": [],
      "wave": 0
    },
    {
      "id": "child-2",
      "title": "Instrument API routes",
      "files": ["packages/server/src/routes/v5/index.ts"],
      "estimatedCostUsd": 5.0,
      "estimatedComplexity": "medium",
      "predecessors": ["child-1"],
      "wave": 1
    }
  ],
  "validationReport": { "ok": true, "waveCount": 2 }
}
```

### `spend-report.json` shape

```json
{
  "schemaVersion": 1,
  "cycleId": "abc123",
  "budgetUsd": 30,
  "totalUsd": 18.40,
  "executionUsd": 14.20,
  "overheadUsd": 4.20,
  "utilization": 0.61,
  "perItem": [
    { "itemId": "child-1", "title": "Bootstrap Prometheus client", "plannedUsd": 3.5, "actualUsd": 2.9, "status": "completed" },
    { "itemId": "child-2", "title": "Instrument API routes",       "plannedUsd": 5.0, "actualUsd": 6.1, "status": "completed" }
  ],
  "generatedAt": "2026-06-08T14:00:00.000Z"
}
```

### `cycle-ledger.jsonl` row

```json
{"schemaVersion":1,"cycleId":"abc123","epicId":"epic-abc123","objective":"Add Prometheus metrics","budgetUsd":30,"totalUsd":18.40,"utilization":0.61,"executionUsd":14.20,"overheadUsd":4.20,"items":{"planned":2,"completed":2,"failed":0},"completedAt":"2026-06-08T14:05:00.000Z"}
```

---

## Epic Review Gate

On the objective path the standard CEO gate is replaced by a structured **epic review**. A strong model (Opus) reviews the entire integration branch as one coherent feature:

- Verdict `APPROVE` — all items met acceptance criteria; the cycle proceeds to release.
- Verdict `REQUEST_CHANGES` — one or more items have blocking defects. The `faultedItems[]` list identifies exactly which items need re-work; the cycle re-runs those items only.
- Verdict `TRIAGE` (parse-failure fallback) — the model could not produce parseable JSON after one re-ask. The VERIFY (test) stage remains the release authority; the cycle proceeds with an `APPROVED` outcome.

A failing epic review is **non-negotiable**. The verdict is never silently downgraded to keep the cycle running.

---

## Dashboard Surfaces

The following surfaces expose objective-mode data in the operator UI at `http://localhost:4751`:

| Surface | Location | What it shows |
|---|---|---|
| **`/objective`** | Top-level page | Launch objective runs, enter objective text and budget, monitor active runs |
| **Epic tab** | `/cycles/:id` detail page | Wave viewer: decomposition waves, per-child status, scope contract (declared files) |
| **Spend tab** | `/cycles/:id` detail page | `spend-report.json` visualization: per-item planned vs actual, totals, utilization ring |
| **Epic-review verdict card** | `/cycles/:id` overview tab | Shows APPROVE/REQUEST_CHANGES verdict, rationale, and faulted item IDs when `phases/epic-review.json` is present |
| **Epic badge** | `/cycles` list | Purple badge on cycles that ran in objective mode (`objective` field set on cycle) |

---

## Folder Structure After a Run

```
.agentforge/
  cycles/
    <cycleId>/
      objective.json            Objective metadata
      decomposition.json        EpicPlan + wave layers
      plan.json                 Sprint plan (items overwritten from decomposition)
      spend-report.json         Planned vs actual cost per item
      phases/
        epic-review.json        Gate verdict (APPROVE / REQUEST_CHANGES)
        plan.json               Plan-phase cost
        execute.json            Per-item execution results
        ...                     Other phase artifacts
  memory/
    cycle-ledger.jsonl          One row per completed cycle (calibration feed)
```

---

## Configuration

Objective mode inherits all `.agentforge/autonomous.yaml` settings. The only extra requirement is `--budget` on the CLI (or `budgetUsd` in the `POST /api/v5/objective` body).

Key settings that interact with objective runs:

```yaml
budget:
  perCycleUsd: 30           # Overridden by --budget on the CLI
  allowOverageApproval: true  # Objective runs never prompt for overage approval;
                              # the band math prevents overages before dispatch

limits:
  maxItemsPerSprint: 10     # The decomposer fills the band with children, up to this limit

quality:
  testPassRateFloor: 0.95   # Applied per-wave after the execute phase
```

---

## Troubleshooting

### DecomposeError: budget band violation after repair

The planner produced a cost sum outside `[0.7×spendable, 1.0×spendable]` on both the initial attempt and the single repair retry.

**Fix:** Increase `--budget` by $5–10 to give the planner more headroom, or narrow the objective text to reduce the number of children the planner wants to emit.

### DecomposeError: cycle in predecessor graph

The planner's dependency graph contains a cycle (A depends on B, B depends on A).

**Fix:** This is a retry-safe error — the system issues one automatic repair prompt. If it happens repeatedly on the same objective, simplify the objective text so the planner needs fewer inter-dependencies.

### Epic review REQUEST_CHANGES on every run

The gate keeps finding the same faulted items.

**Fix:**
1. Inspect `phases/epic-review.json` for the `faultedItems[].reason` field.
2. Check whether the failing item's test coverage matches its `description` acceptance criteria.
3. If the criteria are too strict, narrow the objective text before re-running.

### High overhead utilization (>30%)

Overhead phases (audit, plan, review, gate) are consuming a large fraction of the budget.

**Fix:** Use a larger `--budget`. Overhead is roughly $6 fixed cost regardless of run size; on small budgets this dominates. Minimum practical budget is ~$15.

---

## See Also

- [Autonomous Loop Guide](./autonomous-loop.md) — 9-phase cycle internals
- [Configuration Reference](./autonomous-config-reference.md) — all `autonomous.yaml` options
- [API Reference](../api-reference.md) — `POST /api/v5/objective` endpoint
- [Troubleshooting](./autonomous-troubleshooting.md) — common cycle failure modes
