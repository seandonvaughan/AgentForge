// packages/core/src/autonomous/self-eval/__tests__/recorder.test.ts
//
// Tests for recordSelfEval() — atomic append to self-eval.jsonl.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordSelfEval } from '../recorder.js';
import type { SelfEvalRecord } from '../types.js';

function makeRecord(overrides: Partial<SelfEvalRecord> = {}): SelfEvalRecord {
  return {
    agentId: 'test-agent',
    cycleId: 'cycle-001',
    sprintItemId: 'item-A',
    grade: { score: 4, justification: 'Completed the main path but skipped one test.' },
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('recordSelfEval', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-self-eval-recorder-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates the memory directory and file on first write', async () => {
    const record = makeRecord();
    await recordSelfEval({ projectRoot, record });

    const filePath = join(projectRoot, '.agentforge', 'memory', 'self-eval.jsonl');
    const contents = readFileSync(filePath, 'utf8');
    expect(contents.trim().length).toBeGreaterThan(0);
  });

  it('appends a valid JSON line matching the record', async () => {
    const record = makeRecord({ agentId: 'scout', cycleId: 'c-42', sprintItemId: 'T2.6' });
    await recordSelfEval({ projectRoot, record });

    const filePath = join(projectRoot, '.agentforge', 'memory', 'self-eval.jsonl');
    const line = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(line) as SelfEvalRecord;

    expect(parsed.agentId).toBe('scout');
    expect(parsed.cycleId).toBe('c-42');
    expect(parsed.sprintItemId).toBe('T2.6');
    expect(parsed.grade.score).toBe(4);
  });

  it('appends multiple records as separate lines', async () => {
    await recordSelfEval({ projectRoot, record: makeRecord({ agentId: 'agent-1' }) });
    await recordSelfEval({ projectRoot, record: makeRecord({ agentId: 'agent-2' }) });
    await recordSelfEval({ projectRoot, record: makeRecord({ agentId: 'agent-3' }) });

    const filePath = join(projectRoot, '.agentforge', 'memory', 'self-eval.jsonl');
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(3);
    const agents = lines.map((l) => (JSON.parse(l) as SelfEvalRecord).agentId);
    expect(agents).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('preserves all grade fields in the written record', async () => {
    const record = makeRecord({
      grade: { score: 1, justification: 'Blocked by missing dependency.' },
    });
    await recordSelfEval({ projectRoot, record });

    const filePath = join(projectRoot, '.agentforge', 'memory', 'self-eval.jsonl');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8').trim()) as SelfEvalRecord;
    expect(parsed.grade.score).toBe(1);
    expect(parsed.grade.justification).toBe('Blocked by missing dependency.');
  });

  it('throws when projectRoot path is invalid', async () => {
    const badRoot = join(projectRoot, 'not-a-directory');
    writeFileSync(badRoot, 'file');
    await expect(
      recordSelfEval({ projectRoot: join(badRoot, 'proj'), record: makeRecord() }),
    ).rejects.toThrow();
  });
});
