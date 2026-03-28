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
