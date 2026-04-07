import { describe, it, expect } from 'vitest';
import {
  recordCycleSpend,
  rolloverCostPeriodIfNeeded,
} from '../cost-ceiling.js';
import { defaultState, todayIsoDate } from '../daemon-state.js';

describe('daemon cost period tracking', () => {
  it('starts with zero spend on a fresh state', () => {
    const state = defaultState();
    expect(state.costPeriodSpentUsd).toBe(0);
  });

  it('records cycle spend cumulatively', () => {
    const state = defaultState();
    recordCycleSpend(state, 12.5);
    recordCycleSpend(state, 7.25);
    expect(state.costPeriodSpentUsd).toBe(19.75);
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
