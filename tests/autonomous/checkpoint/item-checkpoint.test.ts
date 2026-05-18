// tests/autonomous/checkpoint/item-checkpoint.test.ts
//
// Wave 5 T1 — per-item intra-phase checkpoint writer tests.
//
// Covers:
//   - Atomic write contract (.tmp never observable after success)
//   - Concurrent-write serialisation (100-iteration fuzz)
//   - completedItemIds monotonically non-decreasing across resume writes
//   - Crash-resume: skip items in completedItemIds, re-run remaining
//   - Invalid cycleId / itemId segments rejected (match-then-use)

import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ItemCheckpointWriter,
  type ExecuteProgress,
  type ItemCheckpoint,
} from '../../../packages/core/src/autonomous/checkpoint/item-checkpoint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'item-ckpt-'));
}

const CYCLE_ID = 'cycle-abcd1234';

function checkpointPath(root: string): string {
  return join(root, '.agentforge', 'cycles', CYCLE_ID, 'checkpoint.json');
}

function readProgress(root: string): ExecuteProgress {
  return JSON.parse(readFileSync(checkpointPath(root), 'utf8')) as ExecuteProgress;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ItemCheckpointWriter', () => {
  let root: string;
  let writer: ItemCheckpointWriter;

  beforeEach(() => {
    root = makeTmpRoot();
    writer = new ItemCheckpointWriter(root, 8);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── Basic write ────────────────────────────────────────────────────────────

  it('writes checkpoint.json after first enqueue', async () => {
    await writer.enqueue(CYCLE_ID, 'item-aabbccdd', 'completed', 'coder-agent', 0.85);
    const progress = readProgress(root);
    expect(progress.schemaVersion).toBe(2);
    expect(progress.phase).toBe('execute');
    expect(progress.cycleId).toBe(CYCLE_ID);
    expect(progress.completedItemIds).toContain('item-aabbccdd');
    expect(progress.totalItems).toBe(8);
  });

  it('records failed status in completedItemIds', async () => {
    await writer.enqueue(CYCLE_ID, 'item-aabbccdd', 'failed', 'coder-agent', null);
    const progress = readProgress(root);
    expect(progress.completedItemIds).toContain('item-aabbccdd');
  });

  it('records skipped status in completedItemIds', async () => {
    await writer.enqueue(CYCLE_ID, 'item-aabbccdd', 'skipped', 'coder-agent', null);
    const progress = readProgress(root);
    expect(progress.completedItemIds).toContain('item-aabbccdd');
  });

  // ── Atomic write ───────────────────────────────────────────────────────────

  it('never leaves a .tmp file observable after success', async () => {
    await writer.enqueue(CYCLE_ID, 'item-aabbccdd', 'completed');
    const dir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('checkpoint.json');
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  it('deduplicates repeated enqueues for the same itemId', async () => {
    await writer.enqueue(CYCLE_ID, 'item-aabbccdd', 'completed');
    await writer.enqueue(CYCLE_ID, 'item-aabbccdd', 'completed');
    const progress = readProgress(root);
    const occurrences = progress.completedItemIds.filter((id) => id === 'item-aabbccdd');
    expect(occurrences).toHaveLength(1);
  });

  // ── Monotonic non-decreasing ───────────────────────────────────────────────

  it('completedItemIds is monotonically non-decreasing across writes', async () => {
    const ids = ['item-aa000001', 'item-aa000002', 'item-aa000003'];
    for (const id of ids) {
      await writer.enqueue(CYCLE_ID, id, 'completed');
      const progress = readProgress(root);
      // Every already-written id must still be present
      for (const written of ids.slice(0, ids.indexOf(id) + 1)) {
        expect(progress.completedItemIds).toContain(written);
      }
    }
  });

  // ── Flush ──────────────────────────────────────────────────────────────────

  it('flush() resolves after all enqueued writes', async () => {
    writer.enqueue(CYCLE_ID, 'item-aa000001', 'completed');
    writer.enqueue(CYCLE_ID, 'item-aa000002', 'completed');
    writer.enqueue(CYCLE_ID, 'item-aa000003', 'failed');
    await writer.flush();
    const progress = readProgress(root);
    expect(progress.completedItemIds).toHaveLength(3);
  });

  // ── Concurrent-write serialisation fuzz ───────────────────────────────────

  it('100-iteration concurrent fuzz: no partial-write JSON, all items present', async () => {
    const itemCount = 8;
    const ids = Array.from({ length: itemCount }, (_, i) =>
      `item-${String(i).padStart(8, '0')}-abcd`
    );

    for (let iteration = 0; iteration < 100; iteration++) {
      const localRoot = makeTmpRoot();
      const localWriter = new ItemCheckpointWriter(localRoot, itemCount);
      // Fire all enqueues concurrently — they must serialize internally.
      await Promise.all(
        ids.map((id) => localWriter.enqueue(CYCLE_ID, id, 'completed', 'coder-agent', 1.0)),
      );
      await localWriter.flush();

      // Checkpoint must be valid JSON.
      const raw = readFileSync(
        join(localRoot, '.agentforge', 'cycles', CYCLE_ID, 'checkpoint.json'),
        'utf8',
      );
      let progress: ExecuteProgress;
      try {
        progress = JSON.parse(raw) as ExecuteProgress;
      } catch {
        rmSync(localRoot, { recursive: true, force: true });
        throw new Error(`Iteration ${iteration}: checkpoint.json is not valid JSON`);
      }

      // All itemIds must be present.
      for (const id of ids) {
        if (!progress.completedItemIds.includes(id)) {
          rmSync(localRoot, { recursive: true, force: true });
          throw new Error(`Iteration ${iteration}: missing itemId ${id}`);
        }
      }

      rmSync(localRoot, { recursive: true, force: true });
    }
  });

  // ── Crash-resume simulation ────────────────────────────────────────────────

  it('crash-resume: getCompletedItemIds returns previously written ids', async () => {
    const completedIds = ['item-aa000001', 'item-aa000002', 'item-aa000003'];
    for (const id of completedIds) {
      await writer.enqueue(CYCLE_ID, id, 'completed');
    }
    await writer.flush();

    // Simulate resume: read completed set from disk.
    const completed = ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID);
    expect(completed.size).toBe(3);
    for (const id of completedIds) {
      expect(completed.has(id)).toBe(true);
    }
  });

  it('crash-resume: remaining items (not in completedItemIds) are re-runnable', async () => {
    const allItems = Array.from({ length: 8 }, (_, i) => `item-${String(i).padStart(8, '0')}-ab12`);
    const completedBefore = allItems.slice(0, 3);

    for (const id of completedBefore) {
      await writer.enqueue(CYCLE_ID, id, 'completed');
    }
    await writer.flush();

    const completedSet = ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID);
    const remaining = allItems.filter((id) => !completedSet.has(id));
    // 8 total - 3 completed = 5 remaining
    expect(remaining).toHaveLength(5);
    for (const id of completedBefore) {
      expect(remaining).not.toContain(id);
    }
  });

  // ── readProgress / getCompletedItemIds ────────────────────────────────────

  it('readProgress returns null when no checkpoint exists', () => {
    const result = ItemCheckpointWriter.readProgress(root, CYCLE_ID);
    expect(result).toBeNull();
  });

  it('getCompletedItemIds returns empty Set when no checkpoint exists', () => {
    const ids = ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID);
    expect(ids.size).toBe(0);
  });

  it('readProgress returns null for malformed JSON (never throws)', () => {
    const path = checkpointPath(root);
    mkdirSync(join(root, '.agentforge', 'cycles', CYCLE_ID), { recursive: true });
    writeFileSync(path, '{ not valid json');
    expect(ItemCheckpointWriter.readProgress(root, CYCLE_ID)).toBeNull();
  });

  it('readProgress returns null for wrong schemaVersion', () => {
    const path = checkpointPath(root);
    mkdirSync(join(root, '.agentforge', 'cycles', CYCLE_ID), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, cycleId: CYCLE_ID, phase: 'execute', completedItemIds: [] }),
    );
    expect(ItemCheckpointWriter.readProgress(root, CYCLE_ID)).toBeNull();
  });

  // ── Path validation (match-then-use) ─────────────────────────────────────

  it('rejects invalid cycleId (path traversal attempt)', async () => {
    await expect(
      writer.enqueue('../../../etc', 'item-aabbccdd', 'completed'),
    ).resolves.toBeUndefined(); // enqueue swallows; but readProgress should reject
    // The write is silently swallowed but readProgress with a bad id never blows up
    expect(() => ItemCheckpointWriter.readProgress(root, '../../../etc')).not.toThrow();
    expect(ItemCheckpointWriter.readProgress(root, '../../../etc')).toBeNull();
  });

  it('safeSegment validation via readProgress on bad cycleId', () => {
    expect(ItemCheckpointWriter.readProgress(root, 'bad!!id')).toBeNull();
    expect(ItemCheckpointWriter.readProgress(root, '')).toBeNull();
  });
});
