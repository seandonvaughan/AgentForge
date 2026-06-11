import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ItemCheckpointWriter,
  type ExecuteProgress,
} from '../item-checkpoint.js';

const CYCLE_ID = 'costs001';

function checkpointPath(root: string): string {
  return join(root, '.agentforge', 'cycles', CYCLE_ID, 'checkpoint-execute.json');
}

function readProgress(root: string): ExecuteProgress {
  return JSON.parse(readFileSync(checkpointPath(root), 'utf8')) as ExecuteProgress;
}

describe('ItemCheckpointWriter completed item costs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-cost-ckpt-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes and reads completed item cost and agent metadata', async () => {
    const writer = new ItemCheckpointWriter(root, 3);

    await writer.enqueue(CYCLE_ID, 'item-cost0001', 'completed', 'agent-costs', {
      stepScore: 0.75,
      costUsd: 1.23,
    });
    await writer.flush();

    const progress = readProgress(root);
    expect(progress.schemaVersion).toBe(3);
    expect(progress.completedItemIds).toEqual(['item-cost0001']);
    expect(progress.completedItems).toEqual([
      {
        itemId: 'item-cost0001',
        agentId: 'agent-costs',
        costUsd: 1.23,
        completedAt: expect.any(String),
        stepScore: 0.75,
      },
    ]);

    const metadata = ItemCheckpointWriter.getCompletedItemMetadata(root, CYCLE_ID);
    expect(metadata.get('item-cost0001')).toMatchObject({
      itemId: 'item-cost0001',
      agentId: 'agent-costs',
      costUsd: 1.23,
      stepScore: 0.75,
    });
  });

  it('does not write failed or skipped item ids or metadata', async () => {
    const writer = new ItemCheckpointWriter(root, 3);

    await writer.enqueue(CYCLE_ID, 'item-cost0001', 'failed', 'agent-costs', { costUsd: 0.25 });
    await writer.enqueue(CYCLE_ID, 'item-cost0002', 'skipped', 'agent-costs', { costUsd: 0 });
    await writer.flush();

    const progress = readProgress(root);
    expect(progress.schemaVersion).toBe(3);
    expect(progress.completedItemIds).toEqual([]);
    expect(progress.completedItems).toEqual([]);
    expect(ItemCheckpointWriter.getCompletedItemMetadata(root, CYCLE_ID).size).toBe(0);
  });

  it('reads schemaVersion 2 checkpoints as resume ids with no cost metadata', () => {
    const dir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      checkpointPath(root),
      JSON.stringify({
        cycleId: CYCLE_ID,
        phase: 'execute',
        completedItemIds: ['item-cost0001'],
        currentItemId: null,
        totalItems: 1,
        lastUpdatedAt: new Date().toISOString(),
        schemaVersion: 2,
      }),
    );

    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID)).toEqual(
      new Set(['item-cost0001']),
    );
    expect(ItemCheckpointWriter.getCompletedItemMetadata(root, CYCLE_ID).size).toBe(0);
  });
});
