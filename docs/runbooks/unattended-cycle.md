# Unattended Cycle Runbook

This runbook covers operating `agentforge cycle run` in unattended mode (`AGENTFORGE_UNATTENDED=1`), introduced in Wave 5 (T5). Unattended mode activates five pre-flight guards that block the cycle from starting when unsafe conditions are detected.

---

## Pre-flight checklist

All five guards must pass before the cycle enters the `plan` phase. Guards are evaluated in order; the first failure aborts with a non-zero exit code and a human-readable message.

| # | Guard | Pass condition | Env override |
|---|-------|----------------|--------------|
| 1 | **Budget headroom** | Remaining budget ≥ 20 % of `perCycleUsd` | `AGENTFORGE_SKIP_BUDGET_GUARD=1` (not recommended) |
| 2 | **Clean working tree** | `git status --porcelain` returns empty | Commit or stash changes before running |
| 3 | **Test baseline** | Last recorded test-pass rate ≥ `quality.testPassRateFloor` (default 0.95) | `AGENTFORGE_SKIP_TEST_GUARD=1` |
| 4 | **No stale checkpoints** | No per-item checkpoint older than 72 h in `.agentforge/cycles/<id>/checkpoints/` | Delete stale files or use `--resume` |
| 5 | **Disk space** | Available disk ≥ 500 MB on the workspace volume | Free disk before running |

---

## How to invoke

### Standard unattended run

```bash
export AGENTFORGE_UNATTENDED=1
export AGENTFORGE_RUNTIME=sdk          # or auto
export ANTHROPIC_API_KEY=sk-...

agentforge cycle run --project-root /path/to/your-project
```

### With explicit budget cap

```bash
AGENTFORGE_UNATTENDED=1 agentforge cycle run \
  --project-root /path/to/your-project \
  --budget-usd 20
```

### Dry run (pre-flight only, no LLM calls)

```bash
AGENTFORGE_UNATTENDED=1 agentforge cycle run --dry-run
```

---

## What to do when a guard fails

### Guard 1 — Budget headroom

Check current spend:

```bash
agentforge costs report
```

Wait for the billing window to reset, or increase `budget.perCycleUsd` in `.agentforge/autonomous.yaml`.

### Guard 2 — Clean working tree

```bash
git status
git stash        # or git add -A && git commit -m "wip: pre-cycle save"
```

### Guard 3 — Test baseline

Run the test suite locally and fix failures before proceeding:

```bash
pnpm test
```

If the baseline file is stale (tests pass but the recorded rate is old), force a refresh:

```bash
agentforge cycle run --refresh-test-baseline --dry-run
```

### Guard 4 — Stale checkpoints

List stale checkpoints:

```bash
ls -lh .agentforge/cycles/*/checkpoints/
```

To resume from an existing checkpoint set rather than abort:

```bash
agentforge cycle run --resume <cycle-id>
```

To discard stale checkpoints and start fresh:

```bash
rm -rf .agentforge/cycles/<cycle-id>/checkpoints/
agentforge cycle run
```

### Guard 5 — Disk space

```bash
df -h .
```

Delete old cycle artifacts or build outputs:

```bash
rm -rf .agentforge/cycles/<old-cycle-id>
pnpm build --clean
```

---

## Using `--resume` with stale checkpoints

`--resume <cycle-id>` re-enters an existing cycle at the last completed item checkpoint. Guard 4 is relaxed to a warning (not a block) when `--resume` is provided, because the intent is explicitly to continue from stale state.

```bash
agentforge cycle run --resume abc123 --project-root /path/to/your-project
```

Checkpoint files live at:

```
.agentforge/cycles/<cycle-id>/checkpoints/<item-id>.json
```

Each checkpoint records `phase`, `completedAt`, `status`, and `outputs`. A cycle resumes from the first item whose checkpoint is missing or has `status !== "done"`.

---

## Related

- [Autonomous Loop Guide](../guides/autonomous-loop.md) — full 9-phase internals
- [Configuration Reference](../guides/autonomous-config-reference.md) — `autonomous.yaml` options
- [Durability Dashboard](../wave5-shipped.md) — `/durability` page overview
