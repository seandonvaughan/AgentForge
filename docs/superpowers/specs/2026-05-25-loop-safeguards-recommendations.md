# AgentForge — Loop Safeguards & Improvement Recommendations (Opus / Ultrathink)

**Date:** 2026-05-25
**Author:** Opus deep-reasoning agent (dispatched during the convergence work)
**Trigger:** ~2 days of AI development were lost to an autonomous loop that spun without shipping. This report recommends safeguards to prevent recurrence and improvements to the product and the forged agent team.
**Companion:** [2026-05-25-agentforge-convergence-and-cloud-design.md](./2026-05-25-agentforge-convergence-and-cloud-design.md)

---

## Deepest root cause (newly found)

`agentforge cycle run` constructs **one** `CycleRunner` and calls `.start()` once, then exits. The "~50 cycles over 2 days" were driven by an **external** repeat-invoker (shell / Ralph-loop). Critically: `packages/core/src/daemon/` has `daemon-state.ts`, `cost-ceiling.ts`, `types.ts` — **but no `daemon-runner.ts`**. The `DaemonState` that carries `consecutiveFailures` and `costPeriodSpentUsd` is **never read by a loop**. So **no process owns cross-cycle state** — the loop ran blind, with no "am I actually shipping?" awareness.

Three confirmed mechanisms:
1. **Budget kill-switch is warn-only** (`kill-switch.ts:49-57`, softened in "v6.7.4"); `BudgetEnforcer` (`cost-governance/budget-enforcer.ts`) implements real daily ceilings but is **never instantiated** in the cycle path.
2. **Consecutive-failure breaker is dead**: `kill-switch.checkBetweenPhases` reads `state.consecutiveFailures` but the only caller passes a hardcoded `0` (`cycle-runner.ts:1386-1391`); nothing increments it across cycles.
3. **The retry re-implements from an empty worktree**: on gate REJECT, `cycle-runner.ts:1031` jumps to `execute`, which allocates a **fresh** worktree off `baseBranch` (`execute-phase.ts:956`). The rejected branch's code isn't present, so the agent must rebuild the whole feature *and* fix the bug in one shot — with file hints regex-scraped from prose rather than the structured findings the gate already computed.

---

## Section 1 — Loop Safeguards (highest priority)

Unifying fix: **a cross-cycle supervisor that owns persistent state** (the `daemon-state.json` that already exists).

| # | Safeguard | Trigger → Action | Hook | Effort | Impact |
|---|---|---|---|---|---|
| 1.1 | **Cross-cycle progress detection** | N consecutive cycles with no merged PR / no net diff to baseBranch → HALT + escalate (don't start next cycle) | build `daemon/daemon-runner.ts`; interim check at top of `CycleRunner.start()` reading `.agentforge/loop-state.json` | M (interim S) | **High** |
| 1.2 | **Consecutive-failure breaker (wire the dead one)** | persist `consecutiveFailures`; ≥ `maxConsecutiveFailures` → pause | stop hardcoding `0` at `cycle-runner.ts:1390`; persist in loop-state | S | High |
| 1.3 | **Rolling daily cost cap** | `costPeriodSpentUsd` ≥ `budget.dailyLimitUsd` → pause; re-arm per-cycle hard stop behind a flag for unattended mode | instantiate `BudgetEnforcer`; `daemon/cost-ceiling.ts:recordCycleSpend` | S–M | High |
| 1.4 | **Item-difficulty gating** | `estimatedComplexity:high` OR `files:[]` → refuse auto-attempt unless approved/decomposed | `sprint-generator.ts:generate` / budget gate; thread `estimatedComplexity` through `BacklogItem` | M | High |
| 1.5 | **No-green → no version bump** | only bump `package.json` on a MERGED PR; stop counting un-merged `plan.json` as version sources | decouple sprint label from published version; `sprint-generator.ts:134 findLatestSprintVersion`, `version-bumper.ts` | S–M | Med |
| 1.6 | **Retry-exhaustion → human checkpoint + quarantine** | final retry fail → write escalation, quarantine the item so it isn't re-picked | reorder `cycle-runner.ts:1095/1100`; add `quarantine.json` filter in `proposal-to-backlog.ts` | S | High |
| 1.7 | **Loud "stuck" observability** | write `loop-health.json` each cycle; emit `loop.stuck`; exit non-zero when HALTED | supervisor; surface on `/durability` | S | Med–High |

---

## Section 2 — Product Improvements (make it ship)

- **2.1 Fix the retry to fix findings (the #1 product bug).** On `gateRetry`, check the agent's worktree out to `gateRetry.rejectedBranch` and fix **in place**, re-pushing the same branch (updates the same PR). Feed the **structured** findings the gate already wrote to `gate.json` (`criticalFindings`/`majorFindings`) instead of regex-scraping prose. `execute-phase.ts:956`, `cycle-runner.ts:1031`. **Effort M · Impact High.**
- **2.2 Auto-decompose large items** into 3–6 small children with concrete `files` hints (the `SprintPlanItem.files` field already exists and is honored). Parent stays as an epic. **Effort L · Impact High.**
- **2.3 Sourcing quality:** under `AGENTFORGE_UNATTENDED=1`, down-rank/filter `backlog-file` items lacking `files` or with `estimatedComplexity:high`; preserve `estimatedComplexity` on `BacklogItem` (currently discarded). **Effort S · Impact Med–High.**
- **2.4 Trust/verification:** the gate already verifies against the real tree (good). Tighten known-debt to read structured `gate.json` metadata only, never `extractFindingsByLevel` over a stringified blob (avoids rubber-stamping). **Effort S · Impact Med.**
- **2.5 Per-job multi-provider routing** (spec §5): `preferredProvider` on `ExecutionRequest`, a `multi` mode in `ExecutionService`, best-(provider×model×effort) policy, unified cross-provider cost. **Effort L · Impact Med.**

---

## Section 3 — Agent Team / Forge Improvements

- **3.1 System-prompt contract (highest leverage, cheap):** `buildItemPrompt` (`execute-phase.ts:1491`) never tells agents to self-verify or keep diffs minimal. Mandate: (1) smallest diff that resolves the item, no unrelated refactor; (2) before finishing, run `tsc -b --noEmit` on affected packages + `vitest run <targeted>` and paste passing output; (3) add/adjust at least one test that fails without the change. **Effort S · Impact High.**
- **3.2 Reduce "every agent is a coder":** tiers are assigned purely by name pattern (`team-designer.ts:74-93`); 35 mostly-Sonnet engineers with near-identical prompts. Give each agent a distinct subsystem-specific verification command and hard file-scope from `owns_subsystems`; consider collapsing the many `svelte-*` agents. **Effort M · Impact Med.**
- **3.3 learnings_seed quality:** seed the operational lessons (minimal diffs, fix-in-place, don't attempt high-complexity whole) via auto-reforge; dedup by semantic cluster so one finding doesn't consume all 8 slots. **Effort S · Impact Med.**
- **3.4 Routing overlap:** `forge-engine-architect` and `reforge-genesis-engineer` both own `packages/core/src/team/engine/genesis` → parallel double-routing / merge conflicts. Add an ownership-uniqueness check to Phase C validation. **Effort S · Impact Low–Med.**

---

## TOP 5 — do these first

1. **Cross-cycle supervisor + HALT on ~3 no-merge cycles** (1.1/1.2/1.3). The single change that turns "spins 2 days" into "stops after ~3 cycles." Interim: a `loop-state.json` check at the top of `CycleRunner.start()`.
2. **Retry in-place on the rejected branch with structured `gate.json` findings** (2.1). The core "make it self-correct" fix.
3. **Self-verify + minimal-diff contract in every agent prompt** (3.1). Cheapest high-impact change; cuts rejections at the source.
4. **Item-difficulty gating + quarantine exhausted items** (1.4/1.6).
5. **Break the version ratchet** (1.5): bump only on merge.
