import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ItemCheckpointWriter } from '../item-checkpoint.js';
import { writeCheckpoint, readCheckpoint } from '../../cycle-artifacts/cycle-checkpoint.js';

const CYCLE_ID = 'collide01';

describe('checkpoint writers do not collide (PR-1)', () => {
  it('cycle and item checkpoints write distinct files; neither clobbers the other', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));
    const cycleDir = join(root, '.agentforge', 'cycles', CYCLE_ID);

    writeCheckpoint(cycleDir, {
      v: 1, cycleId: CYCLE_ID, capturedAt: new Date().toISOString(),
      resumeFromPhase: 'execute', completedPhases: ['audit', 'plan', 'assign'],
      budgetUsd: 100, spentUsd: 10,
    });

    const w = new ItemCheckpointWriter(root, 3);
    await w.enqueue(CYCLE_ID, 'i1', 'completed');
    await w.flush();

    expect(readCheckpoint(cycleDir)?.completedPhases).toEqual(['audit', 'plan', 'assign']);
    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID).has('i1')).toBe(true);
  });
});
