// tests/autonomous/cycle-artifacts/cycle-checkpoint.test.ts
//
// Wave 3 T5 — durability contract tests for cycle-checkpoint.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CycleCheckpointSchema,
  readCheckpoint,
  writeCheckpoint,
  type CycleCheckpoint,
} from '../../../packages/core/src/autonomous/cycle-artifacts/cycle-checkpoint.js';

function makeCheckpoint(overrides: Partial<CycleCheckpoint> = {}): CycleCheckpoint {
  return {
    v: 1,
    cycleId: 'abcd1234-test',
    capturedAt: new Date().toISOString(),
    resumeFromPhase: 'execute',
    completedPhases: ['audit', 'plan', 'assign'],
    budgetUsd: 30,
    spentUsd: 1.5,
    ...overrides,
  };
}

describe('cycle-checkpoint', () => {
  let root: string;
  let cycleDir: string;
  const cycleId = 'abcd1234-test';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ckpt-'));
    cycleDir = join(root, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('writeCheckpoint', () => {
    it('writes a valid checkpoint to checkpoint-cycle.json', () => {
      const ckpt = makeCheckpoint();
      writeCheckpoint(cycleDir, ckpt);

      const path = join(cycleDir, 'checkpoint-cycle.json');
      expect(existsSync(path)).toBe(true);
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      expect(raw.v).toBe(1);
      expect(raw.cycleId).toBe(cycleId);
      expect(raw.resumeFromPhase).toBe('execute');
      expect(raw.completedPhases).toEqual(['audit', 'plan', 'assign']);
    });

    it('is atomic — never leaves a half-written .tmp behind on success', () => {
      writeCheckpoint(cycleDir, makeCheckpoint());
      const files = readdirSync(cycleDir);
      expect(files).toContain('checkpoint-cycle.json');
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('overwrites an existing checkpoint atomically', () => {
      writeCheckpoint(cycleDir, makeCheckpoint({ completedPhases: ['audit'] }));
      writeCheckpoint(
        cycleDir,
        makeCheckpoint({ completedPhases: ['audit', 'plan'], resumeFromPhase: 'assign' }),
      );
      const raw = JSON.parse(readFileSync(join(cycleDir, 'checkpoint-cycle.json'), 'utf8'));
      expect(raw.completedPhases).toEqual(['audit', 'plan']);
      expect(raw.resumeFromPhase).toBe('assign');
    });

    it('load-merges existing completed phases into later checkpoint writes', () => {
      writeCheckpoint(
        cycleDir,
        makeCheckpoint({
          completedPhases: ['audit', 'plan', 'assign'],
          resumeFromPhase: 'execute',
        }),
      );

      writeCheckpoint(
        cycleDir,
        makeCheckpoint({
          capturedAt: '2026-06-11T00:00:00.000Z',
          completedPhases: ['execute'],
          resumeFromPhase: 'test',
          spentUsd: 2,
        }),
      );

      const raw = JSON.parse(readFileSync(join(cycleDir, 'checkpoint-cycle.json'), 'utf8'));
      expect(raw.resumeFromPhase).toBe('test');
      expect(raw.completedPhases).toEqual(['audit', 'plan', 'assign', 'execute']);
      expect(raw.spentUsd).toBe(2);
    });

    it('leaves a resume checkpoint byte-identical when a failed resume adds no progress', () => {
      writeCheckpoint(
        cycleDir,
        makeCheckpoint({
          capturedAt: '2026-06-11T00:00:00.000Z',
          completedPhases: ['audit', 'plan', 'assign'],
          resumeFromPhase: 'execute',
          spentUsd: 1.5,
        }),
      );
      const checkpointPath = join(cycleDir, 'checkpoint-cycle.json');
      const before = readFileSync(checkpointPath, 'utf8');

      writeCheckpoint(
        cycleDir,
        makeCheckpoint({
          capturedAt: '2026-06-11T00:01:00.000Z',
          completedPhases: [],
          resumeFromPhase: 'execute',
          spentUsd: 0,
        }),
      );

      expect(readFileSync(checkpointPath, 'utf8')).toBe(before);
    });

    it('persists optional executeProgress when provided', () => {
      const ckpt = makeCheckpoint({
        resumeFromPhase: 'test',
        completedPhases: ['audit', 'plan', 'assign', 'execute'],
        executeProgress: {
          completedItemIds: ['i1', 'i2'],
          inFlightItemIds: [],
          costSoFarUsd: 4.25,
          agentOutputs: { i1: { ok: true } },
        },
      });
      writeCheckpoint(cycleDir, ckpt);
      const round = readCheckpoint(cycleDir);
      expect(round?.executeProgress?.completedItemIds).toEqual(['i1', 'i2']);
      expect(round?.executeProgress?.costSoFarUsd).toBe(4.25);
    });

    it('throws on schema-invalid input (e.g. negative cost)', () => {
      expect(() =>
        writeCheckpoint(cycleDir, makeCheckpoint({ spentUsd: -1 })),
      ).toThrow();
    });

    it('rejects an invalid cycleId in the path (match-then-use)', () => {
      const badDir = join(root, '.agentforge', 'cycles', '../escape');
      // Even if the dir resolves, our regex rejects '../escape' as cycleId.
      expect(() => writeCheckpoint(badDir, makeCheckpoint())).toThrow(/cycleId/);
    });
  });

  describe('readCheckpoint', () => {
    it('returns null when checkpoint.json is missing (ENOENT)', () => {
      expect(readCheckpoint(cycleDir)).toBeNull();
    });

    it('returns null when cycleDir itself does not exist (never throws)', () => {
      const missing = join(root, '.agentforge', 'cycles', 'zzzzzzzz-gone');
      expect(readCheckpoint(missing)).toBeNull();
    });

    it('round-trips a written checkpoint', () => {
      const ckpt = makeCheckpoint();
      writeCheckpoint(cycleDir, ckpt);
      const out = readCheckpoint(cycleDir);
      expect(out).not.toBeNull();
      expect(out!.cycleId).toBe(ckpt.cycleId);
      expect(out!.completedPhases).toEqual(ckpt.completedPhases);
      expect(out!.budgetUsd).toBe(30);
      expect(out!.spentUsd).toBe(1.5);
    });

    it('returns null for malformed JSON (never throws)', () => {
      writeFileSync(join(cycleDir, 'checkpoint.json'), '{ not json');
      expect(readCheckpoint(cycleDir)).toBeNull();
    });

    it('returns null for schema-mismatched JSON (never throws)', () => {
      writeFileSync(
        join(cycleDir, 'checkpoint.json'),
        JSON.stringify({ v: 2, cycleId: 'x', resumeFromPhase: 'audit' }),
      );
      expect(readCheckpoint(cycleDir)).toBeNull();
    });

    it('returns null when cycleDir has an invalid trailing id (never throws)', () => {
      const badDir = join(root, '.agentforge', 'cycles', '!!!');
      expect(readCheckpoint(badDir)).toBeNull();
    });
  });

  describe('CycleCheckpointSchema', () => {
    it('accepts the minimal valid checkpoint', () => {
      const result = CycleCheckpointSchema.safeParse(makeCheckpoint());
      expect(result.success).toBe(true);
    });

    it('rejects v !== 1', () => {
      const result = CycleCheckpointSchema.safeParse({ ...makeCheckpoint(), v: 2 });
      expect(result.success).toBe(false);
    });

    it('rejects unknown phase names', () => {
      const result = CycleCheckpointSchema.safeParse({
        ...makeCheckpoint(),
        resumeFromPhase: 'nope',
      });
      expect(result.success).toBe(false);
    });
  });
});
