/**
 * Unit tests for T4.2 — WorktreePool integration in the execute phase.
 *
 * Tests verify that:
 *  1. A pool is allocated/released once per coder-class item (3-item plan → 3 alloc + 3 release)
 *  2. The runtime.run call receives `cwd` set to the worktree path
 *  3. Non-coder-class items (scorer, auditor) do NOT allocate a worktree unless isolation is required
 *  4. When no pool is provided, zero allocations happen (legacy path)
 *  5. When disableWorktrees: true, zero allocations even with a pool
 *  6. Agent failure → worktree still released (try/finally semantics)
 *  7. Bus events: execute.worktree.allocated + execute.worktree.released fire
 *  8. execute.worktree.alloc-failed fires on allocation error (fallback to main tree)
 *  9. Mixed coder + non-coder items — only coder items use worktrees
 * 10. Worktree path is surfaced in the completed item result
 * 11. Allocation failure is non-fatal — agent still runs (on main tree)
 * 12. Multiple retries reuse the SAME worktree handle (allocated once per item)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { PhaseContext } from '../../phase-scheduler.js';
import type { WorktreePoolLike } from '../../phase-scheduler.js';
import { runExecutePhase, isCoderClassItem, CODER_CLASS_PATTERNS } from '../execute-phase.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-wt-'));
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
    sprintId: 'sprint-wt-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-wt-1',
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

/** Returns a mock WorktreePool with configurable behaviour. */
function makePool(opts: {
  allocateFn?: (req: { agentId: string; sessionId: string }) => Promise<{ id: string; path: string; branch: string; allocatedAt: string; agentId: string; sessionId: string }>;
  releaseFn?: (id: string) => Promise<void>;
} = {}): WorktreePoolLike & { allocateCalls: Array<{ agentId: string; sessionId: string }>; releaseCalls: string[] } {
  const allocateCalls: Array<{ agentId: string; sessionId: string }> = [];
  const releaseCalls: string[] = [];

  const allocateFn = opts.allocateFn ?? (async (req) => {
    allocateCalls.push(req);
    return {
      id: `wt-${req.agentId}-${allocateCalls.length}`,
      path: join(tmpRoot, `.agentforge/worktrees/${req.agentId}`),
      branch: `autonomous/${req.agentId}`,
      allocatedAt: new Date().toISOString(),
      agentId: req.agentId,
      sessionId: req.sessionId,
    };
  });

  const releaseFn = opts.releaseFn ?? (async (id: string) => {
    releaseCalls.push(id);
  });

  return {
    allocateCalls,
    releaseCalls,
    allocate: async (req) => {
      const h = await allocateFn(req);
      allocateCalls.push(req);
      return h;
    },
    release: async (id) => {
      await releaseFn(id);
      releaseCalls.push(id);
    },
  };
}

/** Simpler pool that just tracks calls via vi.fn(). */
function makeSpyPool(worktreePath = '/fake/worktree') {
  const allocate = vi.fn().mockImplementation(async (req: { agentId: string; sessionId: string }) => ({
    id: `wt-${req.agentId}`,
    path: worktreePath,
    branch: `autonomous/${req.agentId}`,
    allocatedAt: new Date().toISOString(),
    agentId: req.agentId,
    sessionId: req.sessionId,
  }));
  const release = vi.fn().mockResolvedValue(undefined);
  return { allocate, release };
}

function writeSprintFile(
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    status?: string;
    tags?: string[];
  }>,
  cycleId = 'cycle-wt-1',
) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-wt-1',
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

  // Cycle path
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

async function initGitRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await execFile('git', ['init', '-b', 'main'], { cwd: dir });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await execFile('git', ['add', 'README.md'], { cwd: dir });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: dir });
}

// ---------------------------------------------------------------------------
// isCoderClassItem unit tests
// ---------------------------------------------------------------------------

describe('isCoderClassItem', () => {
  it('returns true for assignee containing "coder"', () => {
    expect(isCoderClassItem({ assignee: 'coder', tags: [] })).toBe(true);
  });

  it('returns true for assignee "react-component-engineer"', () => {
    expect(isCoderClassItem({ assignee: 'react-component-engineer', tags: [] })).toBe(true);
  });

  it('returns true for assignee "svelte-runes-engineer"', () => {
    expect(isCoderClassItem({ assignee: 'svelte-runes-engineer', tags: [] })).toBe(true);
  });

  it('returns true for assignee "fastify-route-engineer"', () => {
    expect(isCoderClassItem({ assignee: 'fastify-route-engineer', tags: [] })).toBe(true);
  });

  it('returns true for architecture agents that can modify code', () => {
    expect(isCoderClassItem({ assignee: 'forge-engine-architect', tags: [] })).toBe(true);
  });

  it('returns true when tags contain "coder"', () => {
    expect(isCoderClassItem({ assignee: 'unknown-agent', tags: ['coder', 'typescript'] })).toBe(true);
  });

  it('returns true when tags contain "frontend"', () => {
    expect(isCoderClassItem({ assignee: 'generic', tags: ['frontend', 'svelte'] })).toBe(true);
  });

  it('returns false for auditor-class agent', () => {
    expect(isCoderClassItem({ assignee: 'auditor', tags: ['audit', 'analysis'] })).toBe(false);
  });

  it('returns false for scorer agent', () => {
    expect(isCoderClassItem({ assignee: 'scorer', tags: ['scoring', 'qa'] })).toBe(false);
  });

  it('returns false for ceo/gate agent', () => {
    expect(isCoderClassItem({ assignee: 'ceo', tags: ['gate', 'verdict'] })).toBe(false);
  });

  it('CODER_CLASS_PATTERNS exports are non-empty', () => {
    expect(CODER_CLASS_PATTERNS.length).toBeGreaterThan(0);
    expect(CODER_CLASS_PATTERNS).toContain('coder');
    expect(CODER_CLASS_PATTERNS).toContain('engineer');
    expect(CODER_CLASS_PATTERNS).toContain('architect');
  });
});

// ---------------------------------------------------------------------------
// Worktree pool integration — 3 coder-class items → 3 alloc + 3 release
// ---------------------------------------------------------------------------

describe('execute-phase worktree integration', () => {
  it('allocates and releases a worktree for each coder-class item in a 3-item plan', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Add feature A', assignee: 'coder', tags: ['coder'] },
      { id: 'item-2', title: 'Add feature B', assignee: 'frontend-dev', tags: ['frontend'] },
      { id: 'item-3', title: 'Add feature C', assignee: 'react-engineer', tags: ['react'] },
    ]);

    const pool = makeSpyPool();
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    // Each of the 3 coder-class items should have triggered one allocate + one release
    expect(pool.allocate).toHaveBeenCalledTimes(3);
    expect(pool.release).toHaveBeenCalledTimes(3);
  });

  it('passes cwd = worktree path to runtime.run for coder-class items', async () => {
    const worktreePath = join(tmpRoot, 'wt-isolated');
    writeSprintFile([
      { id: 'item-1', title: 'Implement X', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(runtime.run).toHaveBeenCalledTimes(1);
    const callArgs = runtime.run.mock.calls[0];
    // Third argument is the options object — must contain cwd: worktreePath
    expect(callArgs![1]).toContain(`repository at ${worktreePath}`);
    expect(callArgs![2]).toMatchObject({ cwd: worktreePath });
  });

  it('does NOT allocate a worktree for non-coder-class items (scorer, auditor)', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Score sprint', assignee: 'scorer', tags: ['scoring'] },
      { id: 'item-2', title: 'Audit code', assignee: 'auditor', tags: ['audit'] },
    ]);

    const pool = makeSpyPool();
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    // Neither scorer nor auditor is coder-class → zero allocations
    expect(pool.allocate).not.toHaveBeenCalled();
    expect(pool.release).not.toHaveBeenCalled();
  });

  it('does NOT call pool when no worktreePool is provided (legacy path)', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Add feature', assignee: 'coder', tags: ['coder'] },
      { id: 'item-2', title: 'Fix bug', assignee: 'backend-dev', tags: ['backend'] },
      { id: 'item-3', title: 'Write tests', assignee: 'vitest-author', tags: ['vitest'] },
    ]);

    const pool = makeSpyPool();
    const bus = makeBus();
    // No worktreePool in context
    const ctx = makeCtx(bus);

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(pool.allocate).not.toHaveBeenCalled();
    expect(pool.release).not.toHaveBeenCalled();
  });

  it('does NOT allocate when disableWorktrees: true even if pool is provided', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Add feature', assignee: 'coder', tags: ['coder'] },
      { id: 'item-2', title: 'Fix bug', assignee: 'react-engineer', tags: ['react'] },
    ]);

    const pool = makeSpyPool();
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(pool.allocate).not.toHaveBeenCalled();
    expect(pool.release).not.toHaveBeenCalled();
  });

  it('releases the worktree even when the agent throws (try/finally semantics)', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Failing task', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool();
    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockRejectedValue(new Error('agent catastrophic failure')),
    };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    // maxItemRetries: 0 so the item fails on the first attempt
    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    // The phase should not throw — it tolerates individual item failures.
    // With 1 item and it failing, failure rate = 1.0 (all items failed) → 'blocked'.
    expect(result.status).toBe('blocked');
    // Regardless of outcome, release must have been called
    expect(pool.release).toHaveBeenCalledTimes(1);
    expect(pool.allocate).toHaveBeenCalledTimes(1);
  });

  it('emits execute.worktree.allocated bus event for each coder-class item', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
      { id: 'item-2', title: 'Task B', assignee: 'svelte-engineer', tags: ['svelte'] },
    ]);

    const pool = makeSpyPool('/fake/worktree');
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    const allocEvents = bus.events.filter((e) => e.topic === 'execute.worktree.allocated');
    expect(allocEvents).toHaveLength(2);
    const payload = allocEvents[0]!.payload as any;
    expect(payload.itemId).toBe('item-1');
    expect(payload.worktreePath).toBe('/fake/worktree');
    expect(typeof payload.worktreeId).toBe('string');
  });

  it('emits execute.worktree.released bus event for each allocated worktree', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool('/fake/worktree');
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    const releaseEvents = bus.events.filter((e) => e.topic === 'execute.worktree.released');
    expect(releaseEvents).toHaveLength(1);
    const payload = releaseEvents[0]!.payload as any;
    expect(payload.itemId).toBe('item-1');
    expect(typeof payload.worktreeId).toBe('string');
  });

  it('emits execute.worktree.alloc-failed and falls back to main tree on allocation error', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    // Pool that always throws on allocate
    const failingPool: WorktreePoolLike = {
      allocate: vi.fn().mockRejectedValue(new Error('git worktree add failed: disk full')),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: failingPool, runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    // alloc-failed event should fire
    const failedEvents = bus.events.filter((e) => e.topic === 'execute.worktree.alloc-failed');
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0]!.payload as any).error).toContain('disk full');

    // Agent should still have run (fallback to main tree — no cwd set)
    expect(runtime.run).toHaveBeenCalledTimes(1);
    const callArgs = runtime.run.mock.calls[0]!;
    // cwd must NOT be set when allocation failed
    expect((callArgs[2] as any).cwd).toBeUndefined();

    // release should NOT have been called (no handle to release)
    expect((failingPool.release as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('marks the item failed instead of running on the main tree when requireWorktrees is true', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const failingPool = {
      allocate: vi.fn().mockRejectedValue(new Error('disk full')),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: failingPool, runtime });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      requireWorktrees: true,
    });

    expect(result.status).toBe('blocked');
    expect(runtime.run).not.toHaveBeenCalled();
    expect((failingPool.release as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const itemResult = (result.itemResults as any[])?.[0];
    expect(itemResult.status).toBe('failed');
    expect(itemResult.error).toContain('Worktree allocation failed');
  });

  it('allocates a worktree for every execute item when requireWorktrees is true', async () => {
    const worktreePath = join(tmpRoot, 'required-wt');
    writeSprintFile([
      { id: 'item-1', title: 'Prepare rollout notes', assignee: 'product-strategist', tags: ['planning'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      requireWorktrees: true,
    });

    expect(pool.allocate).toHaveBeenCalledTimes(1);
    expect(runtime.run).toHaveBeenCalledTimes(1);
    const callArgs = runtime.run.mock.calls[0]!;
    expect((callArgs[2] as any).cwd).toBe(worktreePath);
  });

  it('blocks required-worktree execution before invoking the runtime when no pool is provided', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Prepare rollout notes', assignee: 'product-strategist', tags: ['planning'] },
    ]);

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { runtime });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      requireWorktrees: true,
    });

    expect(result.status).toBe('blocked');
    expect(runtime.run).not.toHaveBeenCalled();
    const itemResult = (result.itemResults as any[])?.[0];
    expect(itemResult.error).toContain('worktree pool unavailable');
  });

  it('persists a terminal checkpoint when required worktree allocation fails', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const failingPool = {
      allocate: vi.fn().mockRejectedValue(new Error('disk full')),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: failingPool, runtime });

    await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      requireWorktrees: true,
    });

    const checkpoint = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', 'cycle-wt-1', 'checkpoint.json'), 'utf8'),
    ) as { completedItemIds?: string[]; schemaVersion?: number };
    expect(checkpoint.schemaVersion).toBe(2);
    expect(checkpoint.completedItemIds).toContain('item-1');
  });

  it('reuses the original worktree session on gate retry', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool('/fake/worktree');
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool, retryAttempt: 1 });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(pool.allocate).toHaveBeenCalledWith({
      agentId: 'coder',
      sessionId: 'cycle-wt-1-item-1',
    });
  });

  it('uses item-specific worktree sessions for parallel same-agent items', async () => {
    writeSprintFile([
      { id: 'item-a', title: 'Task A', assignee: 'coder', tags: ['coder'] },
      { id: 'item-b', title: 'Task B', assignee: 'coder', tags: ['coder'] },
    ]);

    const allocate = vi.fn().mockImplementation(async (req: { agentId: string; sessionId: string }) => ({
      id: `wt-${req.sessionId}`,
      path: `/fake/${req.sessionId}`,
      branch: `autonomous/${req.sessionId}`,
      allocatedAt: new Date().toISOString(),
      agentId: req.agentId,
      sessionId: req.sessionId,
    }));
    const pool = {
      allocate,
      release: vi.fn().mockResolvedValue(undefined),
    };
    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 2,
      maxItemRetries: 0,
      requireWorktrees: true,
    });

    expect(result.status).toBe('completed');
    expect(allocate).toHaveBeenCalledTimes(2);
    expect(allocate).toHaveBeenCalledWith({
      agentId: 'coder',
      sessionId: 'cycle-wt-1-item-a',
    });
    expect(allocate).toHaveBeenCalledWith({
      agentId: 'coder',
      sessionId: 'cycle-wt-1-item-b',
    });
  });

  it('places gate rejection context before the original sprint item prompt', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Fix memory prompt rendering', assignee: 'coder', tags: ['coder'] },
    ]);

    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, {
      runtime,
      retryAttempt: 1,
      gateRetry: {
        attempt: 1,
        rationale:
          'MAJOR: packages/core/src/autonomous/phase-handlers/execute-phase.ts can pass undefined to truncateMemoryValue.',
        rejectedBranch: 'codex/agent-executor-runtime-engineer-06e26f07b342',
        prNumber: 153,
        files: ['packages/core/src/autonomous/phase-handlers/execute-phase.ts'],
        findings: [
          'MAJOR: rawValue from JSON.stringify can be undefined before truncateMemoryValue reads value.length.',
        ],
      },
    });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(runtime.run).toHaveBeenCalledTimes(1);
    const prompt = runtime.run.mock.calls[0]![1] as string;
    expect(prompt.startsWith('## Gate Rejection Retry')).toBe(true);
    expect(prompt.indexOf('This is a gate-rejection retry')).toBeLessThan(
      prompt.indexOf('You are working on sprint item'),
    );
    expect(prompt).toContain('Rejected PR: #153');
    expect(prompt).toContain('Rejected branch: codex/agent-executor-runtime-engineer-06e26f07b342');
    expect(prompt).toContain('packages/core/src/autonomous/phase-handlers/execute-phase.ts');
    expect(prompt).toContain('Do not broaden the scope');
  });

  it('falls back to a retry-specific worktree session when the original branch cannot be reused', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const allocate = vi.fn().mockImplementation(async (req: { agentId: string; sessionId: string }) => {
      if (req.sessionId === 'cycle-wt-1-item-1') {
        throw new Error('fatal: --[no-]track can only be used if a new branch is created');
      }
      return {
        id: `wt-${req.sessionId}`,
        path: `/fake/${req.sessionId}`,
        branch: `autonomous/${req.sessionId}`,
        allocatedAt: new Date().toISOString(),
        agentId: req.agentId,
        sessionId: req.sessionId,
      };
    });
    const pool = {
      allocate,
      release: vi.fn().mockResolvedValue(undefined),
    };
    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime, retryAttempt: 1 });

    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(result.status).toBe('completed');
    expect(allocate).toHaveBeenCalledTimes(2);
    expect(allocate).toHaveBeenNthCalledWith(2, {
      agentId: 'coder',
      sessionId: 'cycle-wt-1-item-1-retry-1',
    });
    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect((runtime.run.mock.calls[0]![2] as any).cwd).toBe('/fake/cycle-wt-1-item-1-retry-1');
    expect(bus.events.filter((e) => e.topic === 'execute.worktree.alloc-failed')).toHaveLength(0);
  });

  it('surfaces worktreePath in the completed item result', async () => {
    const worktreePath = join(tmpRoot, 'wt-surface-test');
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    const itemResult = (result.itemResults as any[])?.[0];
    expect(itemResult).toBeDefined();
    expect(itemResult.worktreePath).toBe(worktreePath);
    expect(typeof itemResult.worktreeBranch).toBe('string');
  });

  it('filters package manager caches out of recorded worktree changed files', async () => {
    const worktreePath = join(tmpRoot, 'wt-cache-filter');
    await initGitRepo(worktreePath);
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, _task: string, options: { cwd?: string }) => {
        if (!options.cwd) throw new Error('missing worktree cwd');
        writeFileSync(join(options.cwd, 'feature.ts'), 'export const feature = true;\n');
        mkdirSync(join(options.cwd, '.pnpm-store', 'v3', 'files', '00'), { recursive: true });
        writeFileSync(join(options.cwd, '.pnpm-store', 'v3', 'files', '00', 'cache-file'), 'cache\n');
        mkdirSync(join(options.cwd, 'node_modules', 'pkg'), { recursive: true });
        writeFileSync(join(options.cwd, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
        return { output: 'Implemented feature.ts', costUsd: 0.01 };
      }),
    };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(result.status).toBe('completed');
    const itemResult = (result.itemResults as any[])?.[0];
    expect(itemResult.worktreeChangedFiles).toEqual(['feature.ts']);
  });

  it('publishes agent.branch.pushed through the phase bus after worktree commit', async () => {
    const worktreePath = join(tmpRoot, 'wt-branch-event');
    await initGitRepo(worktreePath);
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, _task: string, options: { cwd?: string }) => {
        if (!options.cwd) throw new Error('missing worktree cwd');
        writeFileSync(join(options.cwd, 'feature.ts'), 'export const feature = true;\n');
        return {
          output: 'Implemented feature.ts',
          costUsd: 0.01,
        };
      }),
    };
    const ctx = makeCtx(bus, {
      worktreePool: pool,
      runtime,
      baseBranch: 'codex/codex-version',
    });

    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(result.status).toBe('completed');
    const branchEvents = bus.events.filter((e) => e.topic === 'agent.branch.pushed');
    expect(branchEvents).toHaveLength(1);
    const payload = branchEvents[0]!.payload as any;
    expect(payload.cycleId).toBe('cycle-wt-1');
    expect(payload.agentId).toBe('coder');
    expect(payload.branch).toBe('autonomous/coder');
    expect(payload.baseBranch).toBe('codex/codex-version');
    expect(payload.filesChanged).toBeGreaterThan(0);
    expect(payload.localOnly).toBe(true);
  });

  it('marks a coder item failed when the worktree has no source changes', async () => {
    const worktreePath = join(tmpRoot, 'wt-no-change');
    await initGitRepo(worktreePath);
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: 'Delegate to `embeddings-engineer`.',
        costUsd: 0.01,
      }),
    };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(result.status).toBe('blocked');
    const itemResult = (result.itemResults as any[])?.[0];
    expect(itemResult.status).toBe('failed');
    expect(itemResult.error).toContain('produced no source changes');
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it('accepts a clean retry worktree when its branch already has source changes against base', async () => {
    const worktreePath = join(tmpRoot, 'wt-existing-branch-diff');
    await initGitRepo(worktreePath);
    await execFile('git', ['checkout', '-b', 'autonomous/coder'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'feature.ts'), 'export const feature = true;\n');
    await execFile('git', ['add', 'feature.ts'], { cwd: worktreePath });
    await execFile('git', ['commit', '-m', 'agent attempt 1'], { cwd: worktreePath });

    writeSprintFile([
      { id: 'item-1', title: 'Fix rejected branch', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool(worktreePath);
    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: 'confirmed branch fix',
        costUsd: 0.01,
      }),
    };
    const ctx = makeCtx(bus, {
      worktreePool: pool,
      runtime,
      retryAttempt: 1,
      baseBranch: 'main',
    });

    const result = await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(result.status).toBe('completed');
    const itemResult = (result.itemResults as any[])?.[0];
    expect(itemResult.status).toBe('completed');
    expect(itemResult.worktreeChangedFiles).toEqual(['feature.ts']);
  });

  it('allocates ONCE per item (not per retry) on multiple retries', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Flaky task', assignee: 'coder', tags: ['coder'] },
    ]);

    const pool = makeSpyPool('/fake/worktree');
    const bus = makeBus();

    let callCount = 0;
    const runtime = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) throw new Error('transient failure');
        return { output: 'ok', costUsd: 0.01 };
      }),
    };

    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    // maxItemRetries: 2 → up to 3 attempts for item-1
    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 2 });

    // runtime.run called 3 times (2 failures + 1 success)
    expect(runtime.run).toHaveBeenCalledTimes(3);
    // But pool.allocate should only have been called ONCE (allocated before retry loop)
    expect(pool.allocate).toHaveBeenCalledTimes(1);
    // And released exactly once
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it('allocates only for coder items in a mixed coder + non-coder plan', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Code feature', assignee: 'coder', tags: ['coder'] },
      { id: 'item-2', title: 'Score items', assignee: 'scorer', tags: ['scoring'] },
      { id: 'item-3', title: 'Frontend work', assignee: 'frontend-dev', tags: ['frontend'] },
      { id: 'item-4', title: 'Audit run', assignee: 'auditor', tags: ['audit'] },
    ]);

    const pool = makeSpyPool();
    const bus = makeBus();
    const ctx = makeCtx(bus, { worktreePool: pool });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    // item-1 (coder) + item-3 (frontend-dev) are coder-class; item-2 and item-4 are not
    expect(pool.allocate).toHaveBeenCalledTimes(2);
    expect(pool.release).toHaveBeenCalledTimes(2);
  });

  it('does not set cwd when item is non-coder-class even with pool in context', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Run scoring', assignee: 'scorer', tags: ['scoring'] },
    ]);

    const pool = makeSpyPool('/fake/worktree');
    const bus = makeBus();
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01 }) };
    const ctx = makeCtx(bus, { worktreePool: pool, runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0 });

    expect(runtime.run).toHaveBeenCalledTimes(1);
    const callArgs = runtime.run.mock.calls[0]!;
    // No cwd override for non-coder items
    expect((callArgs[2] as any).cwd).toBeUndefined();
    expect(pool.allocate).not.toHaveBeenCalled();
  });
});
