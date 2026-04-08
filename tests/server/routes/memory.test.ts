/**
 * tests/server/routes/memory.test.ts — Integration tests for GET /api/v1/memory
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/memory', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 status code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: MemoryEntry[], meta: { total } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('total');
  });

  it('data is always an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('meta.total matches data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.length);
  });

  it('returns empty array gracefully when kv_store has no data and no session files', async () => {
    // In-memory DB has no kv_store entries
    // The fallback reads from .agentforge/sessions/ which may have files in the project
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    // total must match data length even if from file fallback
    expect(body.meta.total).toBe(body.data.length);
  });

  it('entries from kv_store have key and value fields', async () => {
    // Write a kv entry via the adapter
    adapter.writeFile('test-key-1', 'test-value-1');

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    const entry = body.data.find((e: { key: string }) => e.key === 'test-key-1');
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('key');
    expect(entry).toHaveProperty('value');
  });

  it('key field is a string', async () => {
    adapter.writeFile('key-type-test', 'value');

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    for (const entry of body.data) {
      expect(typeof entry.key).toBe('string');
    }
  });

  it('value field is a string', async () => {
    adapter.writeFile('value-type-test', 'some-value');

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    for (const entry of body.data) {
      expect(typeof entry.value).toBe('string');
    }
  });

  it('value is truncated to 500 chars max', async () => {
    const longValue = 'x'.repeat(1000);
    adapter.writeFile('long-value-test', longValue);

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    const entry = body.data.find((e: { key: string }) => e.key === 'long-value-test');
    expect(entry).toBeDefined();
    expect(entry.value.length).toBeLessThanOrEqual(500);
  });

  it('multiple kv entries are all returned', async () => {
    adapter.writeFile('mem-key-a', 'value-a');
    adapter.writeFile('mem-key-b', 'value-b');
    adapter.writeFile('mem-key-c', 'value-c');

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    const keys = body.data.map((e: { key: string }) => e.key);
    expect(keys).toContain('mem-key-a');
    expect(keys).toContain('mem-key-b');
    expect(keys).toContain('mem-key-c');
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });

  it('overwriting a kv entry updates the value', async () => {
    adapter.writeFile('update-test', 'original');
    adapter.writeFile('update-test', 'updated');

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    const body = res.json();
    const entries = body.data.filter((e: { key: string }) => e.key === 'update-test');
    // Should have exactly one entry (upsert behavior)
    expect(entries.length).toBe(1);
    expect(entries[0].value).toBe('updated');
  });

  it('POST to /api/v1/memory returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/memory', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/memory
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
  });

  it('returns { data, agents, meta }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
  });

  it('every entry has a stable id field', async () => {
    adapter.writeFile('id-test-key', 'value');
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    for (const entry of body.data) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
    }
  });

  it('id equals key for kv_store entries', async () => {
    adapter.writeFile('my-special-key', 'hello');
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const entry = body.data.find((e: { key: string }) => e.key === 'my-special-key');
    expect(entry).toBeDefined();
    expect(entry.id).toBe('my-special-key');
  });

  it('meta.total matches data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.length);
  });

  it('search param filters by key', async () => {
    adapter.writeFile('needle-key', 'some value');
    adapter.writeFile('haystack-key', 'other value');

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=needle' });
    const body = res.json();
    const keys = body.data.map((e: { key: string }) => e.key);
    expect(keys).toContain('needle-key');
    expect(keys).not.toContain('haystack-key');
  });

  it('search param filters by value', async () => {
    adapter.writeFile('alpha-key', 'find-me-value');
    adapter.writeFile('beta-key', 'ignore-me-value');

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=find-me' });
    const body = res.json();
    const keys = body.data.map((e: { key: string }) => e.key);
    expect(keys).toContain('alpha-key');
    expect(keys).not.toContain('beta-key');
  });

  it('search with no matches returns empty data array', async () => {
    adapter.writeFile('some-key', 'some-value');
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=zzz-no-match' });
    const body = res.json();
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v5/memory/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v5/memory/:id', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 and removes a kv_store entry', async () => {
    adapter.writeFile('delete-me', 'value');

    const del = await app.inject({ method: 'DELETE', url: '/api/v5/memory/delete-me' });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, key: 'delete-me' });

    const get = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const keys = get.json().data.map((e: { key: string }) => e.key);
    expect(keys).not.toContain('delete-me');
  });

  it('returns 404 when key does not exist', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/memory/no-such-key' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error');
  });

  it('handles URL-encoded keys', async () => {
    adapter.writeFile('key/with/slashes', 'value');

    const encoded = encodeURIComponent('key/with/slashes');
    const del = await app.inject({ method: 'DELETE', url: `/api/v5/memory/${encoded}` });
    expect(del.statusCode).toBe(200);
  });
});
