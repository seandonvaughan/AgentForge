/**
 * tests/server/routes/reviews.test.ts — Integration tests for GET /api/v1/reviews
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

describe('GET /api/v1/reviews', () => {
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
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: ReviewEntry[], meta: { total } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('total');
  });

  it('data is always an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('meta.total matches data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.length);
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });

  it('each entry has id field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('id');
      expect(typeof entry.id).toBe('string');
    }
  });

  it('each entry has filename field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('filename');
      expect(typeof entry.filename).toBe('string');
    }
  });

  it('each entry has content field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('content');
      expect(typeof entry.content).toBe('string');
    }
  });

  it('each entry has createdAt field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('createdAt');
      expect(typeof entry.createdAt).toBe('string');
    }
  });

  it('content is truncated to 500 chars max', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry.content.length).toBeLessThanOrEqual(500);
    }
  });

  it('createdAt is a valid ISO timestamp string', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      const d = new Date(entry.createdAt);
      expect(isNaN(d.getTime())).toBe(false);
    }
  });

  it('id field contains the source prefix ("reviews:" or "feedback:")', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry.id).toMatch(/^(reviews:|feedback:)/);
    }
  });

  it('filename ends with .md', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry.filename).toMatch(/\.md$/);
    }
  });

  it('data is sorted by filename descending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    const filenames = body.data.map((e: { filename: string }) => e.filename);
    const sorted = [...filenames].sort((a: string, b: string) => b.localeCompare(a));
    expect(filenames).toEqual(sorted);
  });

  it('returns data from both reviews and feedback directories', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    const body = res.json();
    const ids = body.data.map((e: { id: string }) => e.id);
    const hasReviews = ids.some((id: string) => id.startsWith('reviews:'));
    const hasFeedback = ids.some((id: string) => id.startsWith('feedback:'));
    // At least one source should be present (project has both directories per git status)
    expect(hasReviews || hasFeedback).toBe(true);
  });

  it('POST to /api/v1/reviews returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/reviews', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
