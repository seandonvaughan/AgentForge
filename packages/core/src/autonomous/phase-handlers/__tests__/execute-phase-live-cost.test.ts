/**
 * execute-phase-live-cost.test.ts
 *
 * Verifies that a completed item's costUsd is written to
 * phases/execute.json **immediately** when the agent finishes — before the
 * sprint.phase.item.completed bus event fires and before the phase returns.
 *
 * The tested invariant:
 *   When a dashboard consumer subscribes to `sprint.phase.item.completed` and
 *   synchronously reads phases/execute.json, the completed item's costUsd
 *   must already be present in itemResults.
 *
 * Without the code change (snapshotExecuteProgress called only at the END of
 * the finally block, after the event), the file is not yet updated at event
 * time and the captured costUsd would be -1 (file absent) → test fails.
 * With the change (snapshotExecuteProgress called right after liveResults.set
 * in the success path), the file is written before the event fires → test passes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';

// ---------------------------------------------------------------------------
// Shared helpers (mirrors the pattern in progress-events.test.ts)
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-live-cost-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  const bus = {
    publish: (topic: string, payload: unknown) => {
      events.push({ topic, payload });
    },
    subscribe: (_topic: string, _cb: (e: unknown) => void) => () => {},
    events,
  };
  return bus;
}

type MockBus = ReturnType<typeof makeBus>;

function makeCtx(bus: MockBus, overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-live-cost',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-live-cost',
    adapter: undefined as any,
    bus,
    runtime: {
      run: vi.fn().mockResolvedValue({
        output: 'mock agent output',
        costUsd: 0.5,
        status: 'completed',
      }),
    },
    ...overrides,
  } as PhaseContext;
}

/**
 * Write a minimal plan.json (and legacy sprints file) for the given items so
 * execute-phase can find it.
 */
function writeSprintFile(
  items: Array<{ id: string; title: string; assignee: string; status?: string }>,
  cycleId = 'cycle-live-cost',
) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-live-cost',
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      status: i.status ?? 'planned',
      description: `Description for ${i.title}`,
    })),
  };

  // New path (cycles/{cycleId}/plan.json)
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));

  // Legacy path (for code paths that fall back to it)
  const sprintsDir = join(tmpRoot, '.agentforge', 'sprints');
  mkdirSync(sprintsDir, { recursive: true });
  writeFileSync(join(sprintsDir, 'v1.0.0.json'), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Core assertion: costUsd is in execute.json when the item-completed event fires
// ---------------------------------------------------------------------------

describe('execute-phase live cost flushing', () => {
  it('completed item costUsd is in execute.json when sprint.phase.item.completed fires', async () => {
    const cycleId = 'cycle-live-cost';
    writeSprintFile([{ id: 'item-1', title: 'Add feature', assignee: 'backend-dev' }], cycleId);

    const snapshotPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      cycleId,
      'phases',
      'execute.json',
    );

    const bus = makeBus();
    // Intercept sprint.phase.item.completed and read the snapshot synchronously.
    // At this point the file MUST already contain the completed item's costUsd.
    let costAtEventTime = -1; // -1 = file absent; 0 = file present but no cost
    const originalPublish = bus.publish.bind(bus);
    bus.publish = (topic: string, payload: unknown) => {
      if (topic === 'sprint.phase.item.completed' && existsSync(snapshotPath)) {
        const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        const found = (snap.itemResults as Array<{ itemId: string; costUsd: number }> | undefined)?.find(
          (r) => r.itemId === 'item-1',
        );
        if (found !== undefined) {
          costAtEventTime = found.costUsd;
        }
      }
      originalPublish(topic, payload);
    };

    const ctx = makeCtx(bus, { cycleId });
    // Return costUsd: 0.5 from the mock runtime
    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: 'done',
      costUsd: 0.5,
      status: 'completed',
    });

    const { runExecutePhase } = await import('../execute-phase.js');
    await runExecutePhase(ctx, { selfEvalDisabled: true, disableWorktrees: true });

    // The snapshot must have been written BEFORE the event fired.
    // costAtEventTime === -1  → file was absent at event time (regression)
    // costAtEventTime ===  0  → file existed but item's cost was missing (regression)
    // costAtEventTime === 0.5 → correct: cost flushed before event (desired behaviour)
    expect(costAtEventTime).toBe(0.5);
  });

  it('execute.json contains correct per-item costUsd after phase completes', async () => {
    const cycleId = 'cycle-live-cost-final';
    writeSprintFile(
      [
        { id: 'item-a', title: 'Task A', assignee: 'agent-a' },
        { id: 'item-b', title: 'Task B', assignee: 'agent-b' },
      ],
      cycleId,
    );

    const snapshotPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      cycleId,
      'phases',
      'execute.json',
    );

    const bus = makeBus();
    const ctx = makeCtx(bus, { cycleId });
    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: 'done',
      costUsd: 1.25,
      status: 'completed',
    });

    const { runExecutePhase } = await import('../execute-phase.js');
    const result = await runExecutePhase(ctx, { selfEvalDisabled: true, disableWorktrees: true });

    // Phase result itself
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBeCloseTo(2.5); // 2 items × 1.25

    // Persisted snapshot must have per-item costUsd
    expect(existsSync(snapshotPath)).toBe(true);
    const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const items = snap.itemResults as Array<{ itemId: string; costUsd: number }>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.costUsd).toBe(1.25);
    }
  });

  it('phase-level costUsd in snapshot equals sum of completed item costs', async () => {
    const cycleId = 'cycle-live-cost-sum';
    writeSprintFile(
      [
        { id: 'item-x', title: 'Task X', assignee: 'agent-x' },
        { id: 'item-y', title: 'Task Y', assignee: 'agent-y' },
        { id: 'item-z', title: 'Task Z', assignee: 'agent-z' },
      ],
      cycleId,
    );

    const snapshotPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      cycleId,
      'phases',
      'execute.json',
    );

    const bus = makeBus();
    const ctx = makeCtx(bus, { cycleId });
    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: 'ok',
      costUsd: 0.3,
      status: 'completed',
    });

    const { runExecutePhase } = await import('../execute-phase.js');
    await runExecutePhase(ctx, { selfEvalDisabled: true, disableWorktrees: true });

    expect(existsSync(snapshotPath)).toBe(true);
    const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));

    // Top-level costUsd must equal sum of all item costUsds
    const itemCosts = (snap.itemResults as Array<{ costUsd: number }>).map((r) => r.costUsd);
    const sum = itemCosts.reduce((a, b) => a + b, 0);
    expect(snap.costUsd).toBeCloseTo(sum);
  });
});
