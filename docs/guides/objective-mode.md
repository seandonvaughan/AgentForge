# Objective Mode

Objective mode turns a single high-level objective into one dependency-ordered
epic, executes its children, and ships the result as **one pull request** under a
hard budget cap. It replaces the signal-backlog ("crumb") cycle for focused,
operator-directed work: you describe the outcome, AgentForge decomposes it,
spends against an explicit band, and reports exactly where the money went.

- **Claude provides judgment** — decomposition, epic review, and gating.
- **Codex provides execution** — the child items run in isolated worktrees.
- **One objective → one epic → one PR.**

## Running an objective cycle

Objective mode is the `--objective` path of `agentforge cycle run`. Pass the
objective text and a budget:

```bash
agentforge cycle run \
  --objective "Add OAuth2 device-code login to the CLI" \
  --budget 30 \
  --project-root /path/to/your-project
```

| Flag | Purpose |
|---|---|
| `--objective <text>` | Decompose this high-level objective into a dependency-ordered epic instead of mining the signal backlog. |
| `--budget <usd>` | Per-cycle budget in USD. Overrides `AUTONOMOUS_BUDGET_USD` and `autonomous.yaml`. Drives the spend band (below). |
| `--project-root <path>` | Project to operate on (defaults to the current directory). |
| `--model-cap <tier>` | Cap the Codex model tier: `opus`, `sonnet`, or `haiku`. |
| `--effort-cap <effort>` | Cap Codex effort: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--max-agents <count>` | Override execute-phase parallelism. Objective children run in worktrees just like multi-PR mode. |

Preview the decomposition and estimated spend without executing:

```bash
agentforge cycle preview --objective "..." --budget 30
```

## Budget band math

The budget is **not** spent end-to-end on execution. AgentForge reserves a fixed
slice for Claude's judgment (decomposition, review, gating) and a proportional
fix-up reserve, then requires the planned epic to land inside a spend band. The
band keeps the planner from both under-using the budget (timid epics) and
over-committing (cycle `11955f95` once planned $38 against a $30 budget).

```
spendable = max(0, (budget − 6) / 1.2)

  −6    fixed judgment overhead (decomposition + epic review + gate)
  ÷1.2  20% fix-up reserve for gate-driven retries

band:  lower = 0.7 × spendable
       upper = 1.0 × spendable
```

The sum of the children's `estimatedCostUsd` must land within
`[0.7 × spendable, 1.0 × spendable]`. A plan outside the band is rejected and the
decomposer is asked to repair it.

**Worked example — `--budget 30`:**

```
spendable = (30 − 6) / 1.2 = $20.00
band      = $14.00 (0.7×) … $20.00 (1.0×)
```

So a $30 objective cycle expects the planned epic children to sum between $14 and
$20 of estimated execution cost; the remaining ~$10 covers judgment overhead and
the fix-up reserve.

**Worked example — `--budget 12.5`:**

```
spendable = (12.5 − 6) / 1.2 = $5.42
band      = $3.79 … $5.42
```

## Artifacts

Every objective cycle writes a durable audit trail under
`.agentforge/cycles/<cycleId>/` (plus one append-only ledger row under
`.agentforge/memory/`):

| Artifact | Path | What it records |
|---|---|---|
| `decomposition.json` | `.agentforge/cycles/<cycleId>/decomposition.json` | The full epic plan: children, dependency edges, wave layering, and the validation report (acyclic check, synthetic file-overlap edges, wave count). |
| `epic-review.json` | `.agentforge/cycles/<cycleId>/phases/epic-review.json` | Claude's epic-review verdict that replaces the legacy CEO gate: `verdict`, `rationale`, and the exact `faultedItems` (item ids, files, findings) used to build retry context. |
| `spend-report.json` | `.agentforge/cycles/<cycleId>/spend-report.json` | Per-item planned-vs-actual spend, totals split into execution vs overhead, and budget utilization. Also rendered into the PR body as a `### Spend report` table. |
| `cycle-ledger.jsonl` | `.agentforge/memory/cycle-ledger.jsonl` | One append-only JSON line per cycle (objective, budget, total/execution/overhead spend, utilization, PR url/number, gate verdict, item counts). This is the calibration feed for future plan-phase cost estimates. |

All four writers are best-effort and never throw: a write failure degrades the
audit trail but never fails the cycle.

## Dashboard

The operator UI surfaces objective cycles at **`/objective`** (http://localhost:4751/objective):

- **Epic tab** — renders `decomposition.json`: the child items, their dependency
  waves, and per-item cost estimates.
- **Spend tab** — renders `spend-report.json`: the planned-vs-actual table,
  execution/overhead split, and the budget-utilization ring.
- **Verdict card** — surfaces the `epic-review.json` verdict (pass/fail),
  rationale, and any faulted items that triggered a retry.

## Related docs

- [Autonomous Loop Guide](autonomous-loop.md) — the 9-phase cycle internals.
- [Configuration Reference](autonomous-config-reference.md) — every `autonomous.yaml` option, including `budget`.
- [Troubleshooting](autonomous-troubleshooting.md) — common failure modes.
