import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apiKeysRoutes } from '../api-keys.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await apiKeysRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-keys-'));
  app = await buildApp(tmpRoot);
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { label: 'CI token', scopes: ['read:cycles', 'read:agents'], ...overrides };
}

// ---------------------------------------------------------------------------
// POST /api/v5/keys
// ---------------------------------------------------------------------------

describe('POST /api/v5/keys', () => {
  it('creates a key and returns 201 with rawKey', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: { key: Record<string, unknown>; rawKey: string } };
    expect(typeof data.rawKey).toBe('string');
    expect(data.rawKey).toMatch(/^agf_/);
    expect(data.key.label).toBe('CI token');
    expect(data.key.revoked).toBe(false);
  });

  it('rawKey starts with agf_ prefix', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() });
    const { data } = res.json() as { data: { rawKey: string } };
    expect(data.rawKey.startsWith('agf_')).toBe(true);
  });

  it('does NOT expose keyHash in creation response', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() });
    const { data } = res.json() as { data: { key: Record<string, unknown> } };
    expect(data.key.keyHash).toBe('');
  });

  it('returns 400 when label is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/keys', payload: { scopes: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('label') });
  });

  it('creates key with empty scopes by default', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/keys', payload: { label: 'No scopes' } });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as { data: { key: { scopes: string[] } } };
    expect(data.key.scopes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/keys
// ---------------------------------------------------------------------------

describe('GET /api/v5/keys', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/keys' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it('lists keys WITHOUT keyHash in response', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() });
    const res = await app.inject({ method: 'GET', url: '/api/v5/keys' });
    const { data } = res.json() as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty('keyHash');
  });

  it('lists multiple keys', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody({ label: 'K1' }) });
    await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody({ label: 'K2' }) });
    const res = await app.inject({ method: 'GET', url: '/api/v5/keys' });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/keys/:id
// ---------------------------------------------------------------------------

describe('GET /api/v5/keys/:id', () => {
  it('returns key by id without keyHash', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() })).json() as { data: { key: { id: string } } }
    ).data.key.id;
    const res = await app.inject({ method: 'GET', url: `/api/v5/keys/${id}` });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: Record<string, unknown> };
    expect(data.id).toBe(id);
    expect(data).not.toHaveProperty('keyHash');
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/keys/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v5/keys/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/keys/:id', () => {
  it('updates label', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() })).json() as { data: { key: { id: string } } }
    ).data.key.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/keys/${id}`, payload: { label: 'New label' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { label: string } }).data.label).toBe('New label');
  });

  it('updates scopes', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() })).json() as { data: { key: { id: string } } }
    ).data.key.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/keys/${id}`, payload: { scopes: ['admin'] } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { scopes: string[] } }).data.scopes).toEqual(['admin']);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v5/keys/ghost', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when updating a revoked key', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() })).json() as { data: { key: { id: string } } }
    ).data.key.id;
    await app.inject({ method: 'DELETE', url: `/api/v5/keys/${id}` });
    const res = await app.inject({ method: 'PATCH', url: `/api/v5/keys/${id}`, payload: { label: 'X' } });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v5/keys/:id (revoke)
// ---------------------------------------------------------------------------

describe('DELETE /api/v5/keys/:id', () => {
  it('revokes key and returns 204', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() })).json() as { data: { key: { id: string } } }
    ).data.key.id;
    const delRes = await app.inject({ method: 'DELETE', url: `/api/v5/keys/${id}` });
    expect(delRes.statusCode).toBe(204);
    const getRes = await app.inject({ method: 'GET', url: `/api/v5/keys/${id}` });
    expect((getRes.json() as { data: { revoked: boolean } }).data.revoked).toBe(true);
  });

  it('returns 409 when revoking already-revoked key', async () => {
    const id = (
      (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() })).json() as { data: { key: { id: string } } }
    ).data.key.id;
    await app.inject({ method: 'DELETE', url: `/api/v5/keys/${id}` });
    const res = await app.inject({ method: 'DELETE', url: `/api/v5/keys/${id}` });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/keys/no-such' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Security — hash must never appear in responses
// ---------------------------------------------------------------------------

describe('Security: keyHash is never exposed', () => {
  it('GET list contains no keyHash', async () => {
    await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody() });
    const res = await app.inject({ method: 'GET', url: '/api/v5/keys' });
    const body = JSON.stringify(res.json());
    // Should not contain a 64-char hex string (sha256 hash)
    expect(body).not.toMatch(/[0-9a-f]{64}/);
  });

  it('each rawKey is unique across two creates', async () => {
    const r1 = (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody({ label: 'K1' }) })).json() as { data: { rawKey: string } };
    const r2 = (await app.inject({ method: 'POST', url: '/api/v5/keys', payload: makeBody({ label: 'K2' }) })).json() as { data: { rawKey: string } };
    expect(r1.data.rawKey).not.toBe(r2.data.rawKey);
  });
});
