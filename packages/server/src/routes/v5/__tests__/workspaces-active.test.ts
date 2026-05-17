/**
 * Tests for GET /api/v5/workspaces/active (T4.7)
 *
 * Coverage:
 *  1. Returns 200 with empty active + zero stats when pool has no worktrees
 *  2. Returns correct shape with active entries from pool
 *  3. Stats are passed through from pool.getStats()
 *  4. currentItem is null when no .agentforge/cycles directory exists
 *  5. currentItem is populated when execute.json has a matching agentId
 *  6. currentItem is null when execute.json exists but no agentId match
 *  7. ageSeconds is computed from allocatedAt
 *  8. listActive() error is handled gracefully (returns empty list, not 500)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  workspacesActiveRoutes,
  _setPool,
  _setProjectRoot,
  resolveCurrentItem,
  buildEntry,
} from '../workspaces-active.js';
import type { WorktreeHandle } from '@agentforge/core';

// ---------------------------------------------------------------------------
// Pool mock factory
// ---------------------------------------------------------------------------

interface MockPool {
  listActive: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
}

function makeMockPool(handles: WorktreeHandle[] = [], stats = {
  active: 0,
  totalAllocations: 0,
  totalReleases: 0,
  totalGcd: 0,
}): MockPool {
  return {
    listActive: vi.fn().mockResolvedValue(handles),
    getStats: vi.fn().mockReturnValue(stats),
  };
}

function makeHandle(overrides: Partial<WorktreeHandle> = {}): WorktreeHandle {
  return {
    id: 'agent-coder-sess1',
    path: '/tmp/af-worktrees/agent-coder-sess1',
    branch: 'autonomous/agent-coder-sess1',
    allocatedAt: new Date().toISOString(),
    agentId: 'coder',
    sessionId: 'sess1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fastify app factory
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'af-wt-route-test-'));
  _setProjectRoot(tmpRoot);
  _setPool(null); // reset singleton
});

afterEach(async () => {
  if (app) await app.close();
  _setPool(null);
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function buildApp(pool: MockPool): Promise<FastifyInstance> {
  _setPool(pool as never);
  const a = Fastify({ logger: false });
  await workspacesActiveRoutes(a, { projectRoot: tmpRoot });
  await a.ready();
  return a;
}

// ---------------------------------------------------------------------------
// 1. Empty pool
// ---------------------------------------------------------------------------

describe('GET /api/v5/workspaces/active — empty pool', () => {
  it('returns 200 with empty active array and zero stats', async () => {
    const pool = makeMockPool();
    app = await buildApp(pool);

    const res = await app.inject({ method: 'GET', url: '/api/v5/workspaces/active' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ active: unknown[]; stats: { active: number } }>();
    expect(Array.isArray(body.active)).toBe(true);
    expect(body.active).toHaveLength(0);
    expect(body.stats.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Response shape with one active entry
// ---------------------------------------------------------------------------

describe('GET /api/v5/workspaces/active — one active worktree', () => {
  it('returns entry with required fields', async () => {
    const handle = makeHandle();
    const pool = makeMockPool([handle], { active: 1, totalAllocations: 5, totalReleases: 4, totalGcd: 0 });
    app = await buildApp(pool);

    const res = await app.inject({ method: 'GET', url: '/api/v5/workspaces/active' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      active: Array<{
        id: string;
        agentId: string;
        branch: string;
        path: string;
        allocatedAt: string;
        ageSeconds: number;
        currentItem: null;
      }>;
      stats: { active: number; totalAllocations: number; totalReleases: number; totalGcd: number };
    }>();

    expect(body.active).toHaveLength(1);
    const entry = body.active[0]!;
    expect(entry.id).toBe(handle.id);
    expect(entry.agentId).toBe('coder');
    expect(entry.branch).toBe(handle.branch);
    expect(entry.path).toBe(handle.path);
    expect(entry.allocatedAt).toBe(handle.allocatedAt);
    expect(typeof entry.ageSeconds).toBe('number');
    expect(entry.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(entry.currentItem).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Stats passthrough
// ---------------------------------------------------------------------------

describe('GET /api/v5/workspaces/active — stats passthrough', () => {
  it('passes pool stats into the response correctly', async () => {
    const statsIn = { active: 3, totalAllocations: 42, totalReleases: 39, totalGcd: 5 };
    const pool = makeMockPool([], statsIn);
    app = await buildApp(pool);

    const res = await app.inject({ method: 'GET', url: '/api/v5/workspaces/active' });
    expect(res.statusCode).toBe(200);

    const { stats } = res.json<{ active: unknown[]; stats: typeof statsIn }>();
    expect(stats.active).toBe(3);
    expect(stats.totalAllocations).toBe(42);
    expect(stats.totalReleases).toBe(39);
    expect(stats.totalGcd).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4. currentItem null when no cycles dir
// ---------------------------------------------------------------------------

describe('resolveCurrentItem — no cycles dir', () => {
  it('returns null when .agentforge/cycles dir is absent', () => {
    const result = resolveCurrentItem(tmpRoot, 'coder', 'sess1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. currentItem populated from execute.json
// ---------------------------------------------------------------------------

describe('resolveCurrentItem — matching item in execute.json', () => {
  it('returns the matching item when agentId matches', () => {
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-001', 'phases');
    mkdirSync(cycleDir, { recursive: true });
    const executePayload = {
      items: [
        { id: 'T4.1', title: 'Build WorktreePool', agentId: 'coder', sessionId: 'sess1' },
        { id: 'T4.2', title: 'Dispatcher integration', agentId: 'architect', sessionId: 'sess2' },
      ],
    };
    writeFileSync(join(cycleDir, 'execute.json'), JSON.stringify(executePayload));

    const result = resolveCurrentItem(tmpRoot, 'coder', 'sess1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('T4.1');
    expect(result!.title).toBe('Build WorktreePool');
  });
});

// ---------------------------------------------------------------------------
// 6. currentItem null when no match
// ---------------------------------------------------------------------------

describe('resolveCurrentItem — no matching item', () => {
  it('returns null when execute.json exists but no item matches', () => {
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-001', 'phases');
    mkdirSync(cycleDir, { recursive: true });
    const executePayload = {
      items: [
        { id: 'T4.2', title: 'Something else', agentId: 'architect', sessionId: 'sess9' },
      ],
    };
    writeFileSync(join(cycleDir, 'execute.json'), JSON.stringify(executePayload));

    const result = resolveCurrentItem(tmpRoot, 'coder', 'sess1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. ageSeconds computation
// ---------------------------------------------------------------------------

describe('buildEntry — ageSeconds', () => {
  it('computes ageSeconds from allocatedAt timestamp', () => {
    const past = new Date(Date.now() - 90_000).toISOString(); // 90 s ago
    const handle = makeHandle({ allocatedAt: past });
    const entry = buildEntry(handle, tmpRoot);

    // Allow ±2 s for test execution time
    expect(entry.ageSeconds).toBeGreaterThanOrEqual(88);
    expect(entry.ageSeconds).toBeLessThanOrEqual(92);
  });

  it('returns 0 for ageSeconds when allocatedAt is an invalid date', () => {
    const handle = makeHandle({ allocatedAt: 'not-a-date' });
    const entry = buildEntry(handle, tmpRoot);
    expect(entry.ageSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. listActive error handled gracefully
// ---------------------------------------------------------------------------

describe('GET /api/v5/workspaces/active — listActive failure', () => {
  it('returns 200 with empty active list when pool.listActive() throws', async () => {
    const pool = {
      listActive: vi.fn().mockRejectedValue(new Error('git not found')),
      getStats: vi.fn().mockReturnValue({ active: 0, totalAllocations: 0, totalReleases: 0, totalGcd: 0 }),
    };
    app = await buildApp(pool as unknown as MockPool);

    const res = await app.inject({ method: 'GET', url: '/api/v5/workspaces/active' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ active: unknown[]; stats: { active: number } }>();
    expect(body.active).toHaveLength(0);
  });
});
