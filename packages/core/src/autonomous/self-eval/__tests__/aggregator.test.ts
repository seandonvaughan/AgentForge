// packages/core/src/autonomous/self-eval/__tests__/aggregator.test.ts
//
// Tests for getAgentAverageScore() and getLowestScoringAgents().

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAgentAverageScore, getLowestScoringAgents } from '../aggregator.js';
import type { SelfEvalRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function makeRecord(
  agentId: string,
  score: 1 | 2 | 3 | 4 | 5,
  recordedAt: string = new Date().toISOString(),
): SelfEvalRecord {
  return {
    agentId,
    cycleId: 'c-test',
    sprintItemId: 'T-test',
    grade: { score, justification: 'Test justification.' },
    recordedAt,
  };
}

function seedFile(projectRoot: string, records: SelfEvalRecord[]): void {
  const memDir = join(projectRoot, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(memDir, 'self-eval.jsonl'), lines, 'utf8');
}

// ---------------------------------------------------------------------------
// getAgentAverageScore
// ---------------------------------------------------------------------------

describe('getAgentAverageScore', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-self-eval-agg-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns null when the self-eval.jsonl file does not exist', async () => {
    const result = await getAgentAverageScore({ projectRoot, agentId: 'nobody' });
    expect(result).toBeNull();
  });

  it('returns null when the agent has no records', async () => {
    seedFile(projectRoot, [makeRecord('other-agent', 4)]);
    const result = await getAgentAverageScore({ projectRoot, agentId: 'missing-agent' });
    expect(result).toBeNull();
  });

  it('returns the exact score for a single record', async () => {
    seedFile(projectRoot, [makeRecord('solo', 3)]);
    const result = await getAgentAverageScore({ projectRoot, agentId: 'solo' });
    expect(result).toBe(3);
  });

  it('returns the mean score across multiple records for one agent', async () => {
    seedFile(projectRoot, [
      makeRecord('agent-a', 2),
      makeRecord('agent-a', 4),
      makeRecord('agent-a', 3),
    ]);
    const result = await getAgentAverageScore({ projectRoot, agentId: 'agent-a' });
    expect(result).toBeCloseTo(3.0);
  });

  it('ignores records outside the default 30-day window', async () => {
    seedFile(projectRoot, [
      makeRecord('windowed', 5, daysAgo(5)),   // in window
      makeRecord('windowed', 1, daysAgo(45)),  // out of window
    ]);
    const result = await getAgentAverageScore({ projectRoot, agentId: 'windowed' });
    // Only the score=5 record is in window.
    expect(result).toBe(5);
  });

  it('respects a custom windowDays parameter', async () => {
    seedFile(projectRoot, [
      makeRecord('narrow', 5, daysAgo(3)),   // in 7-day window
      makeRecord('narrow', 1, daysAgo(10)),  // outside 7-day window
    ]);
    const result = await getAgentAverageScore({ projectRoot, agentId: 'narrow', windowDays: 7 });
    expect(result).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getLowestScoringAgents
// ---------------------------------------------------------------------------

describe('getLowestScoringAgents', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-self-eval-lowest-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns an empty array when no file exists', async () => {
    const result = await getLowestScoringAgents({ projectRoot, topN: 5 });
    expect(result).toEqual([]);
  });

  it('excludes agents with fewer than 3 records (noise threshold)', async () => {
    seedFile(projectRoot, [
      makeRecord('noisy', 1),
      makeRecord('noisy', 1),  // only 2 records — below threshold
    ]);
    const result = await getLowestScoringAgents({ projectRoot, topN: 5 });
    expect(result).toEqual([]);
  });

  it('returns agents meeting the threshold, sorted by avgScore ascending', async () => {
    seedFile(projectRoot, [
      // good-agent: avg 4.33
      makeRecord('good-agent', 4),
      makeRecord('good-agent', 5),
      makeRecord('good-agent', 4),
      // bad-agent: avg 1.67
      makeRecord('bad-agent', 1),
      makeRecord('bad-agent', 2),
      makeRecord('bad-agent', 2),
    ]);

    const result = await getLowestScoringAgents({ projectRoot, topN: 5 });
    expect(result).toHaveLength(2);
    expect(result[0]?.agentId).toBe('bad-agent');   // lowest first
    expect(result[1]?.agentId).toBe('good-agent');
  });

  it('respects topN cap', async () => {
    const records: SelfEvalRecord[] = [];
    for (let i = 1; i <= 5; i++) {
      for (let j = 0; j < 3; j++) {
        records.push(makeRecord(`agent-${i}`, (i % 5 + 1) as 1 | 2 | 3 | 4 | 5));
      }
    }
    seedFile(projectRoot, records);

    const result = await getLowestScoringAgents({ projectRoot, topN: 2 });
    expect(result).toHaveLength(2);
  });

  it('includes count in each returned entry', async () => {
    seedFile(projectRoot, [
      makeRecord('counted', 3),
      makeRecord('counted', 3),
      makeRecord('counted', 3),
    ]);
    const result = await getLowestScoringAgents({ projectRoot, topN: 5 });
    expect(result[0]?.count).toBe(3);
  });

  it('filters by windowDays and excludes stale records', async () => {
    seedFile(projectRoot, [
      makeRecord('stale-agent', 1, daysAgo(60)),
      makeRecord('stale-agent', 1, daysAgo(60)),
      makeRecord('stale-agent', 1, daysAgo(60)),
    ]);
    // All records are outside the 30-day window → agent excluded.
    const result = await getLowestScoringAgents({ projectRoot, topN: 5 });
    expect(result).toEqual([]);
  });
});
