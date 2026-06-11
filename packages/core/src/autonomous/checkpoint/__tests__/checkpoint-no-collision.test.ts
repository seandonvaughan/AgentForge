import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ItemCheckpointWriter } from '../item-checkpoint.js';
import { writeCheckpoint, readCheckpoint } from '../../cycle-artifacts/cycle-checkpoint.js';

const CYCLE_ID = 'collide01';

interface TestExecuteProgress {
  schemaVersion: number;
  completedItemIds: string[];
  completedItems?: Array<{ itemId: string; costUsd: number; agentId: string }>;
}

function readExecuteProgress(root: string, cycleId: string): TestExecuteProgress {
  return JSON.parse(
    readFileSync(join(root, '.agentforge', 'cycles', cycleId, 'checkpoint-execute.json'), 'utf8'),
  ) as TestExecuteProgress;
}

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

  it('writes schemaVersion 3 completed item cost and agent metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));

    const w = new ItemCheckpointWriter(root, 2);
    await w.enqueue(CYCLE_ID, 'i1', 'completed', 'agent-01', null, 1.25);
    await w.flush();

    const progress = readExecuteProgress(root, CYCLE_ID);
    expect(progress.schemaVersion).toBe(3);
    expect(progress.completedItemIds).toEqual(['i1']);
    expect(progress.completedItems).toEqual([
      { itemId: 'i1', costUsd: 1.25, agentId: 'agent-01' },
    ]);
  });

  it('derives completed item cost from execute.json when the caller omits it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));
    const phasesDir = join(root, '.agentforge', 'cycles', CYCLE_ID, 'phases');
    mkdirSync(phasesDir, { recursive: true });
    writeFileSync(
      join(phasesDir, 'execute.json'),
      JSON.stringify({
        phase: 'execute',
        itemResults: [{ itemId: 'i1', status: 'completed', costUsd: 0.42 }],
      }),
    );

    const w = new ItemCheckpointWriter(root, 1);
    await w.enqueue(CYCLE_ID, 'i1', 'completed', 'agent-01');
    await w.flush();

    expect(readExecuteProgress(root, CYCLE_ID).completedItems).toEqual([
      { itemId: 'i1', costUsd: 0.42, agentId: 'agent-01' },
    ]);
  });

  it('does not mark failed or skipped items completed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));

    const w = new ItemCheckpointWriter(root, 2);
    await w.enqueue(CYCLE_ID, 'i1', 'failed', 'agent-01', null, 2.5);
    await w.enqueue(CYCLE_ID, 'i2', 'skipped', 'agent-02', null, 3.5);
    await w.flush();

    const progress = readExecuteProgress(root, CYCLE_ID);
    expect(progress.completedItemIds).toEqual([]);
    expect(progress.completedItems).toEqual([]);
    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID)).toEqual(new Set());
  });

  it('reads legacy schemaVersion 2 checkpoints by completed item id', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));
    const cycleDir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(
      join(cycleDir, 'checkpoint-execute.json'),
      JSON.stringify({
        cycleId: CYCLE_ID,
        phase: 'execute',
        completedItemIds: ['legacy-1'],
        currentItemId: null,
        totalItems: 1,
        lastUpdatedAt: new Date().toISOString(),
        schemaVersion: 2,
      }),
    );

    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID)).toEqual(new Set(['legacy-1']));
    expect(ItemCheckpointWriter.readProgress(root, CYCLE_ID)?.completedItems).toEqual([]);
  });

  it('returns empty progress for invalid or corrupt checkpoints without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));
    const cycleDir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(join(cycleDir, 'checkpoint-execute.json'), '{not-json');

    expect(() => ItemCheckpointWriter.readProgress(root, CYCLE_ID)).not.toThrow();
    expect(() => ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID)).not.toThrow();
    expect(ItemCheckpointWriter.readProgress(root, CYCLE_ID)).toBeNull();
    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID)).toEqual(new Set());
  });
});
