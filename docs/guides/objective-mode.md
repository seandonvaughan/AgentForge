# Objective Mode — Operator Guide

**Run one directive, get one PR. Objective mode replaces the multi-sprint signal backlog with a single operator-supplied goal that AgentForge decomposes, waves, and executes as a dependency-ordered epic.**

---

## What Is Objective Mode?

A standard `cycle run` harvests `TODO(autonomous)` markers, test failures, and cost anomalies from a *signal backlog* and builds a sprint from them. Objective mode bypasses the backlog entirely: you supply a high-level goal and AgentForge's epic planner (Opus) decomposes it into child work items, orders them by dependency wave, sizes them against your budget, and executes them — all in one cycle that produces one integration PR.

Use objective mode when:

- You have a concrete feature or refactor in mind and want AgentForge to scope and implement it.
- You want a single PR boundary around a coherent feature rather than several backlog-driven sprints.
- You want to control total spend against a fixed dollar target.

---

## Quickstart

### Step 1 — Preview (recommended)

Rehearse the decomposition without running anything. The planner explores the repository, produces a dependency graph, and validates the budget band — for roughly $0.50–$2 of planner spend:

```bash
agentforge cycle preview \
  --objective "Add per-agent cost tracking to the dashboard" \
  --budget-usd 50
```

Output includes:

- Children table (wave, id, title, estimate, assignee)
- Dependency waves with per-wave cost
- File-overlap forced orderings
- Budget band validation `[0.7, 1.0] × spendable`
- Planner cost

Exit code `0` means the decomposition is valid; exit code `1` means the plan is out-of-band or has a dependency cycle — read the detail and retry with a higher/lower budget or a narrower objective.

For machine-readable output:

```bash
agentforge cycle preview \
  --objective "Add per-agent cost tracking to the dashboard" \
  --budget-usd 50 \
  --json
```

### Step 2 — Execute

Once the preview looks right, run the cycle:

```bash
agentforge cycle run \
  --objective "Add per-agent cost tracking to the dashboard" \
  --budget 50
```

The cycle:

1. **Decomposes** the objective into child items via the epic planner.
2. **Waves** children by dependency order (children in the same wave run in parallel).
3. **Executes** each wave in isolated git worktrees.
4. **Reviews** the integration branch with a structured Opus review (`phases/epic-review.json`).
5. **Releases** one PR from the integration branch.

#### All flags

| Flag | Required | Description |
|---|---|---|
| `--objective "<text>"` | yes | The operator directive |
| `--budget <usd>` | recommended | Per-cycle cap in USD (overrides `autonomous.yaml` and `AUTONOMOUS_BUDGET_USD`) |
| `--project-root <path>` | no | Defaults to `cwd` |
| `--workspace <id>` | no | Use a registered workspace instead of project root |
| `--dry-run` | no | Run all phases except PR open |
| `--no-worktrees` | no | Fall back to single-tree execution |
| `--cycle-name <name>` | no | Optional display name for this cycle |
| `--model-cap <tier>` | no | Cap provider model tier: `fable`, `opus`, `sonnet`, `haiku` |
| `--effort-cap <effort>` | no | Cap Codex effort: `low`, `medium`, `high`, `xhigh`, `max` |

---

## Budget Band Math

The planner must size the plan so that the sum of all child `estimatedCostUsd` values falls within a **budget band**. This prevents both wasted cycles (under-sized plans) and blown caps (over-sized plans).

```
spendable = (budget − 6) / 1.2
```

- **`− 6`** reserves $6 for fixed gate/judgment overhead (audit, plan, assign, review, gate, learn phases).
- **`/ 1.2`** reserves a further 20% of the remaining funds as a fix-up buffer for any rework loops.

The valid band for the sum of all child estimates is:

```
0.7 × spendable  ≤  sum(estimatedCostUsd)  ≤  1.0 × spendable
```

**Examples:**

| Budget | Spendable | Band lower | Band upper |
|---|---|---|---|
| $20 | $11.67 | $8.17 | $11.67 |
| $50 | $36.67 | $25.67 | $36.67 |
| $100 | $78.33 | $54.83 | $78.33 |
| $200 | $161.67 | $113.17 | $161.67 |

If the preview reports `OUT OF BAND`, either:

- **Sum too low** — increase `--budget-usd` to give the planner more room, or broaden the objective scope.
- **Sum too high** — reduce `--budget-usd`, or narrow the objective.

---

## Cycle Artifacts

A completed objective cycle writes the following files under `.agentforge/cycles/<cycleId>/`:

### `decomposition.json`

Written by the plan phase. Contains the planner's full `EpicPlan` merged with the `ValidationReport`:

```json
{
  "epicId": "epic-abc123",
  "rationale": "Split into typed schema first, then API, then UI...",
  "children": [
    {
      "id": "child-1",
      "title": "Add CostRecord type and schema",
      "estimatedCostUsd": 3,
      "estimatedComplexity": "low",
      "wave": 0,
      "predecessors": []
    },
    {
      "id": "child-2",
      "title": "Add GET /api/v5/costs/per-agent endpoint",
      "estimatedCostUsd": 8,
      "estimatedComplexity": "medium",
      "wave": 1,
      "predecessors": ["child-1"]
    }
  ],
  "validationReport": {
    "acyclic": true,
    "waveCount": 2,
    "budget": { "budgetUsd": 50, "spendableUsd": 36.67, "sumUsd": 26, "withinBand": true }
  }
}
```

### `phases/epic-review.json`

Written by the review phase (epic path replaces the legacy CEO gate with a single Opus structured review). Contains verdict and per-item findings:

```json
{
  "verdict": "APPROVE",
  "rationale": "All child items implemented correctly...",
  "faultedItems": []
}
```

If verdict is `REQUEST_CHANGES`, `faultedItems` lists the child IDs and reasons that drove the cycle's fix-up loop.

### `spend-report.json`

Written at cycle completion (learn phase). Reconciles planned vs actual cost per item:

```json
{
  "schemaVersion": 1,
  "cycleId": "abc-123",
  "epicId": "epic-abc123",
  "objective": "Add per-agent cost tracking to the dashboard",
  "budgetUsd": 50,
  "totalUsd": 31.42,
  "executionUsd": 26.18,
  "overheadUsd": 5.24,
  "utilization": 0.63,
  "perItem": [
    {
      "itemId": "child-1",
      "title": "Add CostRecord type and schema",
      "plannedUsd": 3,
      "actualUsd": 2.14,
      "status": "completed",
      "estimatedComplexity": "low",
      "estimateAccuracy": 0.71
    }
  ],
  "generatedAt": "2026-06-10T14:22:00Z"
}
```

### `cycle-ledger.jsonl`

Appended for every completed cycle (objective and non-objective alike). One JSON line per cycle. Feeds the cost-priors calibration flywheel so future plans on this repo use observed actuals rather than static estimates:

```jsonl
{"schemaVersion":1,"cycleId":"abc-123","epicId":"epic-abc123","objective":"Add per-agent cost tracking","budgetUsd":50,"totalUsd":31.42,"utilization":0.63,"executionUsd":26.18,"overheadUsd":5.24,"items":{"planned":6,"completed":6,"failed":0},"completedAt":"2026-06-10T14:22:00Z"}
```

---

## Preview Artifacts

`cycle preview --objective` writes its artifacts under **`.agentforge/previews/objective-<ts>/`** (never under `.agentforge/cycles/`):

| File | Contents |
|---|---|
| `objective.json` | The `EpicObjective` record (id, title, description, budgetUsd) |
| `decomposition.json` | The `EpicPlan` + `ValidationReport` (same schema as the cycle artifact above) |
| `preview.json` | Full `PreviewObjectiveResult` including waves, warnings, planner cost |

These are never read by `cycle list` — they are preview-only and do not create phantom cycles.

---

## Dashboard Surfaces

### Cycles list page (`/cycles`)

Objective previews appear in a dedicated **Rehearsals** section on the cycles page, labelled with the objective text. This is distinct from the active cycles list and carries a badge indicating the preview was run via `cycle preview --objective`.

### Cycle detail page (`/cycles/<id>`)

An objective cycle's detail page shows:

- **Epic tab** — the children table from `decomposition.json`: wave, dependency arrows, status, estimated vs actual cost per child.
- **Spend tab** — the `spend-report.json` reconciliation: planned vs actual per item, overhead breakdown, overall budget utilization.
- **Verdict card** — the epic-review verdict (`APPROVE` / `REQUEST_CHANGES`) from `phases/epic-review.json`, with the `faultedItems` list when the review requested changes.

---

## End-to-End Example

```bash
# 1. Preview — cheap rehearsal, ~$1 planner spend
agentforge cycle preview \
  --objective "Instrument every API route with OpenTelemetry spans and expose a /metrics endpoint" \
  --budget-usd 80

# Output (truncated):
# Epic:         epic-preview-x4a9 — Instrument every API route...
# Budget:       $80.00 (spendable $61.67)
# Plan cost:    $48.50 — band [$43.17, $61.67] OK
# Children:     7  Waves: 3  Critical path: 3  Max wave width: 3
# ...

# 2. Execute — full cycle, one PR
agentforge cycle run \
  --objective "Instrument every API route with OpenTelemetry spans and expose a /metrics endpoint" \
  --budget 80

# 3. Check artifacts
cat .agentforge/cycles/<cycleId>/spend-report.json | jq '.utilization'
cat .agentforge/cycles/<cycleId>/phases/epic-review.json | jq '.verdict'
```

---

## Troubleshooting

### `INVALID (budget): sum out of band`

The planner's child estimates don't fit within `[0.7, 1.0] × spendable`. Either broaden the objective or increase `--budget-usd` so the planner has room to fill the band.

### `INVALID (cycle): …`

The planner produced a dependency graph with a cycle (A depends on B which depends on A). The repair retry failed. Try rephrasing the objective to make the ordering explicit.

### `INVALID (missing-predecessors): …`

A child references a predecessor that isn't in the plan. Re-run the preview — the planner will usually self-correct on retry.

### Plan repairs a lot / `repaired: true`

The first planner attempt produced an invalid plan (cycle, missing predecessor, or out-of-band) and a repair retry was issued. This adds ~$0.30–$1 to the planner cost. If this happens repeatedly, try a more specific objective.

### The preview exits 0 but the cycle fails in execution

The preview validates the *plan* but not the implementation. If child items fail, check `phases/execute.json` for per-item errors and `spend-report.json` for which children didn't complete.

### The epic review requests changes

If `phases/epic-review.json` has `verdict: "REQUEST_CHANGES"`, the cycle runner issues a fix-up loop targeting the `faultedItems`. If fix-up loops are exhausted, the cycle finishes in a `rejected` stage. Review the `faultedItems` reasoning to understand what the reviewer expected.

---

## Related Documentation

- **[Autonomous Loop Guide](./autonomous-loop.md)** — The standard signal-backlog cycle (no `--objective`)
- **[Configuration Reference](./autonomous-config-reference.md)** — `autonomous.yaml` options including `budget.perCycleUsd`
- **[Troubleshooting](./autonomous-troubleshooting.md)** — General cycle failure diagnosis
- **[API Reference](../api-reference.md)** — `GET /api/v5/cycles/:id` and `GET /api/v5/previews`

---

**Last updated:** 2026-06-10
