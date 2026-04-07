import { describe, it, expect } from 'vitest';
import {
  isCostCeilingExceeded,
  recordCycleSpend,
  rolloverCostPeriodIfNeeded,
} from '../cost-ceiling.js';
import { defaultState, todayIsoDate } from '../daemon-state.js';
import type { CostCeilingConfig } from '../types.js';

const config: CostCeilingConfig = { dailyUsd: 50, weeklyUsd: 200, monthlyUsd: 800 };

describe('cost ceiling', () => {
  it('starts with zero spend and is not exceeded', () => {
    const state = defaultState();
    expect(isCostCeilingExceeded(config, state)).toBe(false);
    expect(state.costPeriodSpentUsd).toBe(0);
  });

  it('records cycle spend cumulatively', () => {
    const state = defaultState();
    recordCycleSpend(state, 12.5);
    recordCycleSpend(state, 7.25);
    expect(state.costPeriodSpentUsd).toBe(19.75);
  });

  it('flags ceiling exceeded once spend reaches the daily limit', () => {
    const state = defaultState();
    recordCycleSpend(state, 49.99);
    expect(isCostCeilingExceeded(config, state)).toBe(false);
    recordCycleSpend(state, 0.01);
    expect(isCostCeilingExceeded(config, state)).toBe(true);
  });

  it('rolls over period when the date changes and resets the counter', () => {
    const state = defaultState();
    state.costPeriodDate = '2020-01-01'; // ancient date forces rollover
    state.costPeriodSpentUsd = 999;
    const rolled = rolloverCostPeriodIfNeeded(state);
    expect(rolled).toBe(true);
    expect(state.costPeriodSpentUsd).toBe(0);
    expect(state.costPeriodDate).toBe(todayIsoDate());
  });

  it('does not roll over when the date is unchanged', () => {
    const state = defaultState();
    state.costPeriodSpentUsd = 10;
    const rolled = rolloverCostPeriodIfNeeded(state);
    expect(rolled).toBe(false);
    expect(state.costPeriodSpentUsd).toBe(10);
  });
});
