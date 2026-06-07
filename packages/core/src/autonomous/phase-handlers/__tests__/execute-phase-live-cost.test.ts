import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext, WorktreePoolLike } from '../../phase-scheduler.js';

vi.mock('../semantic-memory.js', () => ({
  rankMemoriesBySemantic: async (_itemText: string, entries: unknown[]) => entries,
}));

vi.mock('../../decompose/index.js', () => ({
  groupItemsByWave: (items: unknown[]) => [items],
}));

let tmpRoot: string;
let previousAutocommitDisabled: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-execute-live-cost-'));
  previousAutocommitDisabled = process.env['AGENT_AUTOCOMMIT_DISABLED'];
  process.env['AGENT_AUTOCOMMIT_DISABLED'] = '1';
  vi.clearAllMocks();
});

afterEach(() => {
  if (previousAutocommitDisabled === undefined) {
    delete process.env['AGENT_AUTOCOMMIT_DISABLED'];
  } else {
    process.env['AGENT_AUTOCOMMIT_DISABLED'] = previousAutocommitDisabled;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => {
      events.push({ topic, payload });
    },
    subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
    events,
  };
}

function writePlanFile() {
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-live-cost-1');
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'plan.json'),
    JSON.stringify({
      version: '1.0.0',
      sprintId: 'sprint-live-cost-1',
      items: [
        {
          id: 'child-1',
          title: 'Complete first',
          assignee: 'coder-one',
          status: 'planned',
          description: 'First child finishes before the second child.',
        },
        {
          id: 'child-2',
          title: 'Complete second',
          assignee: 'coder-two',
          status: 'planned',
          description: 'Second child remains in flight during the assertion.',
        },
      ],
    }),
  );
}

function makeCtx(
  bus: ReturnType<typeof makeBus>,
  runtime: PhaseContext['runtime'],
  worktreePool: WorktreePoolLike,
): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-live-cost-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-live-cost-1',
    adapter: undefined as never,
    bus,
    runtime,
    worktreePool,
  } as PhaseContext;
}

describe('execute phase live item cost snapshots', () => {
  it('persists a completed child cost while later children are still running', async () => {
    writePlanFile();

    const bus = makeBus();
    const firstReleaseCalled = deferred<void>();
    const firstReleaseMayContinue = deferred<void>();
    const secondStarted = deferred<void>();
    const secondRunMayFinish = deferred<void>();

    const worktreePool: WorktreePoolLike = {
      allocate: vi.fn(async (opts) => ({
        id: opts.sessionId,
        path: tmpRoot,
        branch: `branch-${opts.sessionId}`,
        allocatedAt: new Date().toISOString(),
        agentId: opts.agentId,
        sessionId: opts.sessionId,
      })),
      release: vi.fn(async (id: string) => {
        if (id.includes('child-1')) {
          firstReleaseCalled.resolve();
          await firstReleaseMayContinue.promise;
        }
      }),
    };

    const runtime = {
      run: vi.fn(async (agentId: string) => {
        if (agentId === 'coder-one') {
          return {
            output: 'first child done',
            costUsd: 0.42,
            status: 'completed',
          };
        }

        secondStarted.resolve();
        await secondRunMayFinish.promise;
        return {
          output: 'second child done',
          costUsd: 0.15,
          status: 'completed',
        };
      }),
    };

    const { runExecutePhase } = await import('../execute-phase.js');
    const phasePromise = runExecutePhase(makeCtx(bus, runtime, worktreePool), {
      maxParallelism: 2,
      maxItemRetries: 0,
      selfEvalDisabled: true,
    });

    await secondStarted.promise;
    await firstReleaseCalled.promise;

    const snapshotPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      'cycle-live-cost-1',
      'phases',
      'execute.json',
    );
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      status: string;
      itemResults: Array<{ itemId: string; status: string; costUsd: number }>;
    };
    const byId = new Map(snapshot.itemResults.map((row) => [row.itemId, row]));

    expect(snapshot.status).toBe('in_progress');
    expect(byId.get('child-1')).toMatchObject({
      status: 'completed',
      costUsd: 0.42,
    });
    expect(byId.has('child-2')).toBe(false);
    expect(runtime.run).toHaveBeenCalledTimes(2);

    secondRunMayFinish.resolve();
    firstReleaseMayContinue.resolve();
    await phasePromise;
  });
});
