/**
 * Route tests for /api/v5/inbox — exercises validation, listing, status
 * filtering, and read-marking against a real adapter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter } from '@agentforge/db';
import { inboxRoutes } from '../inbox.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await inboxRoutes(a, { adapter, projectRoot });
  await a.ready();
  return a;
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-inbox-'));
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

async function postMessage(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v5/inbox',
    payload: {
      body: 'budget warning 80%',
      kind: 'warning',
      sourceType: 'cost-warning',
      sourceId: 'cycle-1',
      recipients: ['@user'],
      ...overrides,
    },
  });
}

describe('POST /api/v5/inbox', () => {
  it('creates a message and returns 201 with id + recipients', async () => {
    const res = await postMessage();
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      data: { message: { id: string; kind: string }; recipients: Array<{ recipient: string; status: string }> };
    };
    expect(json.data.message.kind).toBe('warning');
    expect(json.data.recipients[0]?.recipient).toBe('@user');
    expect(json.data.recipients[0]?.status).toBe('unread');
  });

  it('rejects invalid kind', async () => {
    const res = await postMessage({ kind: 'banana' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty recipients', async () => {
    const res = await postMessage({ recipients: [] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unsupported recipients in v1', async () => {
    const res = await postMessage({ recipients: ['@team-reviewers'] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not supported in v1/);
  });
});

describe('GET /api/v5/inbox', () => {
  it('requires recipient', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/inbox' });
    expect(res.statusCode).toBe(400);
  });

  it('lists messages with unread count meta', async () => {
    await postMessage({ body: 'first' });
    await postMessage({ body: 'second' });
    const res = await app.inject({ method: 'GET', url: '/api/v5/inbox?recipient=%40user' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      data: Array<{ body: string; status: string }>;
      meta: { unread: number };
    };
    expect(json.data).toHaveLength(2);
    expect(json.data.map((d) => d.body).sort()).toEqual(['first', 'second']);
    expect(json.meta.unread).toBe(2);
  });

  it('filters by status', async () => {
    const first = await postMessage({ body: 'one' });
    const id = (first.json() as { data: { message: { id: string } } }).data.message.id;
    await postMessage({ body: 'two' });

    await app.inject({
      method: 'PATCH',
      url: `/api/v5/inbox/${id}/read?recipient=%40user`,
    });

    const unread = await app.inject({
      method: 'GET',
      url: '/api/v5/inbox?recipient=%40user&status=unread',
    });
    const json = unread.json() as { data: Array<{ body: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.body).toBe('two');
  });
});

describe('GET /api/v5/inbox/:id', () => {
  it('returns the message and its recipients', async () => {
    const created = await postMessage({ body: 'find me' });
    const id = (created.json() as { data: { message: { id: string } } }).data.message.id;
    const res = await app.inject({ method: 'GET', url: `/api/v5/inbox/${id}` });
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      data: { message: { body: string }; recipients: Array<{ recipient: string }> };
    };
    expect(json.data.message.body).toBe('find me');
    expect(json.data.recipients[0]?.recipient).toBe('@user');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/inbox/no-such-id' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/v5/inbox/:id/read', () => {
  it('marks the message read for the recipient', async () => {
    const created = await postMessage();
    const id = (created.json() as { data: { message: { id: string } } }).data.message.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/inbox/${id}/read?recipient=%40user`,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: { status: string; readAt: string | null } };
    expect(json.data.status).toBe('read');
    expect(json.data.readAt).not.toBeNull();
  });

  it('returns 404 for unknown message', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/inbox/none/read?recipient=%40user',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects unsupported recipient', async () => {
    const created = await postMessage();
    const id = (created.json() as { data: { message: { id: string } } }).data.message.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/inbox/${id}/read?recipient=%40team-x`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires recipient query parameter', async () => {
    const created = await postMessage();
    const id = (created.json() as { data: { message: { id: string } } }).data.message.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/inbox/${id}/read` });
    expect(res.statusCode).toBe(400);
  });
});
