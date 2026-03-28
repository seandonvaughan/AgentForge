import { describe, it, expect } from 'vitest';
import { ExecutionLog, SprintReporter } from '@agentforge/core';

describe('ExecutionLog', () => {
  it('logs entries and queries them', () => {
    const log = new ExecutionLog();
    log.log('info', 'agent', 'Agent started', { agentId: 'coder', sprintVersion: '5.5' });
    log.log('error', 'sprint', 'Sprint failed', { sprintVersion: '5.5' });
    expect(log.count()).toBe(2);
  });

  it('filters by category', () => {
    const log = new ExecutionLog();
    log.log('info', 'agent', 'msg1');
    log.log('info', 'sprint', 'msg2');
    log.log('info', 'agent', 'msg3');
    const agents = log.query({ category: 'agent' });
    expect(agents.length).toBe(2);
    expect(agents.every(e => e.category === 'agent')).toBe(true);
  });

  it('filters by level', () => {
    const log = new ExecutionLog();
    log.log('info', 'system', 'info msg');
    log.log('error', 'system', 'error msg');
    const errors = log.query({ level: 'error' });
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe('error msg');
  });

  it('respects limit', () => {
    const log = new ExecutionLog();
    for (let i = 0; i < 20; i++) log.log('info', 'system', `msg ${i}`);
    const limited = log.query({ limit: 5 });
    expect(limited.length).toBe(5);
  });

  it('clear empties the log', () => {
    const log = new ExecutionLog();
    log.log('info', 'system', 'test');
    log.clear();
    expect(log.count()).toBe(0);
  });
});

describe('SprintReporter', () => {
  it('starts and completes a sprint summary', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 8, 2708);
    const completed = reporter.completeSprint('5.5', {
      itemsCompleted: 7,
      itemsFailed: 1,
      totalCostUsd: 2.50,
      testCountAfter: 2732,
      promoted: true,
      verdict: 'ship',
      highlights: ['Added knowledge graph', 'Fixed canary deployment'],
    });
    expect(completed?.promoted).toBe(true);
    expect(completed?.verdict).toBe('ship');
    expect(completed?.testCountAfter).toBe(2732);
  });

  it('get returns null for unknown sprint', () => {
    const reporter = new SprintReporter();
    expect(reporter.get('9.9')).toBeNull();
  });

  it('list returns all summaries sorted newest first', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 5, 2708);
    reporter.startSprint('5.6', 6, 2720);
    const all = reporter.list();
    expect(all.length).toBe(2);
  });
});

describe('ExecutionLog — filtering and edge cases', () => {
  it('returns entries in reverse order (newest first)', () => {
    const log = new ExecutionLog();
    log.log('info', 'system', 'first');
    log.log('info', 'system', 'second');
    log.log('info', 'system', 'third');
    const entries = log.query({});
    expect(entries[0]?.message).toBe('third');
  });

  it('filters by sprintVersion', () => {
    const log = new ExecutionLog();
    log.log('info', 'agent', 'msg A', { sprintVersion: '5.5' });
    log.log('info', 'agent', 'msg B', { sprintVersion: '5.6' });
    log.log('info', 'agent', 'msg C', { sprintVersion: '5.5' });
    const filtered = log.query({ sprintVersion: '5.5' });
    expect(filtered.length).toBe(2);
    expect(filtered.every(e => e.sprintVersion === '5.5')).toBe(true);
  });

  it('filters by agentId', () => {
    const log = new ExecutionLog();
    log.log('info', 'agent', 'coder ran', { agentId: 'coder' });
    log.log('info', 'agent', 'linter ran', { agentId: 'linter' });
    log.log('info', 'agent', 'coder again', { agentId: 'coder' });
    const coderEntries = log.query({ agentId: 'coder' });
    expect(coderEntries.length).toBe(2);
    expect(coderEntries.every(e => e.agentId === 'coder')).toBe(true);
  });

  it('filters by debug level', () => {
    const log = new ExecutionLog();
    log.log('debug', 'system', 'debug msg');
    log.log('info', 'system', 'info msg');
    log.log('warn', 'system', 'warn msg');
    const debugs = log.query({ level: 'debug' });
    expect(debugs.length).toBe(1);
    expect(debugs[0]?.level).toBe('debug');
  });

  it('filters by warn level', () => {
    const log = new ExecutionLog();
    log.log('warn', 'cost', 'budget warning');
    log.log('error', 'cost', 'budget exceeded');
    const warns = log.query({ level: 'warn' });
    expect(warns.length).toBe(1);
  });

  it('filters by cost category', () => {
    const log = new ExecutionLog();
    log.log('info', 'cost', 'cost event');
    log.log('info', 'workflow', 'workflow event');
    log.log('warn', 'cost', 'cost warning');
    const costEntries = log.query({ category: 'cost' });
    expect(costEntries.length).toBe(2);
    expect(costEntries.every(e => e.category === 'cost')).toBe(true);
  });

  it('filters by workflow category', () => {
    const log = new ExecutionLog();
    log.log('info', 'workflow', 'wf started');
    log.log('info', 'agent', 'agent started');
    const wfEntries = log.query({ category: 'workflow' });
    expect(wfEntries.length).toBe(1);
  });

  it('query with no filters returns all entries (up to default limit of 100)', () => {
    const log = new ExecutionLog();
    for (let i = 0; i < 10; i++) log.log('info', 'system', `msg ${i}`);
    const all = log.query();
    expect(all.length).toBe(10);
  });

  it('default query limit is 100', () => {
    const log = new ExecutionLog();
    for (let i = 0; i < 150; i++) log.log('info', 'system', `msg ${i}`);
    const result = log.query({});
    expect(result.length).toBe(100);
  });

  it('log entry has an id field', () => {
    const log = new ExecutionLog();
    const entry = log.log('info', 'system', 'test');
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
  });

  it('log entry has a timestamp field', () => {
    const log = new ExecutionLog();
    const entry = log.log('info', 'system', 'test');
    expect(() => new Date(entry.timestamp)).not.toThrow();
  });

  it('log entry stores data payload', () => {
    const log = new ExecutionLog();
    const entry = log.log('info', 'agent', 'test', { costUsd: 0.05 });
    expect(entry.data?.costUsd).toBe(0.05);
  });

  it('log entry costUsd extracted from data', () => {
    const log = new ExecutionLog();
    const entry = log.log('info', 'agent', 'cost log', { costUsd: 0.12 });
    expect(entry.costUsd).toBeCloseTo(0.12);
  });

  it('log entry durationMs extracted from data', () => {
    const log = new ExecutionLog();
    const entry = log.log('info', 'agent', 'perf log', { durationMs: 250 });
    expect(entry.durationMs).toBe(250);
  });

  it('count returns 0 on fresh log', () => {
    const log = new ExecutionLog();
    expect(log.count()).toBe(0);
  });

  it('count increases with each log call', () => {
    const log = new ExecutionLog();
    log.log('info', 'system', 'one');
    log.log('info', 'system', 'two');
    expect(log.count()).toBe(2);
  });

  it('clear after multiple logs returns count 0', () => {
    const log = new ExecutionLog();
    log.log('info', 'system', 'a');
    log.log('error', 'agent', 'b');
    log.clear();
    expect(log.count()).toBe(0);
    expect(log.query().length).toBe(0);
  });

  it('combined filter on level and category', () => {
    const log = new ExecutionLog();
    log.log('error', 'agent', 'agent error');
    log.log('error', 'sprint', 'sprint error');
    log.log('info', 'agent', 'agent info');
    const filtered = log.query({ level: 'error', category: 'agent' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.message).toBe('agent error');
  });

  it('respects maxEntries constructor cap', () => {
    const log = new ExecutionLog(5);
    for (let i = 0; i < 10; i++) log.log('info', 'system', `msg ${i}`);
    // Internal cap at 5
    expect(log.count()).toBe(5);
  });
});

describe('SprintReporter — completeSprint edge cases', () => {
  it('completeSprint returns null when sprint was never started', () => {
    const reporter = new SprintReporter();
    const result = reporter.completeSprint('99.99', { verdict: 'ship', promoted: true, itemsCompleted: 0, itemsFailed: 0, totalCostUsd: 0, testCountAfter: 0 });
    expect(result).toBeNull();
  });

  it('startSprint sets initial promoted to false', () => {
    const reporter = new SprintReporter();
    const summary = reporter.startSprint('5.5', 8, 2708);
    expect(summary.promoted).toBe(false);
  });

  it('startSprint sets verdict to in_progress', () => {
    const reporter = new SprintReporter();
    const summary = reporter.startSprint('5.5', 8, 2708);
    expect(summary.verdict).toBe('in_progress');
  });

  it('completeSprint updates verdict to ship', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 8, 2708);
    const s = reporter.completeSprint('5.5', { verdict: 'ship', promoted: true, itemsCompleted: 8, itemsFailed: 0, totalCostUsd: 2.0, testCountAfter: 2720 });
    expect(s?.verdict).toBe('ship');
  });

  it('completeSprint sets completedAt', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 5, 2708);
    const s = reporter.completeSprint('5.5', { verdict: 'retry', promoted: false, itemsCompleted: 3, itemsFailed: 2, totalCostUsd: 1.0, testCountAfter: 2708 });
    expect(s?.completedAt).toBeDefined();
    expect(() => new Date(s!.completedAt!)).not.toThrow();
  });

  it('get returns the started summary before completion', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 5, 2708);
    const s = reporter.get('5.5');
    expect(s).not.toBeNull();
    expect(s?.sprintVersion).toBe('5.5');
  });

  it('list returns empty array when no sprints started', () => {
    const reporter = new SprintReporter();
    expect(reporter.list()).toEqual([]);
  });

  it('list length matches number of started sprints', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 5, 2708);
    reporter.startSprint('5.6', 6, 2720);
    reporter.startSprint('5.7', 7, 2735);
    expect(reporter.list().length).toBe(3);
  });

  it('overwriting same sprint version replaces it in list', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 5, 2708);
    reporter.startSprint('5.5', 8, 2750); // same version again
    expect(reporter.list().length).toBe(1);
    expect(reporter.get('5.5')?.itemsPlanned).toBe(8);
  });

  it('completeSprint with highlights preserves them', () => {
    const reporter = new SprintReporter();
    reporter.startSprint('5.5', 3, 2708);
    const s = reporter.completeSprint('5.5', {
      verdict: 'ship',
      promoted: true,
      itemsCompleted: 3,
      itemsFailed: 0,
      totalCostUsd: 0.5,
      testCountAfter: 2720,
      highlights: ['Feature A shipped', 'Feature B shipped'],
    });
    expect(s?.highlights).toContain('Feature A shipped');
  });
});
