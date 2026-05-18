# Skill Flywheel Runbook

The skill flywheel (Wave 5, T2 + T7) converts accumulated agent learnings into new Claude Code skills automatically. This runbook covers when to run the proposal pipeline, how to triage proposals in the dashboard, approval criteria, and how to revert a skill that causes problems.

---

## When to run `propose-from-learnings`

Run after any of these conditions:

- A cycle completes and `.agentforge/memory/review-finding.jsonl` has grown by ≥ 20 entries since the last proposal run.
- A forge just produced updated `learnings_seed` entries for three or more agents.
- You observe repeated failure patterns across two or more consecutive cycles.

```bash
agentforge skills propose-from-learnings
```

This command reads the three JSONL memory files, clusters findings by topic, and writes candidate skill files to:

```
.agentforge/flywheel/proposals/<slug>.yaml
```

Each proposal includes a `confidence` score (0–1), the source findings that support it, and a draft `skill` body.

### Automated scheduling

Add to `.agentforge/autonomous.yaml` to run automatically after each cycle's `learn` phase:

```yaml
flywheel:
  autoPropose: true
  minNewFindings: 20
```

---

## How to triage proposals at `/flywheel/proposals`

Open the dashboard and navigate to **Flywheel → Proposals** (or go directly to `http://localhost:4751/flywheel/proposals`).

Each proposal card shows:

| Field | Meaning |
|-------|---------|
| **Confidence** | 0–1 score from clustering; ≥ 0.7 is "high confidence" |
| **Source findings** | Count and links to originating JSONL entries |
| **Affected agents** | Which agents triggered this pattern |
| **Draft skill** | Expandable preview of the generated skill YAML |
| **Status** | `pending` / `approved` / `rejected` / `reverted` |

Use the **Approve**, **Reject**, or **Defer** buttons on each card. Approved proposals are written to `.claude/skills/<slug>.md` and become available in the current session immediately (no restart needed).

---

## Approval criteria checklist

Before approving a proposal, verify all of the following:

- [ ] Confidence ≥ 0.65 (proposals below this threshold should default to Defer)
- [ ] At least 3 distinct source findings from different cycles (not one noisy cycle)
- [ ] The skill addresses a repeatable pattern, not a one-off edge case
- [ ] The draft skill body is specific enough to trigger correctly (not too broad)
- [ ] The skill does not duplicate an existing skill in `.claude/skills/`
- [ ] No security-sensitive information (API keys, internal paths) appears in the skill body

If all boxes are checked, click **Approve**. The proposal transitions to `approved` and the skill file is written.

---

## How to revert

If an approved skill produces incorrect behavior or triggers too broadly:

### Via dashboard

1. Navigate to **Flywheel → Proposals**.
2. Find the proposal (filter by status `approved`).
3. Click **Revert**.

This sets the proposal status to `reverted` and deletes `.claude/skills/<slug>.md`.

### Via CLI

```bash
agentforge skills revert <slug>
```

To see all approved skills:

```bash
agentforge skills list --status approved
```

To revert all skills from a specific cycle's proposal batch:

```bash
agentforge skills revert --batch <cycle-id>
```

### Manual fallback

If the CLI is unavailable, delete the file directly and record the revert in the proposals file:

```bash
rm .claude/skills/<slug>.md
# Update .agentforge/flywheel/proposals/<slug>.yaml: set status to "reverted"
```

---

## Related

- [Wave 5 Shipped](../wave5-shipped.md) — context on T2 and T7 deliverables
- [Memory and Learning Loop](../../CLAUDE.md) — how JSONL memory files accumulate
- [Unattended Cycle Runbook](unattended-cycle.md) — running cycles that feed the flywheel
