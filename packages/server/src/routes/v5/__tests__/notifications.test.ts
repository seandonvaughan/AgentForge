import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { notificationsRoutes } from '../notifications.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await notificationsRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-notifs-'));
  app = await buildApp(tmpRoot);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'info', title: 'Test notif', body: 'Something happened.', ...overrides };
}

// ---------------------------------------------------------------------------
// POST /api/v5/notifications
// ---------------------------------------------------------------------------

describe('POST /api/v5/notifications', () => {
  it('creates a notification and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(typeof data.id).toBe('string');
    expect(data.kind).toBe('info');
    expect(data.title).toBe('Test notif');
    expect(data.read).toBe(false);
  });

  it('returns 400 for invalid kind', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ kind: 'bad-kind' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('kind') });
  });

  it('returns 400 when title is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: { kind: 'info', body: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: { kind: 'info', title: 'T' } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts warning kind', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ kind: 'warning' }) });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { kind: string } }).data.kind).toBe('warning');
  });

  it('accepts action_required kind', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ kind: 'action_required' }) });
    expect(res.statusCode).toBe(201);
  });

  it('stores link when provided', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ link: '/cycles/abc' }) });
    const { data } = res.json() as { data: { link: string } };
    expect(data.link).toBe('/cycles/abc');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/notifications
// ---------------------------------------------------------------------------

describe('GET /api/v5/notifications', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/notifications' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { total: number; unread: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.unread).toBe(0);
  });

  it('returns all notifications by default', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ title: 'N1' }) });
    await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ title: 'N2' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/notifications' });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2);
  });

  it('filters unread=true', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() });
    const id = (createRes.json() as { data: { id: string } }).data.id;
    await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody({ title: 'Unread' }) });
    // Mark first as read
    await app.inject({ method: 'PATCH', url: `/api/v5/notifications/${id}/read` });

    const res = await app.inject({ method: 'GET', url: '/api/v5/notifications?unread=true' });
    const { data } = res.json() as { data: Array<{ read: boolean }> };
    expect(data.every(n => !n.read)).toBe(true);
    expect(data).toHaveLength(1);
  });

  it('meta.unread counts correctly', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() });
    await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() });
    const res = await app.inject({ method: 'GET', url: '/api/v5/notifications' });
    const { meta } = res.json() as { meta: { unread: number } };
    expect(meta.unread).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/notifications/:id/read
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/notifications/:id/read', () => {
  it('marks notification as read', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/notifications/${id}/read` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { read: boolean } }).data.read).toBe(true);
  });

  it('is idempotent — marking read twice stays read', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    await app.inject({ method: 'PATCH', url: `/api/v5/notifications/${id}/read` });
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/notifications/${id}/read` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { read: boolean } }).data.read).toBe(true);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v5/notifications/no-such/read' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('Persistence across restarts', () => {
  it('retains notifications and read state after restart', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/notifications', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    await app.inject({ method: 'PATCH', url: `/api/v5/notifications/${id}/read` });
    await app.close();

    const app2 = await buildApp(tmpRoot);
    try {
      const res = await app2.inject({ method: 'GET', url: '/api/v5/notifications' });
      const { data } = res.json() as { data: Array<{ id: string; read: boolean }> };
      const found = data.find(n => n.id === id);
      expect(found).toBeDefined();
      expect(found?.read).toBe(true);
    } finally {
      await app2.close();
    }
  });
});
