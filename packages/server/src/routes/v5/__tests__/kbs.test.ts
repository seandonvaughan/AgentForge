/**
 * Route tests for /api/v5/kbs — covers KB CRUD, doc create/update with
 * version bump, history, and per-version retrieval. Hits a real Fastify
 * instance with an in-memory WorkspaceAdapter (no mocks).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter } from '@agentforge/db';
import { kbsRoutes } from '../kbs.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await kbsRoutes(a, { adapter, projectRoot });
  await a.ready();
  return a;
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-kbs-'));
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

async function createKb(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v5/kbs',
    payload: {
      slug: 'gate-rubric',
      title: 'Gate Rubric',
      owner: 'architect',
      ...overrides,
    },
  });
}

async function createKbDoc(kbId: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/v5/kbs/${kbId}/docs`,
    payload: {
      slug: 'intro',
      title: 'Intro',
      bodyMd: '# Intro\n\nFirst draft.',
      authoredBy: 'architect',
      commitMessage: 'initial',
      ...overrides,
    },
  });
}

describe('POST /api/v5/kbs', () => {
  it('creates a KB and returns 201', async () => {
    const res = await createKb();
    expect(res.statusCode).toBe(201);
    const json = res.json() as { data: { id: string; slug: string; visibility: string } };
    expect(json.data.slug).toBe('gate-rubric');
    expect(json.data.visibility).toBe('workspace');
    expect(json.data.id).toMatch(/.+/);
  });

  it('honours private visibility', async () => {
    const res = await createKb({ slug: 'priv', visibility: 'private' });
    const json = res.json() as { data: { visibility: string } };
    expect(json.data.visibility).toBe('private');
  });

  it('rejects missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/kbs',
      payload: { slug: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid visibility', async () => {
    const res = await createKb({ slug: 'bad', visibility: 'secret' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate slugs', async () => {
    await createKb();
    const dup = await createKb();
    expect(dup.statusCode).toBe(400);
    expect((dup.json() as { error: string }).error).toMatch(/already exists/);
  });
});

describe('GET /api/v5/kbs', () => {
  it('lists KBs', async () => {
    await createKb({ slug: 'a' });
    await createKb({ slug: 'b' });
    const res = await app.inject({ method: 'GET', url: '/api/v5/kbs' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: Array<{ slug: string }> };
    expect(json.data).toHaveLength(2);
    expect(json.data.map((k) => k.slug).sort()).toEqual(['a', 'b']);
  });

  it('filters by visibility', async () => {
    await createKb({ slug: 'open', visibility: 'public' });
    await createKb({ slug: 'hush', visibility: 'private' });
    const res = await app.inject({ method: 'GET', url: '/api/v5/kbs?visibility=private' });
    const json = res.json() as { data: Array<{ slug: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.slug).toBe('hush');
  });

  it('rejects invalid visibility query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/kbs?visibility=bogus' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v5/kbs/:kbId', () => {
  it('returns KB with doc count', async () => {
    const created = await createKb();
    const id = (created.json() as { data: { id: string } }).data.id;
    await createKbDoc(id);
    const res = await app.inject({ method: 'GET', url: `/api/v5/kbs/${id}` });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: { slug: string }; meta: { docCount: number } };
    expect(json.data.slug).toBe('gate-rubric');
    expect(json.meta.docCount).toBe(1);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/kbs/none' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/v5/kbs/:kbId', () => {
  it('updates title and description', async () => {
    const created = await createKb();
    const id = (created.json() as { data: { id: string } }).data.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${id}`,
      payload: { title: 'New', description: 'fresh' },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: { title: string; description: string } };
    expect(json.data.title).toBe('New');
    expect(json.data.description).toBe('fresh');
  });

  it('rejects invalid visibility', async () => {
    const created = await createKb();
    const id = (created.json() as { data: { id: string } }).data.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${id}`,
      payload: { visibility: 'secret' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/kbs/none',
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v5/kbs/:kbId', () => {
  it('deletes a KB and cascades its docs', async () => {
    const created = await createKb();
    const id = (created.json() as { data: { id: string } }).data.id;
    await createKbDoc(id);
    const res = await app.inject({ method: 'DELETE', url: `/api/v5/kbs/${id}` });
    expect(res.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: `/api/v5/kbs/${id}` });
    expect(after.statusCode).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/kbs/none' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v5/kbs/:kbId/docs', () => {
  it('creates a doc at v1', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    const res = await createKbDoc(kb.data.id);
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      data: { slug: string; currentVersion: number; body: { bodyMd: string } | null };
    };
    expect(json.data.slug).toBe('intro');
    expect(json.data.currentVersion).toBe(1);
    expect(json.data.body?.bodyMd).toMatch(/First draft/);
  });

  it('rejects missing fields', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/kbs/${kb.data.id}/docs`,
      payload: { slug: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when KB does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/kbs/none/docs',
      payload: { slug: 'x', title: 'X', bodyMd: 'b', authoredBy: 'a' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects duplicate doc slugs within a KB', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);
    const dup = await createKbDoc(kb.data.id);
    expect(dup.statusCode).toBe(400);
  });
});

describe('GET /api/v5/kbs/:kbId/docs + GET /:docSlug', () => {
  it('lists and fetches', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id, { slug: 'a', title: 'A' });
    await createKbDoc(kb.data.id, { slug: 'b', title: 'B' });

    const list = await app.inject({ method: 'GET', url: `/api/v5/kbs/${kb.data.id}/docs` });
    expect(list.statusCode).toBe(200);
    const listJson = list.json() as { data: Array<{ slug: string }> };
    expect(listJson.data).toHaveLength(2);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/a`,
    });
    expect(detail.statusCode).toBe(200);
    const detailJson = detail.json() as { data: { slug: string; body: { bodyMd: string } } };
    expect(detailJson.data.slug).toBe('a');
    expect(detailJson.data.body.bodyMd).toMatch(/First draft/);
  });

  it('returns 404 for unknown doc slug', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/missing`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/v5/kbs/:kbId/docs/:docSlug', () => {
  it('appends a new version and bumps current_version', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
      payload: {
        bodyMd: '# Intro\n\nSecond draft.',
        authoredBy: 'gate',
        commitMessage: 'rewrote intro',
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      data: { currentVersion: number; body: { bodyMd: string; commitMessage: string } };
    };
    expect(json.data.currentVersion).toBe(2);
    expect(json.data.body.bodyMd).toMatch(/Second draft/);
    expect(json.data.body.commitMessage).toBe('rewrote intro');
  });

  it('rejects missing fields', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
      payload: { bodyMd: 'only' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown doc', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/missing`,
      payload: { bodyMd: 'x', authoredBy: 'a' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /versions endpoints', () => {
  it('returns version history newest-first', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);
    await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
      payload: { bodyMd: 'v2', authoredBy: 'g' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
      payload: { bodyMd: 'v3', authoredBy: 'g' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro/versions`,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: Array<{ version: number; bodyMd: string }> };
    expect(json.data.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('returns specific version by number', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);
    await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
      payload: { bodyMd: 'v2 body', authoredBy: 'g' },
    });

    const v1 = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro/versions/1`,
    });
    expect(v1.statusCode).toBe(200);
    expect((v1.json() as { data: { bodyMd: string } }).data.bodyMd).toMatch(/First draft/);

    const v2 = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro/versions/2`,
    });
    expect(v2.statusCode).toBe(200);
    expect((v2.json() as { data: { bodyMd: string } }).data.bodyMd).toBe('v2 body');
  });

  it('returns 400 for non-numeric version', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro/versions/abc`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown version', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    await createKbDoc(kb.data.id);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro/versions/99`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('end-to-end via routes', () => {
  it('create KB -> create doc -> update -> fetch v1 + current via routes', async () => {
    const kb = (await createKb()).json() as { data: { id: string } };
    const created = (await createKbDoc(kb.data.id, {
      bodyMd: 'first body',
    })).json() as { data: { id: string } };

    await app.inject({
      method: 'PATCH',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
      payload: { bodyMd: 'second body', authoredBy: 'a', commitMessage: 'edit' },
    });

    const v1 = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro/versions/1`,
    });
    expect((v1.json() as { data: { bodyMd: string } }).data.bodyMd).toBe('first body');

    const current = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs/intro`,
    });
    const currentJson = current.json() as {
      data: { currentVersion: number; body: { bodyMd: string } };
    };
    expect(currentJson.data.currentVersion).toBe(2);
    expect(currentJson.data.body.bodyMd).toBe('second body');

    // sanity: created.id matches the listed doc id
    const list = await app.inject({
      method: 'GET',
      url: `/api/v5/kbs/${kb.data.id}/docs`,
    });
    const listJson = list.json() as { data: Array<{ id: string }> };
    expect(listJson.data[0]?.id).toBe(created.data.id);
  });
});
