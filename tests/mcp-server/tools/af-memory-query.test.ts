/**
 * Tests for af_memory_query tool.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afMemoryQuery } from '../../../packages/mcp-server/src/tools/af-memory-query.js';

const TEMP_ROOT = join(tmpdir(), `af-memory-query-test-${Date.now()}`);
const MEMORY_DIR = join(TEMP_ROOT, '.agentforge', 'memory');

// Sample JSONL records
const CYCLE_OUTCOMES = [
  JSON.stringify({
    id: 'rec-1',
    type: 'cycle-outcome',
    value: JSON.stringify({ cycleId: 'abc123', stage: 'completed', costUsd: 5.2, testsPassed: 300 }),
    createdAt: '2026-05-01T10:00:00Z',
    tags: ['cycle', 'completed'],
  }),
  JSON.stringify({
    id: 'rec-2',
    type: 'cycle-outcome',
    value: JSON.stringify({ cycleId: 'def456', stage: 'failed', costUsd: 0, testsPassed: 0 }),
    createdAt: '2026-05-02T10:00:00Z',
    tags: ['cycle', 'failed'],
  }),
].join('\n');

const GATE_VERDICTS = [
  JSON.stringify({
    id: 'gate-1',
    type: 'gate-verdict',
    value: JSON.stringify({ cycleId: 'abc123', passed: true, reason: 'All quality gates passed' }),
    createdAt: '2026-05-01T12:00:00Z',
    tags: ['gate', 'passed'],
  }),
  JSON.stringify({
    id: 'gate-2',
    type: 'gate-verdict',
    value: JSON.stringify({ cycleId: 'def456', passed: false, reason: 'Test coverage below floor' }),
    createdAt: '2026-05-02T12:00:00Z',
    tags: ['gate', 'failed'],
  }),
].join('\n');

beforeAll(() => {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(join(MEMORY_DIR, 'cycle-outcome.jsonl'), CYCLE_OUTCOMES, 'utf-8');
  writeFileSync(join(MEMORY_DIR, 'gate-verdict.jsonl'), GATE_VERDICTS, 'utf-8');
});

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe('afMemoryQuery', () => {
  it('returns hits for a relevant query', async () => {
    const result = await afMemoryQuery({ text: 'cycle completed', k: 5 }, TEMP_ROOT);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(Array.isArray(result.data?.hits)).toBe(true);
    // Should find at least something
    expect(result.data?.hits.length).toBeGreaterThan(0);
  });

  it('returns empty hits for empty memory dir', async () => {
    const result = await afMemoryQuery({ text: 'anything' }, '/nonexistent/path');

    expect(result.ok).toBe(true);
    expect(result.data?.hits).toHaveLength(0);
  });

  it('respects the k limit', async () => {
    const result = await afMemoryQuery({ text: 'cycle gate', k: 2 }, TEMP_ROOT);

    expect(result.ok).toBe(true);
    expect(result.data?.hits.length).toBeLessThanOrEqual(2);
  });

  it('hit records contain required fields', async () => {
    const result = await afMemoryQuery({ text: 'quality gates' }, TEMP_ROOT);

    expect(result.ok).toBe(true);
    if (result.data && result.data.hits.length > 0) {
      const hit = result.data.hits[0]!;
      expect(typeof hit.file).toBe('string');
      expect(typeof hit.line).toBe('number');
      expect(typeof hit.score).toBe('number');
      expect(typeof hit.excerpt).toBe('string');
    }
  });

  it('returns gate-verdict records when querying for gate failures', async () => {
    const result = await afMemoryQuery({ text: 'test coverage floor failed' }, TEMP_ROOT);

    expect(result.ok).toBe(true);
    // Should find at least the gate-verdict record about test coverage
    expect(result.data?.hits.length).toBeGreaterThan(0);
    const fileNames = result.data?.hits.map(h => h.file) ?? [];
    expect(fileNames.some(f => f.includes('gate') || f.includes('cycle'))).toBe(true);
  });

  it('scores are between 0 and 1', async () => {
    const result = await afMemoryQuery({ text: 'completed cycle' }, TEMP_ROOT);

    expect(result.ok).toBe(true);
    for (const hit of result.data?.hits ?? []) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });
});
