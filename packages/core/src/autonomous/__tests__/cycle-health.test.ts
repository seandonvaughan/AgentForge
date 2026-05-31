import { describe, expect, it } from 'vitest';
import { computeCycleStaleness, aggregatePhaseErrorSummary } from '../cycle-health.js';

describe('computeCycleStaleness', () => {
  const nowMs = Date.parse('2026-01-01T00:00:00.000Z');

  it('returns healthy at age 0', () => {
    expect(computeCycleStaleness(new Date(nowMs).toISOString(), nowMs)).toBe('healthy');
  });

  it('returns healthy at age 119999', () => {
    expect(computeCycleStaleness(new Date(nowMs - 119_999).toISOString(), nowMs)).toBe('healthy');
  });

  it('returns stale at age 120000', () => {
    expect(computeCycleStaleness(new Date(nowMs - 120_000).toISOString(), nowMs)).toBe('stale');
  });

  it('returns stale at age 599999', () => {
    expect(computeCycleStaleness(new Date(nowMs - 599_999).toISOString(), nowMs)).toBe('stale');
  });

  it('returns dead at age 600000', () => {
    expect(computeCycleStaleness(new Date(nowMs - 600_000).toISOString(), nowMs)).toBe('dead');
  });

  it('returns unknown when heartbeat is undefined', () => {
    expect(computeCycleStaleness(undefined, nowMs)).toBe('unknown');
  });

  it('returns unknown when heartbeat is not parseable', () => {
    expect(computeCycleStaleness('not-a-date', nowMs)).toBe('unknown');
  });

  it('returns healthy for a future heartbeat', () => {
    expect(computeCycleStaleness(new Date(nowMs + 60_000).toISOString(), nowMs)).toBe('healthy');
  });
});

describe('aggregatePhaseErrorSummary', () => {
  it('aggregates failed and retried counts per phase', () => {
    const summary = aggregatePhaseErrorSummary([
      {
        phase: 'execute',
        agentRuns: [
          { status: 'failed', attempts: 1 },
          { status: 'completed', attempts: 3 },
          { status: 'completed', attempts: 1 },
        ],
      },
      {
        phase: 'gate',
        agentRuns: [{ status: 'completed', attempts: 2 }],
      },
    ]);

    expect(summary).toEqual({
      execute: { failed: 1, retried: 1 },
      gate: { failed: 0, retried: 1 },
    });
  });

  it('returns empty object for empty input', () => {
    expect(aggregatePhaseErrorSummary([])).toEqual({});
  });
});
