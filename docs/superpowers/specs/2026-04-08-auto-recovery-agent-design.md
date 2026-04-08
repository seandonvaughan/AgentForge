# Auto-Recovery Agent Design (v6.7.5+)

## Problem

Cycles fail at the gate even when only 1 of 20 items broke. The other
19 items' work is good but gets stranded in the working tree because
the gate rejection blocks the commit and PR. Then a human has to
manually:
1. Look at which item failed
2. Read the cycle's review/gate output
3. Fix the failed item by hand
4. Retry the cycle (which redoes all the already-completed work)

This is exactly the kind of repetitive triage the autonomous loop
should handle itself.

## Goal

When a cycle fails at the gate, automatically dispatch an "auto-recovery
agent" running Opus that:
1. Reads the gate verdict and reviewer findings
2. Identifies the specific items that failed
3. Fixes them in place
4. Re-runs the test phase
5. If tests pass, writes a fresh approval-decision and resumes the
   cycle from the gate phase
6. If tests still fail, surfaces the failure to the human with full
   context

## Design

### Trigger

The CycleRunner.runStages() catch block currently writes cycle.json
with stage=failed and exits. New behavior: before exiting on a gate
rejection, check the failure mode:

- If the gate rejected for **specific items that failed**: spawn
  auto-recovery
- If the gate rejected for **systemic issues** (security, architecture,
  test coverage holes): bail to human (current behavior)

The classifier reads `phases/review.json` and `phases/gate.json`. If
the rationale mentions specific itemIds OR specific files that map
to known sprint items, it's recoverable.

### Auto-recovery agent

A new agent type `auto-recovery` (system prompt: opus, max effort).
Inputs:
- The cycle's full sprint (sprint.json)
- The execute phase output (which items failed, error strings)
- The review findings (markdown)
- The gate rationale (markdown)
- The current working-tree diff

Task: "These items failed in cycle X. Read the failure context. Either
fix each failed item in the working tree, or report that you can't
without losing prior work. Run the affected tests. Report back as JSON:
{ fixedItems: [...], stillFailing: [...], stillFailingReason: ... }"

Tools: Read, Write, Edit, Bash, Glob, Grep (same as execute phase)

### Recovery loop

```
async function autoRecover(cycleId: string, gateResult: GateResult) {
  if (!isRecoverable(gateResult)) return { recovered: false, reason: 'not-recoverable' };

  // Snapshot current working tree state for rollback
  const stash = await git.stash();

  for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
    const recovery = await runAutoRecoveryAgent(cycleId, gateResult);
    if (recovery.fixedItems.length === 0) break;

    // Re-run tests
    const tests = await testRunner.run(cycleId);
    if (tests.passRate < FLOOR) continue;

    // Re-run review phase only
    const review = await runReviewPhase(cycleId);

    // Re-run gate phase only
    const gate = await runGatePhase(cycleId, review);
    if (gate.verdict === 'APPROVE') {
      return { recovered: true, attempts: attempt + 1 };
    }
    gateResult = gate;
  }

  // Restore working tree to original failure state
  await git.stashPop(stash);
  return { recovered: false, reason: 'max-attempts-reached' };
}
```

### Limits

- MAX_RECOVERY_ATTEMPTS = 2 (per cycle)
- MAX_RECOVERY_COST_USD = $10 (per cycle, on top of normal cycle budget)
- MAX_RECOVERY_DURATION_MIN = 15
- Auto-recovery never modifies files OUTSIDE the failed items' touched
  set (configurable, default true)

### Logging

Each recovery attempt writes a new phase: `phases/auto-recovery-N.json`
(N = attempt number). Includes:
- gateResult input
- agent prompt
- agent response
- fixedItems / stillFailing
- duration / cost
- post-fix test results

Cycle.json gains a `recoveryAttempts: N` field and `recoveredAt` if
the gate eventually passed.

### Dashboard surface

Cycle detail page Items tab gets a "Recovery" badge on items that
were fixed by auto-recovery (vs. fixed by execute phase). Cost
breakdown shows recovery spend separately. Activity feed gets
`auto-recovery.start`, `auto-recovery.fixed`, `auto-recovery.failed`
events.

## Implementation Plan

### Phase 1 — Recoverability classifier
- New `packages/core/src/autonomous/recovery/is-recoverable.ts`
- Reads gate rationale + review findings
- Tags failure as: `recoverable` | `systemic` | `security` | `unknown`
- Tests with synthetic gate outputs covering common failure modes

### Phase 2 — Auto-recovery agent
- New agent yaml: `.agentforge/agents/auto-recovery.yaml` (opus, max effort)
- New phase handler: `packages/core/src/autonomous/phase-handlers/auto-recovery-phase.ts`
- Mirrors execute-phase structure but operates on a smaller item set
- Tests with mock runtime

### Phase 3 — Cycle runner integration
- CycleRunner.runStages() catches GateRejectedError
- If isRecoverable(): enter recovery loop
- Loop runs up to MAX_RECOVERY_ATTEMPTS, re-running test/review/gate
- On success: write cycle.json with stage=completed and recoveryAttempts > 0
- On failure: write cycle.json with stage=failed and recoveredAttempts=N

### Phase 4 — Dashboard surface
- Cycle detail page recovery badges
- New `/api/v5/cycles/:id/recovery` endpoint
- Activity feed event types

### Phase 5 — Tests + docs
- E2E test: gate rejection → recovery → success
- E2E test: gate rejection → recovery exhausted → graceful failure
- README + CHANGELOG entry

## Acceptance criteria

1. ✅ A cycle that fails at the gate due to 1 timed-out item out of 20
   automatically recovers by re-running just that item
2. ✅ Recovery attempts are visible in the dashboard with cost / duration
3. ✅ Recovery never overwrites work that wasn't broken
4. ✅ Recovery cost is capped per cycle
5. ✅ Recovery failures escalate to the human with full context
6. ✅ Existing single-item cycles still complete in one pass (no overhead)

## Estimated scope

- ~600 lines new code
- ~150 lines tests
- 4-6 cycles to land if shipped via the autonomous loop itself
- $20-40 total cost
