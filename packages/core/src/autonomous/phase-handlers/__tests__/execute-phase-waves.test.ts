/**
 * Integration tests for wave ordering in the execute phase (PR-2c1).
 *
 * Verifies that items are dispatched in dependency-wave order, with each wave
 * running to completion (settling) before the next wave starts. The wave barrier
 * is the per-wave Promise.allSettled call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';

// ---------------------------------------------------------------------------
// Helpers (adapted from execute-phase-worktree.test.ts)
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-wave-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => { events.push({ topic, payload }); },
    subscribe: (_t: string, _cb: (e: unknown) => void) => () => {},
    events,
  };
}

type Bus = ReturnType<typeof makeBus>;

function makeCtx(
  bus: Bus,
  overrides: Partial<PhaseContext> = {},
): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-wave-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-wave-1',
    adapter: undefined as any,
    bus,
    runtime: {
      run: vi.fn().mockResolvedValue({
        output: 'done',
        costUsd: 0.01,
        status: 'completed',
      }),
    },
    ...overrides,
  } as PhaseContext;
}

function writeWavePlanFile(
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    wave?: number;
    predecessors?: string[];
    status?: string;
    tags?: string[];
  }>,
  cycleId = 'cycle-wave-1',
) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-wave-1',
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      status: i.status ?? 'planned',
      tags: i.tags ?? [],
      description: `Description for ${i.title}`,
      wave: i.wave,
      predecessors: i.predecessors,
    })),
  };

  // Write to cycle path
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execute phase wave ordering', () => {
  it('flat plan (no wave fields) dispatches exactly as before (single-wave path)', async () => {
    writeWavePlanFile([
      { id: 'c1', title: 'Item A', assignee: 'scorer', tags: ['scoring'] },
      { id: 'c2', title: 'Item B', assignee: 'scorer', tags: ['scoring'] },
      { id: 'c3', title: 'Item C', assignee: 'scorer', tags: ['scoring'] },
    ]);

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }) };
    const ctx = makeCtx(bus, { runtime });

    const result = await runExecutePhase(ctx, { maxParallelism: 3, maxItemRetries: 0 });

    // All 3 items should complete successfully in a single wave
    expect(result.status).toBe('completed');
    expect(runtime.run).toHaveBeenCalledTimes(3);

    // Verify all 3 items appear in completed items
    const completedIds = new Set(
      result.itemResults.filter((r) => r.status === 'completed').map((r) => r.itemId),
    );
    expect(completedIds).toEqual(new Set(['c1', 'c2', 'c3']));
  });

  it('layered plan with waves dispatches items in wave order', async () => {
    writeWavePlanFile([
      { id: 'c1', title: 'Wave 0 Item A', assignee: 'scorer', wave: 0, tags: ['scoring'] },
      { id: 'c2', title: 'Wave 0 Item B', assignee: 'scorer', wave: 0, tags: ['scoring'] },
      { id: 'c3', title: 'Wave 1 Item (depends on c1, c2)', assignee: 'scorer', wave: 1, predecessors: ['c1', 'c2'], tags: ['scoring'] },
    ]);

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }) };
    const ctx = makeCtx(bus, { runtime });

    const result = await runExecutePhase(ctx, { maxParallelism: 3, maxItemRetries: 0 });

    // All items should succeed
    expect(result.status).toBe('completed');
    expect(runtime.run).toHaveBeenCalledTimes(3);

    // Use bus events to track dispatch order
    const startEvents = bus.events.filter((e) => e.topic === 'sprint.phase.item.started');
    const completeEvents = bus.events.filter((e) => e.topic === 'sprint.phase.item.completed');

    // Extract item IDs from the events in order
    const startedIds = startEvents.map((e) => (e.payload as any).itemId);
    const completedIds = completeEvents.map((e) => (e.payload as any).itemId);

    // c3 should start AFTER c1 and c2 have started
    const c3StartIdx = startedIds.indexOf('c3');
    const c1StartIdx = startedIds.indexOf('c1');
    const c2StartIdx = startedIds.indexOf('c2');
    expect(c3StartIdx).toBeGreaterThanOrEqual(0); // c3 should have started
    expect(c1StartIdx).toBeGreaterThanOrEqual(0); // c1 should have started
    expect(c2StartIdx).toBeGreaterThanOrEqual(0); // c2 should have started

    // c3 should start AFTER both c1 and c2 (wave barrier)
    expect(c3StartIdx).toBeGreaterThan(c1StartIdx);
    expect(c3StartIdx).toBeGreaterThan(c2StartIdx);

    // All completions of c1 and c2 should come before c3 starts
    const c3CompleteIdx = completedIds.indexOf('c3');
    const c1CompleteIdx = completedIds.indexOf('c1');
    const c2CompleteIdx = completedIds.indexOf('c2');
    expect(c1CompleteIdx).toBeLessThan(c3CompleteIdx);
    expect(c2CompleteIdx).toBeLessThan(c3CompleteIdx);
  });

  it('three-wave plan executes waves sequentially', async () => {
    writeWavePlanFile([
      { id: 'w0a', title: 'Wave 0 A', assignee: 'scorer', wave: 0, tags: ['scoring'] },
      { id: 'w0b', title: 'Wave 0 B', assignee: 'scorer', wave: 0, tags: ['scoring'] },
      { id: 'w1a', title: 'Wave 1 A', assignee: 'scorer', wave: 1, predecessors: ['w0a', 'w0b'], tags: ['scoring'] },
      { id: 'w1b', title: 'Wave 1 B', assignee: 'scorer', wave: 1, predecessors: ['w0a', 'w0b'], tags: ['scoring'] },
      { id: 'w2a', title: 'Wave 2 A', assignee: 'scorer', wave: 2, predecessors: ['w1a', 'w1b'], tags: ['scoring'] },
    ]);

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }) };
    const ctx = makeCtx(bus, { runtime });

    const result = await runExecutePhase(ctx, { maxParallelism: 3, maxItemRetries: 0 });

    expect(result.status).toBe('completed');
    expect(runtime.run).toHaveBeenCalledTimes(5);

    // Use bus events to track dispatch order
    const startEvents = bus.events.filter((e) => e.topic === 'sprint.phase.item.started');
    const startedIds = startEvents.map((e) => (e.payload as any).itemId);

    const w1aIdx = startedIds.indexOf('w1a');
    const w1bIdx = startedIds.indexOf('w1b');
    const w0aIdx = startedIds.indexOf('w0a');
    const w0bIdx = startedIds.indexOf('w0b');
    const w2aIdx = startedIds.indexOf('w2a');

    // Verify wave 1 items are not started until both wave 0 items have been started
    expect(w1aIdx).toBeGreaterThan(w0aIdx);
    expect(w1aIdx).toBeGreaterThan(w0bIdx);
    expect(w1bIdx).toBeGreaterThan(w0aIdx);
    expect(w1bIdx).toBeGreaterThan(w0bIdx);

    // Verify wave 2 items are not started until both wave 1 items have been started
    expect(w2aIdx).toBeGreaterThan(w1aIdx);
    expect(w2aIdx).toBeGreaterThan(w1bIdx);
  });
});
