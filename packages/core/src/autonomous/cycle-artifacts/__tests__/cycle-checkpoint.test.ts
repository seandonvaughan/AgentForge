import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
