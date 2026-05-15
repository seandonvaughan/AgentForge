import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schedulesRoutes } from '../schedules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await schedulesRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-schedules-'));
  app = await buildApp(tmpRoot);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Nightly cycle',
    cronExpression: '0 2 * * *',
    cycleConfig: { branch: 'main' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v5/schedules
// ---------------------------------------------------------------------------

describe('POST /api/v5/schedules', () => {
  it('creates a schedule and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/schedules',
      payload: makeBody(),
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(typeof data.id).toBe('string');
    expect(data.name).toBe('Nightly cycle');
    expect(data.cronExpression).toBe('0 2 * * *');
    expect(data.enabled).toBe(true);
    expect(data.lastRunAt).toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/schedules',
      payload: { cronExpression: '0 2 * * *' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('name') });
  });

  it('returns 400 when cronExpression is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/schedules',
      payload: { name: 'Test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid cron expression', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/schedules',
      payload: makeBody({ cronExpression: 'not-a-cron' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('cron') });
  });

  it('accepts a complex cron expression', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/schedules',
      payload: makeBody({ cronExpression: '0 8-18/2 * * 1-5' }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('creates disabled schedule when enabled=false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/schedules',
      payload: makeBody({ enabled: false }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { enabled: boolean } }).data.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/schedules
// ---------------------------------------------------------------------------

describe('GET /api/v5/schedules', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/schedules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('lists all schedules', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody({ name: 'S1' }) });
    await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody({ name: 'S2' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/schedules' });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/schedules/:id
// ---------------------------------------------------------------------------

describe('GET /api/v5/schedules/:id', () => {
  it('returns the schedule by id', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody() });
    const id = (createRes.json() as { data: { id: string } }).data.id;
    const res = await app.inject({ method: 'GET', url: `/api/v5/schedules/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { id: string } }).data.id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/schedules/no-such-id' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/schedules/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/schedules/:id', () => {
  it('updates name and returns updated schedule', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/schedules/${id}`,
      payload: { name: 'Updated name' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { name: string } }).data.name).toBe('Updated name');
  });

  it('returns 400 for invalid cron on update', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/schedules/${id}`,
      payload: { cronExpression: 'bad cron' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v5/schedules/ghost', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v5/schedules/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v5/schedules/:id', () => {
  it('deletes a schedule and returns 204', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const delRes = await app.inject({ method: 'DELETE', url: `/api/v5/schedules/${id}` });
    expect(delRes.statusCode).toBe(204);
    const getRes = await app.inject({ method: 'GET', url: `/api/v5/schedules/${id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 404 when deleting non-existent schedule', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/schedules/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

describe('Audit entries created for mutations', () => {
  it('writes an audit entry on CREATE', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/schedules', payload: makeBody() });
    // Verify by querying the audit endpoint
    const auditApp = Fastify({ logger: false });
    const { auditRoutes } = await import('../audit.js');
    await auditRoutes(auditApp, { projectRoot: tmpRoot });
    await auditApp.ready();
    try {
      const res = await auditApp.inject({ method: 'GET', url: '/api/v5/audit?actor=system' });
      const { data } = res.json() as { data: Array<{ action: string }> };
      expect(data.some(e => e.action === 'CREATE_SCHEDULE')).toBe(true);
    } finally {
      await auditApp.close();
    }
  });
});
