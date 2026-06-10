/**
 * Tests for the live per-item costUsd publish fix.
 *
 * Before the fix, snapshotExecuteProgress() was only called at the END of
 * each item's finally block — AFTER async worktree commit/push/release
 * operations.  Mid-flight readers (dashboard Epic tab, spend-report generator)
 * therefore saw costUsd: 0 for all items until the whole phase ended.
 *
 * After the fix, snapshotExecuteProgress() is called IMMEDIATELY after
 * liveResults.set(completedResult), so execute.json already carries the
 * nonzero costUsd by the time the worktree release() is called.
 *
 * The key test (live-cost-before-release) uses a mock worktree pool whose
 * release() spy reads the execute.json snapshot.  Without the fix the
 * snapshot still shows costUsd: 0 (written when the item STARTED).  With the
 * fix the snapshot shows the real costUsd written right after completion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-live-cost-1';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-live-cost-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => {
      events.push({ topic, payload });
    },
    subscribe: (_t: string, _cb: (e: unknown) => void) => () => {},
    events,
  };
}

function makeCtx(
  bus: ReturnType<typeof makeBus>,
  overrides: Partial<PhaseContext> = {},
): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-live-cost-1',
    sprintVersion: '1.0.0',
    cycleId: CYCLE_ID,
    adapter: undefined as any,
    bus,
    runtime: {
      run: vi.fn().mockResolvedValue({
        output: 'done',
        costUsd: 0.05,
        status: 'completed',
      }),
    },
    ...overrides,
  } as PhaseContext;
}

function writeSprintFile(
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    status?: string;
    tags?: string[];
  }>,
  cycleId = CYCLE_ID,
): void {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-live-cost-1',
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      status: i.status ?? 'planned',
      tags: i.tags ?? [],
      description: `Description for ${i.title}`,
    })),
  };

  // Legacy path
  const sprintsDir = join(tmpRoot, '.agentforge', 'sprints');
  mkdirSync(sprintsDir, { recursive: true });
  writeFileSync(join(sprintsDir, 'v1.0.0.json'), JSON.stringify(data));

  // Cycle path (preferred by execute-phase when cycleId is set)
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

/** Minimal mock worktree pool. */
function makeTrackedPool(opts: {
  /** Called synchronously after release resolves; receives the snapshot state at that moment. */
  onRelease?: (snapshot: unknown) => void;
} = {}) {
  const execJsonPath = join(
    tmpRoot,
    '.agentforge',
    'cycles',
    CYCLE_ID,
    'phases',
    'execute.json',
  );

  const allocate = vi.fn().mockImplementation(async (req: {
    agentId: string;
    sessionId: string;
  }) => ({
    id: `wt-${req.agentId}`,
    // Non-existent path → meaningfulWorktreeChanges returns ['__worktree_unverified__']
    // so the item completes without actually running git.
    path: join(tmpRoot, 'fake-worktree'),
    branch: `autonomous/${req.agentId}`,
    allocatedAt: new Date().toISOString(),
    agentId: req.agentId,
    sessionId: req.sessionId,
    // NOTE: baselineHead intentionally omitted (undefined → non-strict mode)
  }));

  const release = vi.fn().mockImplementation(async (_id: string) => {
    // Read execute.json snapshot at the moment of worktree release.
    // This is called INSIDE the item's finally block — AFTER commitAgentWork
    // but BEFORE the end-of-finally snapshotExecuteProgress().
    // Without the fix the snapshot still shows costUsd: 0 (written at item
    // start).  With the fix it already shows the real costUsd.
    if (opts.onRelease) {
      try {
        const raw = readFileSync(execJsonPath, 'utf8');
        opts.onRelease(JSON.parse(raw));
      } catch {
        opts.onRelease(null);
      }
    }
  });

  return { allocate, release };
}

// ---------------------------------------------------------------------------
// Core test: live per-item cost is visible before worktree release
// ---------------------------------------------------------------------------

describe('execute-phase live item cost publish', () => {
  it('persists item-1 costUsd to execute.json before worktree release (mid-flight visibility)', async () => {
    // Use a coder-class assignee so the worktree pool is exercised.
    writeSprintFile([
      { id: 'item-1', title: 'Implement feature', assignee: 'coder' },
    ]);

    // Disable autocommit so commitAgentWork is a no-op and release() fires
    // immediately — that is the moment we capture the snapshot.
    const prevAutocommit = process.env['AGENT_AUTOCOMMIT_DISABLED'];
    process.env['AGENT_AUTOCOMMIT_DISABLED'] = '1';

    const execJsonPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      CYCLE_ID,
      'phases',
      'execute.json',
    );

    let snapshotAtRelease: unknown = undefined;
    const pool = makeTrackedPool({
      onRelease: (snap) => {
        if (snapshotAtRelease === undefined) snapshotAtRelease = snap;
      },
    });

    const bus = makeBus();
    const ctx = makeCtx(bus, {
      cycleId: CYCLE_ID,
      worktreePool: pool,
      runtime: {
        run: vi.fn().mockResolvedValue({
          output: 'item-1 done',
          costUsd: 0.05,
          status: 'completed',
        }),
      } as any,
    });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    // Restore env
    if (prevAutocommit === undefined) {
      delete process.env['AGENT_AUTOCOMMIT_DISABLED'];
    } else {
      process.env['AGENT_AUTOCOMMIT_DISABLED'] = prevAutocommit;
    }

    // The worktree pool must have been exercised (allocate + release).
    expect(pool.allocate).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);

    // The snapshot captured INSIDE release() must already show item-1 as
    // completed with the real nonzero costUsd.  Without the fix this would
    // be null or show costUsd: 0 because snapshotExecuteProgress() hadn't
    // been called yet at that point.
    expect(snapshotAtRelease).not.toBeNull();
    const snap = snapshotAtRelease as any;
    const item1Row = (snap?.itemResults as any[] | undefined)?.find(
      (r: any) => r.itemId === 'item-1',
    );
    expect(item1Row).toBeDefined();
    expect(item1Row?.status).toBe('completed');
    expect(item1Row?.costUsd).toBeGreaterThan(0);
    expect(item1Row?.costUsd).toBe(0.05);

    // The final execute.json on disk must also reflect the cost.
    expect(existsSync(execJsonPath)).toBe(true);
    const finalSnap = JSON.parse(readFileSync(execJsonPath, 'utf8'));
    const finalRow = (finalSnap.itemResults as any[]).find(
      (r: any) => r.itemId === 'item-1',
    );
    expect(finalRow?.costUsd).toBe(0.05);
    expect(finalRow?.status).toBe('completed');
  });

  it('persists nonzero costUsd for item-N while item-N+1 is still in flight', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'First item', assignee: 'agent-one' },
      { id: 'item-2', title: 'Second item', assignee: 'agent-two' },
    ]);

    const execJsonPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      CYCLE_ID,
      'phases',
      'execute.json',
    );

    // item-2's runtime.run will not resolve until we release the gate.
    let resolveItem2: (() => void) | undefined;
    const item2Gate = new Promise<void>((resolve) => {
      resolveItem2 = resolve;
    });

    // Snapshot captured while item-2 is still in flight (before gate releases).
    let snapshotWhileItem2Pending: unknown = undefined;

    const runMock = vi.fn().mockImplementation(
      async (agentId: string) => {
        if (agentId === 'agent-two') {
          // Block until signaled from outside.
          await item2Gate;
          return { output: 'item-2 done', costUsd: 0.03, status: 'completed' };
        }
        // item-1 completes immediately with a real cost.
        return { output: 'item-1 done', costUsd: 0.07, status: 'completed' };
      },
    );

    const bus = makeBus();
    const ctx = makeCtx(bus, {
      cycleId: CYCLE_ID,
      runtime: { run: runMock } as any,
    });

    // Start the phase with both items running in parallel.
    const phasePromise = runExecutePhase(ctx, {
      maxParallelism: 2,
      maxItemRetries: 0,
    });

    // Yield multiple event-loop turns to allow item-1 to complete and its
    // snapshotExecuteProgress() to flush execute.json to disk.  In tests
    // (no real worktrees) the finally block is synchronous, so a small
    // number of setImmediate ticks is enough.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    // Read snapshot while item-2 is still blocked.
    if (existsSync(execJsonPath)) {
      snapshotWhileItem2Pending = JSON.parse(readFileSync(execJsonPath, 'utf8'));
    }

    // Let item-2 complete so the phase can finish.
    resolveItem2!();
    await phasePromise;

    // Snapshot captured mid-phase must already show item-1's real cost.
    expect(snapshotWhileItem2Pending).not.toBeUndefined();
    const snap = snapshotWhileItem2Pending as any;
    const item1Row = (snap?.itemResults as any[] | undefined)?.find(
      (r: any) => r.itemId === 'item-1',
    );
    expect(item1Row).toBeDefined();
    expect(item1Row?.costUsd).toBeGreaterThan(0);
    expect(item1Row?.costUsd).toBe(0.07);

    // item-2 must appear as 'running' (not yet completed) in the same snapshot.
    const item2Row = (snap?.itemResults as any[] | undefined)?.find(
      (r: any) => r.itemId === 'item-2',
    );
    expect(item2Row?.status).toBe('running');
    expect(item2Row?.costUsd).toBe(0);
  });
});
