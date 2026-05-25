// packages/core/src/runtime/__tests__/worktree-gc.test.ts
//
// T4.6 — Tests for WorktreeGc (policy layer: which worktrees to remove).
//
// All tests use a fully-mocked WorktreePool so we never run real git commands.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { WorktreeGc } from '../worktree-gc.js';
import type { WorktreePool } from '../worktree-pool.js';
import type { WorktreeHandle } from '../worktree-pool-types.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeHandle(
  id: string,
  allocatedAt: Date | string,
  extra: Partial<WorktreeHandle> = {},
): WorktreeHandle {
  return {
    id,
    path: `/tmp/worktrees/${id}`,
    branch: `autonomous/${id}`,
    allocatedAt: typeof allocatedAt === 'string' ? allocatedAt : allocatedAt.toISOString(),
    agentId: id,
    sessionId: 'test-session',
    ...extra,
  };
}

function makePool(handles: WorktreeHandle[]): {
  pool: WorktreePool;
  releaseMock: Mock;
} {
  const releaseMock = vi.fn().mockResolvedValue(undefined);
  const pool = {
    listActive: vi.fn().mockResolvedValue(handles),
    release: releaseMock,
    allocate: vi.fn(),
    gc: vi.fn(),
    getStats: vi.fn(),
  } as unknown as WorktreePool;
  return { pool, releaseMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorktreeGc', () => {
  const PROJECT_ROOT = '/fake/project';

  // 1. keepLast=5 with 10 handles — 5 oldest removed
  it('keepLast=5 with 10 handles removes the 5 oldest', async () => {
    const now = Date.now();
    const handles = Array.from({ length: 10 }, (_, i) =>
      makeHandle(`wt-${i}`, new Date(now - (10 - i) * 60 * 60 * 1000)),
    );
    const { pool, releaseMock } = makePool(handles);

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 5,
      olderThanMs: 999 * 60 * 60 * 1000, // age filter won't fire
      maxDiskMb: 999999,
    });

    const result = await gc.run();

    // 5 oldest (wt-0 … wt-4) should be removed
    expect(result.removed).toHaveLength(5);
    const removedIds = result.removed.map((h) => h.id);
    for (let i = 0; i < 5; i++) {
      expect(removedIds).toContain(`wt-${i}`);
    }
    // 5 newest (wt-5 … wt-9) should be kept
    for (let i = 5; i < 10; i++) {
      expect(removedIds).not.toContain(`wt-${i}`);
    }
    expect(releaseMock).toHaveBeenCalledTimes(5);
  });

  // 2. olderThanMs=1h — only ancient handles removed
  it('olderThanMs=1h removes only handles older than 1 hour', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const handles = [
      makeHandle('ancient-1', new Date(now - 3 * HOUR)),
      makeHandle('ancient-2', new Date(now - 2 * HOUR)),
      makeHandle('recent-1',  new Date(now - 30 * 60 * 1000)),
      makeHandle('recent-2',  new Date(now - 10 * 60 * 1000)),
    ];
    const { pool, releaseMock } = makePool(handles);

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 100, // keepLast won't fire
      olderThanMs: HOUR,
      maxDiskMb: 999999,
    });

    const result = await gc.run();

    const removedIds = result.removed.map((h) => h.id);
    expect(removedIds).toContain('ancient-1');
    expect(removedIds).toContain('ancient-2');
    expect(removedIds).not.toContain('recent-1');
    expect(removedIds).not.toContain('recent-2');
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });

  // 3. maxDiskMb=10 with 20MB total — removes oldest until under 10MB
  it('maxDiskMb removes oldest worktrees when disk budget is exceeded', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    // 4 worktrees — all recent (age filter won't fire), keepLast won't fire.
    // Total fake disk usage will be reported as 20 MB (5 MB average per worktree).
    const handles = [
      makeHandle('old-1', new Date(now - 4 * HOUR)),
      makeHandle('old-2', new Date(now - 3 * HOUR)),
      makeHandle('mid-1', new Date(now - 2 * HOUR)),
      makeHandle('new-1', new Date(now - 1 * HOUR)),
    ];
    const { pool, releaseMock } = makePool(handles);

    // Spy on dirSizeBytes by injecting a controlled disk measurement.
    // We do this by subclassing WorktreeGc and overriding measureDiskMb.
    class TestGc extends WorktreeGc {
      protected override measureDiskMb(): number {
        return 20; // always report 20 MB
      }
    }

    const gc = new TestGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 100, // won't fire
      olderThanMs: 999 * HOUR, // age filter won't fire
      maxDiskMb: 10,
    });

    const result = await gc.run();

    // Should have removed enough to get under 10 MB.
    // With 4 handles, 5 MB each → need to remove at least 2.
    expect(result.removed.length).toBeGreaterThanOrEqual(2);
    // Oldest handles should be removed first.
    const removedIds = result.removed.map((h) => h.id);
    expect(removedIds).toContain('old-1');
  });

  // 4. Empty pool — nothing removed
  it('returns empty result when pool has no active handles', async () => {
    const { pool, releaseMock } = makePool([]);

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
    });

    const result = await gc.run();

    expect(result.removed).toHaveLength(0);
    expect(result.diskFreedMb).toBe(0);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('does not measure stale worktree directories when there are no registered handles', async () => {
    const { pool } = makePool([]);

    class NoMeasureGc extends WorktreeGc {
      protected override measureDiskMb(): number {
        throw new Error('measureDiskMb should not run without active handles');
      }
    }

    const gc = new NoMeasureGc({
      pool,
      projectRoot: PROJECT_ROOT,
    });

    await expect(gc.run()).resolves.toEqual({ removed: [], diskFreedMb: 0 });
  });

  // 5. pool.release throws for one handle — error propagates after others are processed
  it('re-throws first pool.release error after processing all other handles', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    const handles = [
      makeHandle('good-1', new Date(now - 3 * HOUR)),
      makeHandle('throws', new Date(now - 2 * HOUR)),
      makeHandle('good-2', new Date(now - 1.5 * HOUR)),
    ];

    const releaseError = new Error('branch has unmerged commits');
    const releaseMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'throws') throw releaseError;
    });
    const pool = {
      listActive: vi.fn().mockResolvedValue(handles),
      release: releaseMock,
    } as unknown as WorktreePool;

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 0, // remove all
      olderThanMs: 0,
      maxDiskMb: 999999,
    });

    await expect(gc.run()).rejects.toThrow('branch has unmerged commits');

    // good-1 and good-2 should still have been attempted.
    expect(releaseMock).toHaveBeenCalledWith('good-1');
    expect(releaseMock).toHaveBeenCalledWith('throws');
    expect(releaseMock).toHaveBeenCalledWith('good-2');
  });

  // 6. keepLast larger than pool size — nothing removed by count
  it('keepLast greater than pool size does not over-remove', async () => {
    const now = Date.now();
    const handles = Array.from({ length: 3 }, (_, i) =>
      makeHandle(`wt-${i}`, new Date(now - i * 60 * 1000)),
    );
    const { pool, releaseMock } = makePool(handles);

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 10, // larger than pool
      olderThanMs: 999 * 60 * 60 * 1000,
      maxDiskMb: 999999,
    });

    const result = await gc.run();
    expect(result.removed).toHaveLength(0);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // 7. Removed handles are returned in the result
  it('result.removed contains the handles that were released', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const handles = [
      makeHandle('old', new Date(now - 3 * HOUR)),
      makeHandle('recent', new Date(now - 10 * 60 * 1000)),
    ];
    const { pool } = makePool(handles);

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 100,
      olderThanMs: 2 * HOUR,
      maxDiskMb: 999999,
    });

    const result = await gc.run();
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]!.id).toBe('old');
  });

  // 8. diskFreedMb is non-negative and proportional to removed count
  it('diskFreedMb is non-negative', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const handles = [
      makeHandle('old-1', new Date(now - 3 * HOUR)),
      makeHandle('old-2', new Date(now - 2 * HOUR)),
      makeHandle('new-1', new Date(now - 10 * 60 * 1000)),
    ];
    const { pool } = makePool(handles);

    const gc = new WorktreeGc({
      pool,
      projectRoot: PROJECT_ROOT,
      keepLast: 100,
      olderThanMs: 1 * HOUR,
      maxDiskMb: 999999,
    });

    const result = await gc.run();
    expect(result.diskFreedMb).toBeGreaterThanOrEqual(0);
    expect(typeof result.diskFreedMb).toBe('number');
  });

  // 9. Default options (keepLast=20, olderThanMs=24h, maxDiskMb=5000)
  it('uses correct defaults: keepLast=20, olderThanMs=24h', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    // 25 handles, all under 24h old — none should be removed by age.
    // keepLast=20 should remove the 5 oldest.
    const handles = Array.from({ length: 25 }, (_, i) =>
      makeHandle(`h${i}`, new Date(now - (25 - i) * 60 * 1000)), // 1-25 minutes old
    );
    const { pool, releaseMock } = makePool(handles);

    const gc = new WorktreeGc({ pool, projectRoot: PROJECT_ROOT });
    const result = await gc.run();

    // With keepLast=20 default, 5 should be removed (all under 24h so age won't fire).
    expect(result.removed).toHaveLength(5);
    expect(releaseMock).toHaveBeenCalledTimes(5);
  });

  it('disk measurement skips dependency store directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-worktree-gc-size-'));
    const worktreesDir = join(root, '.agentforge/worktrees');
    const keepDir = join(worktreesDir, 'agent-coder-size', 'src');
    const nodeModulesDir = join(worktreesDir, 'agent-coder-size', 'node_modules', 'pkg');
    const pnpmDir = join(worktreesDir, 'agent-coder-size', '.pnpm', 'pkg');
    mkdirSync(keepDir, { recursive: true });
    mkdirSync(nodeModulesDir, { recursive: true });
    mkdirSync(pnpmDir, { recursive: true });
    writeFileSync(join(keepDir, 'keep.txt'), 'keep');
    writeFileSync(join(nodeModulesDir, 'ignored.txt'), 'ignored dependency payload');
    writeFileSync(join(pnpmDir, 'ignored.txt'), 'ignored pnpm payload');

    const { pool } = makePool([]);
    class ExposedGc extends WorktreeGc {
      public sizeOf(dir: string): number {
        return this.dirSizeBytes(dir);
      }
    }

    try {
      const gc = new ExposedGc({ pool, projectRoot: root });
      expect(gc.sizeOf(worktreesDir)).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
