/**
 * Cost ceiling enforcement.
 *
 * The daemon tracks period spend in DaemonState. Before each cycle launch,
 * isCostCeilingExceeded() decides whether to pause. Period rollover happens
 * lazily — checked at the start of every spend recording, so a daemon that
 * sleeps across midnight still resets correctly on its next wake.
 *
 * v7.0.0 only enforces the daily ceiling; weekly/monthly are tracked but
 * checked against the same daily counter for now (we accumulate
 * costPeriodSpentUsd and reset it on date rollover). v7.1 will introduce
 * separate week/month counters.
 */
import type { CostCeilingConfig, DaemonState } from './types.js';
import { todayIsoDate } from './daemon-state.js';

/** Mutates state in place if the cost period has rolled. Returns true if reset. */
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
 * Returns true if launching another cycle would exceed the daily ceiling.
 * Caller decides what to do (pause, log, alert).
 */
export function isCostCeilingExceeded(
  config: CostCeilingConfig,
  state: DaemonState,
): boolean {
  rolloverCostPeriodIfNeeded(state);
  return state.costPeriodSpentUsd >= config.dailyUsd;
}

/**
 * Records a completed cycle's spend against the current period.
 * Mutates state. Caller is responsible for persisting.
 */
export function recordCycleSpend(state: DaemonState, cycleSpendUsd: number): void {
  rolloverCostPeriodIfNeeded(state);
  state.costPeriodSpentUsd += cycleSpendUsd;
}
