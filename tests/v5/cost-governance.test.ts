import { describe, it, expect } from 'vitest';
import { BudgetEnforcer, KillSwitchError, BudgetExceededError, ModelSelector } from '@agentforge/core';

describe('ModelSelector', () => {
  it('selects haiku for trivial tasks', () => {
    const s = new ModelSelector();
    expect(s.select('fix typo in comment')).toBe('haiku');
    expect(s.select('rename variable')).toBe('haiku');
  });

  it('selects sonnet for moderate tasks', () => {
    const s = new ModelSelector();
    expect(s.select('implement user authentication endpoint')).toBe('sonnet');
    expect(s.select('add pagination to the API')).toBe('sonnet');
  });

  it('selects opus for strategic tasks', () => {
    const s = new ModelSelector();
    expect(s.select('architect the new database migration strategy')).toBe('opus');
    expect(s.select('design the system for cross-instance federation')).toBe('opus');
  });

  it('respects explicit model override', () => {
    const s = new ModelSelector();
    expect(s.select('fix typo', 'opus')).toBe('opus');
    expect(s.select('design architecture', 'haiku')).toBe('haiku');
  });

  it('defaults to sonnet for ambiguous tasks', () => {
    const s = new ModelSelector();
    expect(s.select('do the thing')).toBe('sonnet');
  });
});

describe('BudgetEnforcer', () => {
  it('records spend without error within limits', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, agentLimitUsd: 10 });
    expect(() => e.record(0.5)).not.toThrow();
    expect(e.status().dailySpend).toBeCloseTo(0.5);
  });

  it('throws BudgetExceededError for single oversized agent call', () => {
    const e = new BudgetEnforcer({ agentLimitUsd: 0.10 });
    expect(() => e.record(0.50, 'agent')).toThrow(BudgetExceededError);
  });

  it('throws KillSwitchError when daily limit is exceeded', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 0.01, agentLimitUsd: 1.00 });
    expect(() => e.record(0.05, 'agent')).toThrow(KillSwitchError);
  });

  it('blocks all calls after kill switch fires', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 0.01, agentLimitUsd: 1.00 });
    try { e.record(0.05); } catch {}
    expect(() => e.record(0.001)).toThrow(KillSwitchError);
  });

  it('wouldExceed returns true when spending would breach daily limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 1.00, agentLimitUsd: 10.00 });
    e.record(0.90);
    expect(e.wouldExceed(0.20)).toBe(true);
    expect(e.wouldExceed(0.05)).toBe(false);
  });

  it('reset clears all counters and disengages kill switch', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 0.01, agentLimitUsd: 1.00 });
    try { e.record(0.05); } catch {}
    e.reset();
    expect(e.status().killed).toBe(false);
    expect(e.status().dailySpend).toBe(0);
    expect(() => e.record(0.001)).not.toThrow();
  });

  it('resetSprint resets sprint spend without affecting daily', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 5, agentLimitUsd: 10 });
    e.record(2);
    e.record(2);
    expect(e.status().sprintSpend).toBeCloseTo(4);
    e.resetSprint();
    expect(e.status().sprintSpend).toBe(0);
    expect(e.status().dailySpend).toBeCloseTo(4);
  });
});

describe('BudgetEnforcer — sprint ceiling', () => {
  it('throws BudgetExceededError when sprint limit exceeded with sprint context', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 1, agentLimitUsd: 50 });
    expect(() => e.record(1.5, 'sprint')).toThrow(BudgetExceededError);
  });

  it('does NOT throw sprint error for workflow context even when over sprint limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 1, agentLimitUsd: 50 });
    expect(() => e.record(1.5, 'workflow')).not.toThrow();
  });

  it('sprint spend accumulates across multiple records', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 10, agentLimitUsd: 10 });
    e.record(3);
    e.record(3);
    e.record(3);
    expect(e.status().sprintSpend).toBeCloseTo(9);
  });

  it('sprintRemaining approaches zero as sprint spend increases', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 5, agentLimitUsd: 10 });
    e.record(4);
    expect(e.status().sprintRemaining).toBeCloseTo(1);
  });

  it('sprintRemaining floors at zero when over limit (via non-sprint context)', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 2, agentLimitUsd: 50 });
    e.record(5, 'workflow'); // won't throw but exceeds sprint
    expect(e.status().sprintRemaining).toBe(0);
  });
});

describe('BudgetEnforcer — wouldExceed variants', () => {
  it('wouldExceed returns false when at exactly zero spend', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 10, agentLimitUsd: 10 });
    expect(e.wouldExceed(1)).toBe(false);
  });

  it('wouldExceed returns true if killed', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 0.01, agentLimitUsd: 10 });
    try { e.record(0.05); } catch {}
    expect(e.wouldExceed(0.001)).toBe(true);
  });

  it('wouldExceed with sprint context respects sprint limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 5, agentLimitUsd: 50 });
    e.record(4);
    expect(e.wouldExceed(2, 'sprint')).toBe(true);
    expect(e.wouldExceed(0.5, 'sprint')).toBe(false);
  });

  it('wouldExceed with agent context checks agent limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, agentLimitUsd: 1 });
    expect(e.wouldExceed(2, 'agent')).toBe(true);
    expect(e.wouldExceed(0.5, 'agent')).toBe(false);
  });
});

describe('BudgetEnforcer — updateConfig', () => {
  it('updateConfig raises daily limit allowing previously blocked spend', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 0.01, agentLimitUsd: 100 });
    // Would exceed old limit
    expect(e.wouldExceed(0.05)).toBe(true);
    e.updateConfig({ dailyLimitUsd: 10 });
    expect(e.wouldExceed(0.05)).toBe(false);
  });

  it('updateConfig lowers agent limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, agentLimitUsd: 5 });
    e.updateConfig({ agentLimitUsd: 0.01 });
    expect(() => e.record(0.05, 'agent')).toThrow(BudgetExceededError);
  });
});

describe('BudgetEnforcer — status fields', () => {
  it('status.dailyLimit matches configured limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 42, agentLimitUsd: 10 });
    expect(e.status().dailyLimit).toBe(42);
  });

  it('status.sprintLimit matches configured limit', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, sprintLimitUsd: 7, agentLimitUsd: 10 });
    expect(e.status().sprintLimit).toBe(7);
  });

  it('dailyRemaining decreases as spend is recorded', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 10, agentLimitUsd: 10 });
    const before = e.status().dailyRemaining;
    e.record(1);
    expect(e.status().dailyRemaining).toBeCloseTo(before - 1);
  });

  it('status.killed starts false', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, agentLimitUsd: 10 });
    expect(e.status().killed).toBe(false);
  });

  it('status.alertFired starts false', () => {
    const e = new BudgetEnforcer({ dailyLimitUsd: 100, agentLimitUsd: 10 });
    expect(e.status().alertFired).toBe(false);
  });

  it('KillSwitchError has correct code property', () => {
    const err = new KillSwitchError('test');
    expect(err.code).toBe('KILL_SWITCH_ENGAGED');
  });

  it('BudgetExceededError has correct code property', () => {
    const err = new BudgetExceededError('Agent', 1, 0.5);
    expect(err.code).toBe('BUDGET_EXCEEDED');
  });
});

describe('ModelSelector — inferComplexity', () => {
  it('infers trivial complexity for whitespace-only tasks', () => {
    const s = new ModelSelector();
    // 'whitespace' is a trivial keyword; no higher-priority keywords present
    expect(s.inferComplexity('remove trailing whitespace')).toBe('trivial');
  });

  it('infers trivial complexity for comment-only tasks', () => {
    const s = new ModelSelector();
    // 'comment' is a trivial keyword; no higher-priority keywords present
    expect(s.inferComplexity('comment out old logic')).toBe('trivial');
  });

  it('infers simple complexity for patch tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('apply patch to login handler')).toBe('simple');
  });

  it('infers simple complexity for lint tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('lint the generated output')).toBe('simple');
  });

  it('infers moderate complexity for implement tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('implement the payment gateway')).toBe('moderate');
  });

  it('infers moderate complexity for extend tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('extend the user profile model')).toBe('moderate');
  });

  it('infers complex complexity for refactor tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('refactor the authentication pipeline')).toBe('complex');
  });

  it('infers complex complexity for migrate tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('migrate the old framework to new one')).toBe('complex');
  });

  it('infers strategic complexity for architect tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('architect the new microservice boundary')).toBe('strategic');
  });

  it('infers strategic complexity for evaluate tasks', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('evaluate the security posture')).toBe('strategic');
  });

  it('defaults to moderate for completely unknown task', () => {
    const s = new ModelSelector();
    expect(s.inferComplexity('xyz 123 unknown operation qwerty')).toBe('moderate');
  });

  it('strategic keyword wins over lower-priority keywords in same string', () => {
    const s = new ModelSelector();
    // "design" (strategic) + "fix" (simple) — strategic should win
    expect(s.select('design and fix the system')).toBe('opus');
  });

  it('select with explicit sonnet override returns sonnet regardless of task', () => {
    const s = new ModelSelector();
    expect(s.select('architect the universe', 'sonnet')).toBe('sonnet');
  });

  it('select with invalid explicit model falls back to inferred tier', () => {
    const s = new ModelSelector();
    // 'gpt-4' is not a valid tier, so infer from task
    expect(s.select('fix typo in readme', 'gpt-4' as any)).toBe('haiku');
  });

  it('haiku maps to haiku tier for simple tasks', () => {
    const s = new ModelSelector();
    expect(s.select('patch the broken import')).toBe('haiku');
  });

  it('complex task maps to sonnet (not opus)', () => {
    const s = new ModelSelector();
    expect(s.select('refactor the monolith into services')).toBe('sonnet');
  });
});
