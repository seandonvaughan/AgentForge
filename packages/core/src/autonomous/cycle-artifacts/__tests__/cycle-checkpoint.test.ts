import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCheckpoint, writeCheckpoint } from '../cycle-checkpoint.js';

describe('cycle checkpoint persistence', () => {
  let tmpDir: string;
  const cycleId = 'cycle-checkpoint-0001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-checkpoint-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces an existing checkpoint on Windows-compatible filesystems', () => {
    const cycleDir = join(tmpDir, '.agentforge', 'cycles', cycleId);

    writeCheckpoint(cycleDir, {
      v: 1,
      cycleId,
      capturedAt: '2026-05-25T00:00:00.000Z',
      resumeFromPhase: 'audit',
      completedPhases: [],
      budgetUsd: 200,
      spentUsd: 0,
    });
    writeCheckpoint(cycleDir, {
      v: 1,
      cycleId,
      capturedAt: '2026-05-25T00:01:00.000Z',
      resumeFromPhase: 'plan',
      completedPhases: ['audit'],
      budgetUsd: 200,
      spentUsd: 0.5,
    });

    expect(readCheckpoint(cycleDir)).toMatchObject({
      resumeFromPhase: 'plan',
      completedPhases: ['audit'],
      spentUsd: 0.5,
    });
    expect(existsSync(join(cycleDir, 'checkpoint.json.tmp'))).toBe(false);
  });
});

describe('cycle-checkpoint filename split (PR-1)', () => {
  let tmpDir: string;
  const cycleId = 'cycle-checkpoint-0001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-checkpoint-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes to checkpoint-cycle.json, not checkpoint.json', () => {
    const cycleDir = join(tmpDir, '.agentforge', 'cycles', cycleId);
    writeCheckpoint(cycleDir, {
      v: 1,
      cycleId,
      capturedAt: new Date().toISOString(),
      resumeFromPhase: 'audit',
      completedPhases: [],
      budgetUsd: 100,
      spentUsd: 0,
    });
    expect(existsSync(join(cycleDir, 'checkpoint-cycle.json'))).toBe(true);
    expect(existsSync(join(cycleDir, 'checkpoint.json'))).toBe(false);
  });

  it('reads back from checkpoint-cycle.json', () => {
    const cycleDir = join(tmpDir, '.agentforge', 'cycles', cycleId);
    writeCheckpoint(cycleDir, {
      v: 1,
      cycleId,
      capturedAt: new Date().toISOString(),
      resumeFromPhase: 'audit',
      completedPhases: [],
      budgetUsd: 100,
      spentUsd: 0,
    });
    expect(readCheckpoint(cycleDir)?.cycleId).toBe(cycleId);
  });

  it('read-shim: falls back to legacy checkpoint.json when new file absent', () => {
    const cycleDir = join(tmpDir, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(
      join(cycleDir, 'checkpoint.json'),
      JSON.stringify(
        {
          v: 1,
          cycleId,
          capturedAt: new Date().toISOString(),
          resumeFromPhase: 'audit',
          completedPhases: [],
          budgetUsd: 100,
          spentUsd: 0,
        },
        null,
        2,
      ),
    );
    expect(readCheckpoint(cycleDir)?.cycleId).toBe(cycleId);
  });
});
