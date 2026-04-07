/**
 * Daemon cost period tracking.
 *
 * v6.x already ships BudgetEnforcer (cost-governance/budget-enforcer.ts) for
 * per-cycle and per-day spend ceilings with kill-switch semantics. The daemon
 * does NOT re-implement that — it composes BudgetEnforcer for the in-process
 * ceiling check, and adds only the one thing BudgetEnforcer can't do on its
 * own: persist period spend across daemon restarts via DaemonState.
 *
 * Responsibility split:
 *   BudgetEnforcer  → in-memory ceilings, kill switch, throws on breach
 *   This module     → date-rollover bookkeeping on the persisted DaemonState
 *
 * Earlier versions of this file duplicated BudgetEnforcer's logic in parallel
 * — that was flagged in code review and removed.
 */
import type { DaemonState } from './types.js';
import { todayIsoDate } from './daemon-state.js';

/**
 * Mutates state in place if the cost period has rolled over (UTC date change).
 * Returns true if a reset happened. Caller is responsible for persisting.
 *
 * Called lazily — at the start of every spend recording — so a daemon that
 * sleeps across midnight still resets correctly on its next wake without a
 * background timer.
 */
export function rolloverCostPeriodIfNeeded(state: DaemonState): boolean {
  const today = todayIsoDate();
  if (state.costPeriodDate !== today) {
    state.costPeriodDate = today;
    state.costPeriodSpentUsd = 0;
    return true;
  }
  return false;
}

/**
 * Records a completed cycle's spend against the persisted period counter.
 * Mutates state. Use BudgetEnforcer.record() for the in-process ceiling check
 * — this function only handles the persistence side.
 */
export function recordCycleSpend(state: DaemonState, cycleSpendUsd: number): void {
  rolloverCostPeriodIfNeeded(state);
  state.costPeriodSpentUsd += cycleSpendUsd;
}
