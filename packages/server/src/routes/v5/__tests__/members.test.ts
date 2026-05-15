import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { membersRoutes } from '../members.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await membersRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-members-'));
  app = await buildApp(tmpRoot);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { email: 'alice@example.com', displayName: 'Alice', role: 'operator', ...overrides };
}

// ---------------------------------------------------------------------------
// POST /api/v5/members
// ---------------------------------------------------------------------------

describe('POST /api/v5/members', () => {
  it('creates a member and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(typeof data.id).toBe('string');
    expect(data.email).toBe('alice@example.com');
    expect(data.displayName).toBe('Alice');
    expect(data.role).toBe('operator');
    expect(data.lastSeenAt).toBeNull();
  });

  it('defaults role to viewer when not provided', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: { email: 'b@example.com', displayName: 'Bob' } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { role: string } }).data.role).toBe('viewer');
  });

  it('returns 400 when email is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: { displayName: 'X', role: 'viewer' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('email') });
  });

  it('returns 400 for invalid email format', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ email: 'not-an-email' }) });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when displayName is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: { email: 'x@x.com', role: 'viewer' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid role', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ role: 'superuser' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('role') });
  });

  it('returns 409 for duplicate email', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() });
    const res = await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/members
// ---------------------------------------------------------------------------

describe('GET /api/v5/members', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/members' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it('lists all members', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ email: 'a@a.com' }) });
    await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ email: 'b@b.com' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/members' });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2);
  });

  it('filters by role', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ email: 'op@x.com', role: 'operator' }) });
    await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ email: 'ad@x.com', role: 'admin' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/members?role=operator' });
    const { data } = res.json() as { data: Array<{ role: string }> };
    expect(data).toHaveLength(1);
    expect(data[0]!.role).toBe('operator');
  });

  it('returns 400 for invalid role filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/members?role=god' });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/members/:id
// ---------------------------------------------------------------------------

describe('GET /api/v5/members/:id', () => {
  it('returns member by id', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'GET', url: `/api/v5/members/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { id: string } }).data.id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/members/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/members/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/members/:id', () => {
  it('updates displayName', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/members/${id}`, payload: { displayName: 'Alicia' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { displayName: string } }).data.displayName).toBe('Alicia');
  });

  it('updates role', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/members/${id}`, payload: { role: 'admin' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { role: string } }).data.role).toBe('admin');
  });

  it('returns 400 for invalid role on update', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/members/${id}`, payload: { role: 'root' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v5/members/ghost', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v5/members/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v5/members/:id', () => {
  it('deletes and returns 204', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const delRes = await app.inject({ method: 'DELETE', url: `/api/v5/members/${id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v5/members/${id}` })).statusCode).toBe(404);
  });

  it('returns 404 when deleting non-existent member', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/members/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('Persistence across restarts', () => {
  it('retains members after app is closed and reopened', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/members', payload: makeBody({ email: 'persist@test.com' }) });
    await app.close();

    const app2 = await buildApp(tmpRoot);
    try {
      const res = await app2.inject({ method: 'GET', url: '/api/v5/members' });
      const { data } = res.json() as { data: Array<{ email: string }> };
      expect(data).toHaveLength(1);
      expect(data[0]!.email).toBe('persist@test.com');
    } finally {
      await app2.close();
    }
  });
});
