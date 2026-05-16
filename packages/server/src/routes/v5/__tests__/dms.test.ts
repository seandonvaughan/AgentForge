/**
 * Route tests for /api/v5/dms — uses Fastify.inject() against the real
 * adapter (in-memory SQLite) so we exercise validation + persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter } from '@agentforge/db';
import { dmsRoutes } from '../dms.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await dmsRoutes(a, { adapter, projectRoot });
  await a.ready();
  return a;
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-dms-'));
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /api/v5/dms', () => {
  it('creates a DM and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'a', toAgent: 'b', body: 'hello' },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as { data: { id: string; fromAgent: string; toAgent: string; body: string } };
    expect(json.data.fromAgent).toBe('a');
    expect(json.data.body).toBe('hello');
  });

  it('rejects missing fields with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'a', body: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('threads via replyToId', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'a', toAgent: 'b', body: 'q' },
    });
    const parentId = (parent.json() as { data: { id: string } }).data.id;

    const child = await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'b', toAgent: 'a', body: 'r', replyToId: parentId },
    });
    expect(child.statusCode).toBe(201);
    expect((child.json() as { data: { replyToId: string } }).data.replyToId).toBe(parentId);
  });

  it('rejects unknown replyToId with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'a', toAgent: 'b', body: 'x', replyToId: 'ghost' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v5/dms', () => {
  it('requires agentId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/dms' });
    expect(res.statusCode).toBe(400);
  });

  it('returns DMs touching the agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'a', toAgent: 'b', body: '1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'b', toAgent: 'a', body: '2' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'c', toAgent: 'd', body: 'unrelated' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/dms?agentId=a' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: Array<{ body: string }> };
    expect(data).toHaveLength(2);
    expect(data.map((d) => d.body).sort()).toEqual(['1', '2']);
  });
});

describe('GET /api/v5/dms/threads', () => {
  it('groups replies into a single thread', async () => {
    const parent = (
      await app.inject({
        method: 'POST',
        url: '/api/v5/dms',
        payload: { fromAgent: 'a', toAgent: 'b', body: 'q' },
      })
    ).json() as { data: { id: string } };
    await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'b', toAgent: 'a', body: 'r1', replyToId: parent.data.id },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'b', toAgent: 'a', body: 'r2', replyToId: parent.data.id },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v5/dms',
      payload: { fromAgent: 'a', toAgent: 'b', body: 'q2 (new thread)' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/dms/threads?agentId=a' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: Array<{ threadId: string; messages: Array<{ body: string }> }>;
    };
    expect(data).toHaveLength(2);
    const longThread = data.find((t) => t.messages.length === 3);
    expect(longThread).toBeDefined();
  });
});
