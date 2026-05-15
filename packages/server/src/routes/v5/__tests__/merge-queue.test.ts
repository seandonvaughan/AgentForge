/**
 * Tests for /api/v5/branches and /api/v5/merge-queue.
 *
 * Key scenario: branch state must survive server restarts. The old in-memory
 * GitBranchManager singleton was silently lost on restart — these tests verify
 * that the SQLite-backed implementation persists across separate app instances
 * sharing the same WorkspaceAdapter (or the same :memory: DB in test).
 *
 * Each test creates a fresh WorkspaceAdapter backed by :memory: SQLite so we
 * get full relational semantics (foreign keys, ON DELETE CASCADE) without
 * touching the filesystem.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { mergeQueueRoutes } from '../merge-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(adapter: WorkspaceAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await mergeQueueRoutes(app, { adapter });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let adapter: WorkspaceAdapter;
let app: FastifyInstance;

beforeEach(async () => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
  app = await buildApp(adapter);
});

afterEach(async () => {
  await app.close();
  adapter.close();
});

// ---------------------------------------------------------------------------
// GET /api/v5/branches
// ---------------------------------------------------------------------------

describe('GET /api/v5/branches', () => {
  it('returns 200 with an empty list when no branches exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/branches' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('lists created branches', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-2' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/branches' });
    const body = res.json() as { data: unknown[]; meta: { total: number } };

    expect(res.statusCode).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
  });

  it('filters by status', async () => {
    // Create two branches
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-2' },
    });

    const id1 = (r1.json() as { data: { id: string } }).data.id;

    // Submit one for review
    await app.inject({ method: 'POST', url: `/api/v5/branches/${id1}/submit` });

    const activeRes = await app.inject({ method: 'GET', url: '/api/v5/branches?status=active' });
    const reviewRes = await app.inject({ method: 'GET', url: '/api/v5/branches?status=review' });

    // r2 branch remains active; r1 moved to review after submit
    expect((activeRes.json() as { data: unknown[] }).data).toHaveLength(1);
    expect((reviewRes.json() as { data: unknown[] }).data).toHaveLength(1);

    // Confirm r2 exists (was created successfully)
    expect((r2.json() as { data: { id: string } }).data.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v5/branches
// ---------------------------------------------------------------------------

describe('POST /api/v5/branches', () => {
  it('creates a branch and returns 201 with the branch shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1', targetBranch: 'main' },
    });

    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(typeof data.id).toBe('string');
    expect(data.agentId).toBe('coder');
    expect(data.taskId).toBe('task-1');
    expect(data.targetBranch).toBe('main');
    expect(data.status).toBe('active');
    expect(typeof data.name).toBe('string');
    expect((data.name as string).startsWith('agent/coder/')).toBe(true);
  });

  it('returns 400 when agentId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { taskId: 'task-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when taskId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('defaults targetBranch to "main" when not specified', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });

    const { data } = res.json() as { data: Record<string, unknown> };
    expect(data.targetBranch).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v5/branches/:id/submit
// ---------------------------------------------------------------------------

describe('POST /api/v5/branches/:id/submit', () => {
  it('submits a branch for review and adds it to the merge queue', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    const branchId = (createRes.json() as { data: { id: string } }).data.id;

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v5/branches/${branchId}/submit`,
      payload: { priority: 'P0' },
    });

    expect(submitRes.statusCode).toBe(201);
    const { data } = submitRes.json() as { data: Record<string, unknown> };
    expect(data.branchId).toBe(branchId);
    expect(data.priority).toBe('P0');
    expect(data.status).toBe('pending');

    // Branch should now be in review status
    const listRes = await app.inject({ method: 'GET', url: '/api/v5/branches?status=review' });
    expect((listRes.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  it('returns 404 for an unknown branch id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/branches/non-existent-id/submit',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/merge-queue
// ---------------------------------------------------------------------------

describe('GET /api/v5/merge-queue', () => {
  it('returns empty queue initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/merge-queue' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('reflects submitted branches in the queue', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    const branchId = (createRes.json() as { data: { id: string } }).data.id;
    await app.inject({ method: 'POST', url: `/api/v5/branches/${branchId}/submit` });

    const res = await app.inject({ method: 'GET', url: '/api/v5/merge-queue' });
    const body = res.json() as { data: Array<Record<string, unknown>> };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.branchId).toBe(branchId);
    expect(body.data[0]!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v5/branches/:id/merge
// ---------------------------------------------------------------------------

describe('POST /api/v5/branches/:id/merge', () => {
  it('merges a branch and marks it as merged', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    const branchId = (createRes.json() as { data: { id: string } }).data.id;
    await app.inject({ method: 'POST', url: `/api/v5/branches/${branchId}/submit` });

    const mergeRes = await app.inject({
      method: 'POST',
      url: `/api/v5/branches/${branchId}/merge`,
    });

    expect(mergeRes.statusCode).toBe(200);
    const { data } = mergeRes.json() as { data: Record<string, unknown> };
    expect(data.status).toBe('merged');
    expect(typeof data.mergedAt).toBe('string');
  });

  it('returns 404 for an unknown branch id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/branches/bad-id/merge' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v5/branches/:id/conflict
// ---------------------------------------------------------------------------

describe('POST /api/v5/branches/:id/conflict', () => {
  it('marks a branch as having a conflict', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    const branchId = (createRes.json() as { data: { id: string } }).data.id;

    const conflictRes = await app.inject({
      method: 'POST',
      url: `/api/v5/branches/${branchId}/conflict`,
      payload: { info: 'Merge conflict on src/index.ts' },
    });

    expect(conflictRes.statusCode).toBe(200);
    expect(conflictRes.json()).toMatchObject({ ok: true });

    // Confirm branch now shows conflict status
    const listRes = await app.inject({ method: 'GET', url: '/api/v5/branches?status=conflict' });
    expect((listRes.json() as { data: unknown[] }).data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/branches/report
// ---------------------------------------------------------------------------

describe('GET /api/v5/branches/report', () => {
  it('returns a summary with correct counts', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-1' },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-2' },
    });

    const id1 = (r1.json() as { data: { id: string } }).data.id;
    const id2 = (r2.json() as { data: { id: string } }).data.id;

    await app.inject({ method: 'POST', url: `/api/v5/branches/${id1}/submit` });
    await app.inject({ method: 'POST', url: `/api/v5/branches/${id2}/conflict`, payload: { info: 'conflict' } });

    const res = await app.inject({ method: 'GET', url: '/api/v5/branches/report' });
    expect(res.statusCode).toBe(200);

    const { data } = res.json() as { data: Record<string, number> };
    expect(data.total).toBe(2);
    expect(data.review).toBe(1);
    expect(data.conflict).toBe(1);
    expect(data.active).toBe(0);
    expect(typeof data.timestamp).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Persistence: state survives re-creating the app with the same adapter
// ---------------------------------------------------------------------------

describe('SQLite persistence across app instances', () => {
  it('branches created in one app instance are visible in a second instance sharing the same adapter', async () => {
    // Create a branch in the first app instance
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-persist' },
    });
    expect(createRes.statusCode).toBe(201);
    const branchId = (createRes.json() as { data: { id: string } }).data.id;

    // Close the first app instance (adapter stays open — same adapter = same DB)
    await app.close();

    // Start a second app instance backed by the same adapter
    const app2 = await buildApp(adapter);

    try {
      const listRes = await app2.inject({ method: 'GET', url: '/api/v5/branches' });
      const body = listRes.json() as { data: Array<{ id: string }> };

      expect(listRes.statusCode).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe(branchId);
    } finally {
      await app2.close();
    }
  });

  it('merge queue entries persist across app instances', async () => {
    // Create and submit a branch in the first instance
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-queue' },
    });
    const branchId = (createRes.json() as { data: { id: string } }).data.id;
    await app.inject({ method: 'POST', url: `/api/v5/branches/${branchId}/submit` });

    await app.close();

    // Second instance sees the queued item
    const app2 = await buildApp(adapter);
    try {
      const queueRes = await app2.inject({ method: 'GET', url: '/api/v5/merge-queue' });
      const body = queueRes.json() as { data: Array<{ branchId: string; status: string }> };

      expect(queueRes.statusCode).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.branchId).toBe(branchId);
      expect(body.data[0]!.status).toBe('pending');
    } finally {
      await app2.close();
    }
  });
});
