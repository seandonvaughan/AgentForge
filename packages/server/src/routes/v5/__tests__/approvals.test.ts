/**
 * Tests for the approvals REST API endpoints.
 *
 * Critical production scenario covered: approvals must survive server restarts.
 * The old in-memory Map was silently lost on every restart — these tests verify
 * that the SQLite-backed implementation persists across separate app instances
 * sharing the same project root (audit.db file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approvalsRoutes } from '../approvals.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await approvalsRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: 'prop-1',
    proposalTitle: 'Add user auth',
    executionId: 'exec-abc',
    impactSummary: 'Adds OAuth2 login.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-approvals-'));
  app = await buildApp(tmpRoot);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /api/v5/approvals
// ---------------------------------------------------------------------------

describe('POST /api/v5/approvals', () => {
  it('creates a pending approval and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: makeBody(),
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(data.status).toBe('pending');
    expect(data.proposalId).toBe('prop-1');
    expect(data.executionId).toBe('exec-abc');
    expect(typeof data.id).toBe('string');
    expect(typeof data.submittedAt).toBe('string');
  });

  it('returns 400 when proposalId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: { executionId: 'exec-1', impactSummary: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('proposalId') });
  });

  it('returns 400 when executionId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: { proposalId: 'p-1', impactSummary: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores diff and testSummary when provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: makeBody({
        diff: '--- a/foo.ts\n+++ b/foo.ts\n@@',
        testSummary: { passed: 10, failed: 0, total: 10 },
      }),
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(data.diff).toBe('--- a/foo.ts\n+++ b/foo.ts\n@@');
    expect(data.testSummary).toEqual({ passed: 10, failed: 0, total: 10 });
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/approvals
// ---------------------------------------------------------------------------

describe('GET /api/v5/approvals', () => {
  it('returns empty list when no approvals exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/approvals' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { total: number; pending: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.pending).toBe(0);
  });

  it('lists all submitted approvals sorted newest-first', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody({ proposalId: 'p-1' }) });
    await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody({ proposalId: 'p-2' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/approvals' });
    const { data } = res.json() as { data: Array<{ proposalId: string }> };
    expect(data).toHaveLength(2);
    // Newest first — p-2 was submitted last
    expect(data[0]!.proposalId).toBe('p-2');
    expect(data[1]!.proposalId).toBe('p-1');
  });

  it('filters by status=pending', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: makeBody(),
    });
    const id = (createRes.json() as { data: { id: string } }).data.id;
    // Approve it
    await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/approve` });
    // Create another pending one
    await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody({ proposalId: 'p-2' }) });

    const res = await app.inject({ method: 'GET', url: '/api/v5/approvals?status=pending' });
    const { data } = res.json() as { data: Array<{ status: string }> };
    expect(data).toHaveLength(1);
    expect(data[0]!.status).toBe('pending');
  });

  it('meta.pending counts only pending items regardless of status filter', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody({ proposalId: 'p-1' }) });
    await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody({ proposalId: 'p-2' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/approvals' });
    const { meta } = res.json() as { meta: { pending: number } };
    expect(meta.pending).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/approvals/:id
// ---------------------------------------------------------------------------

describe('GET /api/v5/approvals/:id', () => {
  it('returns the item by id', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: makeBody(),
    });
    const id = (createRes.json() as { data: { id: string } }).data.id;
    const res = await app.inject({ method: 'GET', url: `/api/v5/approvals/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { id: string } }).data.id).toBe(id);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/approvals/no-such-id' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/approvals/:id/approve
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/approvals/:id/approve', () => {
  it('transitions status from pending to approved', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/approvals/${id}/approve`,
      payload: { reviewedBy: 'alice', notes: 'LGTM' },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { status: string; reviewedBy: string; notes: string; reviewedAt: string };
    };
    expect(data.status).toBe('approved');
    expect(data.reviewedBy).toBe('alice');
    expect(data.notes).toBe('LGTM');
    expect(typeof data.reviewedAt).toBe('string');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v5/approvals/ghost/approve' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when item is not pending', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;
    await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/approve` });
    // Second approve attempt
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('approve') });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/approvals/:id/reject
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/approvals/:id/reject', () => {
  it('transitions status from pending to rejected', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/approvals/${id}/reject`,
      payload: { reviewedBy: 'bob', notes: 'Needs tests' },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { status: string; reviewedBy: string } };
    expect(data.status).toBe('rejected');
    expect(data.reviewedBy).toBe('bob');
  });

  it('returns 409 when item is not pending', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;
    await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/reject` });
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/reject` });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/approvals/:id/rollback
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/approvals/:id/rollback', () => {
  it('transitions an approved item to rolled_back', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;
    await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/approve` });

    const res = await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/rollback` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { status: string } }).data.status).toBe('rolled_back');
  });

  it('returns 409 when item is not approved (e.g. pending)', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/rollback` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Only approved items can be rolled back' });
  });
});

// ---------------------------------------------------------------------------
// PERSISTENCE TEST — the critical regression guard
// ---------------------------------------------------------------------------

describe('Persistence across server restarts', () => {
  it('retains approvals after the Fastify app is closed and reopened with the same projectRoot', async () => {
    // Submit an approval in the first app instance
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: makeBody({ proposalId: 'persist-me', executionId: 'exec-persist' }),
    });
    expect(createRes.statusCode).toBe(201);
    const originalId = (createRes.json() as { data: { id: string } }).data.id;

    // Shut down the first app (closes DB connection)
    await app.close();

    // Spin up a fresh app pointing at the SAME project root
    const app2 = await buildApp(tmpRoot);
    try {
      const listRes = await app2.inject({ method: 'GET', url: '/api/v5/approvals' });
      expect(listRes.statusCode).toBe(200);
      const { data } = listRes.json() as { data: Array<{ id: string; proposalId: string }> };
      expect(data).toHaveLength(1);
      expect(data[0]!.id).toBe(originalId);
      expect(data[0]!.proposalId).toBe('persist-me');

      const getRes = await app2.inject({ method: 'GET', url: `/api/v5/approvals/${originalId}` });
      expect(getRes.statusCode).toBe(200);
    } finally {
      await app2.close();
    }
  });

  it('retains approved status across restart (state mutations persist too)', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/approvals', payload: makeBody() })).json() as {
        data: { id: string };
      }
    ).data.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v5/approvals/${id}/approve`,
      payload: { reviewedBy: 'alice', notes: 'Ship it' },
    });
    await app.close();

    const app2 = await buildApp(tmpRoot);
    try {
      const res = await app2.inject({ method: 'GET', url: `/api/v5/approvals/${id}` });
      const { data } = res.json() as {
        data: { status: string; reviewedBy: string; notes: string };
      };
      expect(data.status).toBe('approved');
      expect(data.reviewedBy).toBe('alice');
      expect(data.notes).toBe('Ship it');
    } finally {
      await app2.close();
    }
  });
});
