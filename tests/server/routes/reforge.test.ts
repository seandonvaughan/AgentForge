/**
 * tests/server/routes/reforge.test.ts — Integration tests for GET /api/v1/reforge
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'executed';
const VALID_STATUSES: ProposalStatus[] = ['proposed', 'approved', 'rejected', 'executed'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/reforge', () => {
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
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: ReforgeProposal[], meta: { total } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('total');
  });

  it('data is always an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('meta.total matches data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.length);
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });

  it('each proposal has id field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop).toHaveProperty('id');
      expect(typeof prop.id).toBe('string');
    }
  });

  it('each proposal has filename field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop).toHaveProperty('filename');
      expect(typeof prop.filename).toBe('string');
    }
  });

  it('each proposal has title field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop).toHaveProperty('title');
      expect(typeof prop.title).toBe('string');
    }
  });

  it('each proposal has status field', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop).toHaveProperty('status');
    }
  });

  it('each proposal has createdAt field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop).toHaveProperty('createdAt');
      expect(typeof prop.createdAt).toBe('string');
    }
  });

  it('status field is one of "proposed", "approved", "rejected", "executed"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(VALID_STATUSES).toContain(prop.status);
    }
  });

  it('createdAt is a valid ISO timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      const d = new Date(prop.createdAt);
      expect(isNaN(d.getTime())).toBe(false);
    }
  });

  it('filename ends with .md', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop.filename).toMatch(/\.md$/);
    }
  });

  it('id does not contain .md extension', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      expect(prop.id).not.toMatch(/\.md$/);
    }
  });

  it('data is sorted by filename descending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    const filenames = body.data.map((p: { filename: string }) => p.filename);
    const sorted = [...filenames].sort((a: string, b: string) => b.localeCompare(a));
    expect(filenames).toEqual(sorted);
  });

  it('filename with "executed" in name results in status "executed"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reforge' });
    const body = res.json();
    for (const prop of body.data) {
      if (prop.filename.toLowerCase().includes('executed')) {
        expect(prop.status).toBe('executed');
      }
    }
  });

  it('POST to /api/v1/reforge returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/reforge', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
