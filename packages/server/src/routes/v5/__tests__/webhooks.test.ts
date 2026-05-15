import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { webhooksRoutes } from '../webhooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

async function buildApp(projectRoot: string, fetch?: FetchLike): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await webhooksRoutes(app, fetch !== undefined ? { projectRoot, fetch } : { projectRoot });
  await app.ready();
  return app;
}

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-webhooks-'));
  app = await buildApp(tmpRoot);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Slack notify',
    url: 'https://hooks.slack.com/test',
    events: ['cycle.completed'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v5/webhooks
// ---------------------------------------------------------------------------

describe('POST /api/v5/webhooks', () => {
  it('creates a webhook and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(typeof data.id).toBe('string');
    expect(data.name).toBe('Slack notify');
    expect(data.url).toBe('https://hooks.slack.com/test');
    expect(data.enabled).toBe(true);
    expect(data.lastDeliveryAt).toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: { url: 'https://x.com' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('name') });
  });

  it('returns 400 when url is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: { name: 'X' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid url', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody({ url: 'not-a-url' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('url') });
  });

  it('stores secret when provided', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody({ secret: 'my-secret' }) });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: { secret: string } };
    expect(data.secret).toBe('my-secret');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/webhooks
// ---------------------------------------------------------------------------

describe('GET /api/v5/webhooks', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/webhooks' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it('lists all webhooks', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody({ name: 'W1' }) });
    await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody({ name: 'W2' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/webhooks' });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/webhooks/:id
// ---------------------------------------------------------------------------

describe('GET /api/v5/webhooks/:id', () => {
  it('returns the webhook by id', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'GET', url: `/api/v5/webhooks/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { id: string } }).data.id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/webhooks/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/webhooks/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/webhooks/:id', () => {
  it('updates name', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/webhooks/${id}`, payload: { name: 'New name' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { name: string } }).data.name).toBe('New name');
  });

  it('returns 400 for invalid url on update', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/webhooks/${id}`, payload: { url: 'bad-url' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v5/webhooks/ghost', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v5/webhooks/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v5/webhooks/:id', () => {
  it('deletes and returns 204', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
    ).data.id;
    const delRes = await app.inject({ method: 'DELETE', url: `/api/v5/webhooks/${id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v5/webhooks/${id}` })).statusCode).toBe(404);
  });

  it('returns 404 when deleting non-existent webhook', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/webhooks/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v5/webhooks/:id/test
// ---------------------------------------------------------------------------

describe('POST /api/v5/webhooks/:id/test', () => {
  it('fires sample payload and returns success status', async () => {
    const mockFetch: FetchLike = async () => ({ ok: true, status: 200 });
    const testApp = await buildApp(tmpRoot, mockFetch);
    try {
      const id = (
        (await testApp.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
      ).data.id;
      const res = await testApp.inject({ method: 'POST', url: `/api/v5/webhooks/${id}/test` });
      expect(res.statusCode).toBe(200);
      const { data } = res.json() as { data: { deliveryStatus: string; httpStatus: number } };
      expect(data.deliveryStatus).toBe('success');
      expect(data.httpStatus).toBe(200);
    } finally {
      await testApp.close();
    }
  });

  it('records failure status when target returns 4xx', async () => {
    const mockFetch: FetchLike = async () => ({ ok: false, status: 403 });
    const testApp = await buildApp(tmpRoot, mockFetch);
    try {
      const id = (
        (await testApp.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
      ).data.id;
      const res = await testApp.inject({ method: 'POST', url: `/api/v5/webhooks/${id}/test` });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { data: { deliveryStatus: string } }).data.deliveryStatus).toBe('failure');
    } finally {
      await testApp.close();
    }
  });

  it('returns 404 when testing non-existent webhook', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/webhooks/no-such/test' });
    expect(res.statusCode).toBe(404);
  });

  it('updates lastDeliveryAt after test', async () => {
    const mockFetch: FetchLike = async () => ({ ok: true, status: 200 });
    const testApp = await buildApp(tmpRoot, mockFetch);
    try {
      const id = (
        (await testApp.inject({ method: 'POST', url: '/api/v5/webhooks', payload: makeBody() })).json() as { data: { id: string } }
      ).data.id;
      await testApp.inject({ method: 'POST', url: `/api/v5/webhooks/${id}/test` });
      const getRes = await testApp.inject({ method: 'GET', url: `/api/v5/webhooks/${id}` });
      const { data } = getRes.json() as { data: { lastDeliveryAt: string; lastDeliveryStatus: string } };
      expect(typeof data.lastDeliveryAt).toBe('string');
      expect(data.lastDeliveryStatus).toBe('success');
    } finally {
      await testApp.close();
    }
  });
});
