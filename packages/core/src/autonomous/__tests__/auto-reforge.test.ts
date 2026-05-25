// packages/core/src/autonomous/__tests__/auto-reforge.test.ts
//
// Tests for T2.3 — auto-reforge module.
//
// Coverage:
//   - runAutoReforge: normal path (learnings produced and applied)
//   - runAutoReforge: skip on empty curation result
//   - runAutoReforge: dryRun flag passed through to mutator
//   - runAutoReforge: bus event emission
//   - runAutoReforge: no bus — no crash
//   - runAutoReforge: error in curator is propagated (caller swallows it)
//   - extractInvolvedAgentIds: reads agentRuns from execute.json
//   - extractInvolvedAgentIds: falls back gracefully when file absent

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runAutoReforge,
  extractInvolvedAgentIds,
} from '../auto-reforge.js';
import type {
  CurationInput,
  CurationResult,
  ApplyLearningsInput,
  MutatorReport,
} from '../auto-reforge.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEmptyCurationResult(): CurationResult {
  return { byAgent: {}, sourcesScanned: [], generatedAt: new Date().toISOString() };
}

function makeCurationResult(agentIds: string[]): CurationResult {
  const byAgent: Record<string, CurationResult['byAgent'][string]> = {};
  for (const id of agentIds) {
    byAgent[id] = [
      {
        agentId: id,
        lesson: `Always validate inputs for ${id}`,
        score: 0.9,
        sourceId: 'mem-001',
        severity: 'MAJOR',
        rationale: 'role-tag',
        sourceCreatedAt: new Date().toISOString(),
      },
    ];
  }
  return { byAgent, sourcesScanned: [], generatedAt: new Date().toISOString() };
}

function makeMutatorReport(dryRun = false): MutatorReport {
  return {
    perAgent: { coder: { applied: 1, skipped: 0, capped: false, lessons: ['lesson 1'] } },
    totalApplied: 1,
    totalSkipped: 0,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Temp dir per test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-auto-reforge-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runAutoReforge
// ---------------------------------------------------------------------------

describe('runAutoReforge', () => {
  it('applies learnings when curator returns proposals', async () => {
    const curate = vi.fn(async (_input: CurationInput): Promise<CurationResult> =>
      makeCurationResult(['coder', 'reviewer']),
    );
    const apply = vi.fn(async (_input: ApplyLearningsInput): Promise<MutatorReport> =>
      makeMutatorReport(),
    );

    const result = await runAutoReforge({
      projectRoot: tmpDir,
      cycleId: 'cycle-001',
      involvedAgentIds: ['coder', 'reviewer'],
      curateLearnings: curate,
      applyLearnings: apply,
    });

    expect(result.skipped).toBe(false);
    expect(result.cycleId).toBe('cycle-001');
    expect(result.mutatorReport).toBeDefined();
    expect(result.mutatorReport?.totalApplied).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(curate).toHaveBeenCalledWith({
      projectRoot: tmpDir,
      agentIds: ['coder', 'reviewer'],
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('returns skipped=true when curator produces no proposals', async () => {
    const curate = vi.fn(async (): Promise<CurationResult> => makeEmptyCurationResult());
    const apply = vi.fn(async (): Promise<MutatorReport> => makeMutatorReport());

    const result = await runAutoReforge({
      projectRoot: tmpDir,
      cycleId: 'cycle-002',
      involvedAgentIds: ['coder'],
      curateLearnings: curate,
      applyLearnings: apply,
    });

    expect(result.skipped).toBe(true);
    expect(result.mutatorReport).toBeUndefined();
    // Apply must NOT be called when curation is empty.
    expect(apply).not.toHaveBeenCalled();
  });

  it('passes dryRun=true through to the mutator', async () => {
    const curate = vi.fn(async (): Promise<CurationResult> =>
      makeCurationResult(['coder']),
    );
    const apply = vi.fn(async (input: ApplyLearningsInput): Promise<MutatorReport> =>
      makeMutatorReport(input.dryRun),
    );

    const result = await runAutoReforge({
      projectRoot: tmpDir,
      cycleId: 'cycle-003',
      involvedAgentIds: ['coder'],
      dryRun: true,
      curateLearnings: curate,
      applyLearnings: apply,
    });

    expect(result.skipped).toBe(false);
    expect(result.mutatorReport?.dryRun).toBe(true);
    const applyArg = apply.mock.calls[0]![0] as ApplyLearningsInput;
    expect(applyArg.dryRun).toBe(true);
  });

  it('emits learnings.applied bus event when a bus is provided', async () => {
    const publishSpy = vi.fn();
    const bus = { publish: publishSpy };

    const curate = vi.fn(async (): Promise<CurationResult> =>
      makeCurationResult(['coder']),
    );
    const apply = vi.fn(async (): Promise<MutatorReport> => makeMutatorReport());

    await runAutoReforge({
      projectRoot: tmpDir,
      cycleId: 'cycle-004',
      involvedAgentIds: ['coder'],
      bus,
      curateLearnings: curate,
      applyLearnings: apply,
    });

    expect(publishSpy).toHaveBeenCalledOnce();
    const [topic, payload] = publishSpy.mock.calls[0]!;
    expect(topic).toBe('learnings.applied');
    expect(payload).toMatchObject({ cycleId: 'cycle-004' });
    expect(payload).toHaveProperty('perAgent');
    expect(payload).toHaveProperty('totalApplied');
  });

  it('does not crash when no bus is provided', async () => {
    const curate = vi.fn(async (): Promise<CurationResult> =>
      makeCurationResult(['coder']),
    );
    const apply = vi.fn(async (): Promise<MutatorReport> => makeMutatorReport());

    // No `bus` field — should not throw.
    await expect(
      runAutoReforge({
        projectRoot: tmpDir,
        cycleId: 'cycle-005',
        involvedAgentIds: ['coder'],
        curateLearnings: curate,
        applyLearnings: apply,
      }),
    ).resolves.not.toThrow();
  });

  it('emits learnings.skipped bus event when curation is empty', async () => {
    const publishSpy = vi.fn();
    const bus = { publish: publishSpy };

    const curate = vi.fn(async (): Promise<CurationResult> => makeEmptyCurationResult());
    const apply = vi.fn(async (): Promise<MutatorReport> => makeMutatorReport());

    const result = await runAutoReforge({
      projectRoot: tmpDir,
      cycleId: 'cycle-006',
      involvedAgentIds: ['coder'],
      bus,
      curateLearnings: curate,
      applyLearnings: apply,
    });

    expect(result.skipped).toBe(true);
    expect(publishSpy).toHaveBeenCalledOnce();
    const [topic, payload] = publishSpy.mock.calls[0]!;
    expect(topic).toBe('learnings.skipped');
    expect(payload).toMatchObject({
      cycleId: 'cycle-006',
      reason: 'no-proposed-learnings',
      totalProposed: 0,
      involvedAgentIds: ['coder'],
    });
    expect(payload).toHaveProperty('generatedAt');
    expect(payload).toHaveProperty('sourcesScanned');
  });

  it('propagates curator errors (caller is responsible for swallowing)', async () => {
    const curate = vi.fn(async (): Promise<CurationResult> => {
      throw new Error('curator failed: JSONL parse error');
    });
    const apply = vi.fn(async (): Promise<MutatorReport> => makeMutatorReport());

    await expect(
      runAutoReforge({
        projectRoot: tmpDir,
        cycleId: 'cycle-007',
        involvedAgentIds: ['coder'],
        curateLearnings: curate,
        applyLearnings: apply,
      }),
    ).rejects.toThrow('curator failed: JSONL parse error');

    // Mutator must not be called if curator threw.
    expect(apply).not.toHaveBeenCalled();
  });

  it('propagates mutator errors (caller is responsible for swallowing)', async () => {
    const curate = vi.fn(async (): Promise<CurationResult> =>
      makeCurationResult(['coder']),
    );
    const apply = vi.fn(async (): Promise<MutatorReport> => {
      throw new Error('mutator write error');
    });

    await expect(
      runAutoReforge({
        projectRoot: tmpDir,
        cycleId: 'cycle-008',
        involvedAgentIds: ['coder'],
        curateLearnings: curate,
        applyLearnings: apply,
      }),
    ).rejects.toThrow('mutator write error');
  });
});

// ---------------------------------------------------------------------------
// extractInvolvedAgentIds
// ---------------------------------------------------------------------------

describe('extractInvolvedAgentIds', () => {
  it('extracts unique agent IDs from execute.json agentRuns', () => {
    const cyclesDir = join(tmpDir, '.agentforge', 'cycles', 'cycle-001', 'phases');
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(
      join(cyclesDir, 'execute.json'),
      JSON.stringify({
        agentRuns: [
          { itemId: 'T1', status: 'completed', agentId: 'coder' },
          { itemId: 'T2', status: 'completed', agentId: 'reviewer' },
          { itemId: 'T3', status: 'failed', agentId: 'coder' }, // duplicate
        ],
      }),
    );

    const ids = extractInvolvedAgentIds(tmpDir, 'cycle-001');
    expect(ids).toContain('coder');
    expect(ids).toContain('reviewer');
    expect(ids).toHaveLength(2); // deduped
  });

  it('reads itemResults when agentRuns is absent', () => {
    const cyclesDir = join(tmpDir, '.agentforge', 'cycles', 'cycle-002', 'phases');
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(
      join(cyclesDir, 'execute.json'),
      JSON.stringify({
        itemResults: [
          { itemId: 'T1', status: 'completed', agentId: 'backend-dev' },
        ],
      }),
    );

    const ids = extractInvolvedAgentIds(tmpDir, 'cycle-002');
    expect(ids).toEqual(['backend-dev']);
  });

  it('returns empty array when execute.json does not exist', () => {
    const ids = extractInvolvedAgentIds(tmpDir, 'cycle-missing');
    expect(ids).toEqual([]);
  });

  it('returns empty array when execute.json is malformed JSON', () => {
    const cyclesDir = join(tmpDir, '.agentforge', 'cycles', 'cycle-bad', 'phases');
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(join(cyclesDir, 'execute.json'), 'not-json{{{');

    const ids = extractInvolvedAgentIds(tmpDir, 'cycle-bad');
    expect(ids).toEqual([]);
  });

  it('skips entries with missing or non-string agentId', () => {
    const cyclesDir = join(tmpDir, '.agentforge', 'cycles', 'cycle-partial', 'phases');
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(
      join(cyclesDir, 'execute.json'),
      JSON.stringify({
        agentRuns: [
          { itemId: 'T1', status: 'completed', agentId: 'coder' },
          { itemId: 'T2', status: 'completed' }, // no agentId
          { itemId: 'T3', status: 'completed', agentId: 42 }, // wrong type
          { itemId: 'T4', status: 'completed', agentId: '' }, // empty string
        ],
      }),
    );

    const ids = extractInvolvedAgentIds(tmpDir, 'cycle-partial');
    expect(ids).toEqual(['coder']);
  });
});
