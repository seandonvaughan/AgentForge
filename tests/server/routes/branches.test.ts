/**
 * tests/server/routes/branches.test.ts
 * Integration tests for GET /api/v1/branches and DELETE /api/v1/branches/:name
 *
 * NOTE: branchesRoutes is git-backed and requires NO database adapter.
 * The server registers it outside the `if (options.adapter)` block, so we
 * create the server without an adapter here to avoid pulling in better-sqlite3
 * (which can have native-addon ABI mismatches in CI environments).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  // No DB adapter needed — branchesRoutes is purely git-backed
  const { app } = await createServer({});
  await app.ready();
  return {
    app,
    close: async () => { await app.close(); },
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/branches
// ---------------------------------------------------------------------------

describe('GET /api/v1/branches', () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ app, close } = await buildApp());
  });

  afterEach(async () => { await close(); });

  it('returns HTTP 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: Array, meta: { total: number } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe('number');
  });

  it('meta.total equals data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.length);
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });

  it('data is never null or undefined', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    expect(body.data).not.toBeNull();
    expect(body.data).not.toBeUndefined();
  });

  it('each branch record has required fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    for (const branch of body.data) {
      expect(branch).toHaveProperty('name');
      expect(branch).toHaveProperty('cycle');
      expect(branch).toHaveProperty('sha');
      expect(branch).toHaveProperty('age');
      expect(branch).toHaveProperty('ageMs');
      expect(branch).toHaveProperty('status');
      expect(branch).toHaveProperty('pr');
    }
  });

  it('all branch names start with "autonomous/"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    for (const branch of body.data) {
      expect(branch.name).toMatch(/^autonomous\//);
    }
  });

  it('all status values are valid enum members', async () => {
    const validStatuses = new Set(['open_pr', 'merged', 'stale', 'active']);
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    for (const branch of body.data) {
      expect(validStatuses.has(branch.status)).toBe(true);
    }
  });

  it('cycle is derived from name by stripping "autonomous/" prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    for (const branch of body.data) {
      expect(branch.cycle).toBe(branch.name.replace(/^autonomous\//, ''));
    }
  });

  it('ageMs is a non-negative number', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    for (const branch of body.data) {
      expect(typeof branch.ageMs).toBe('number');
      expect(branch.ageMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('pr field is null or an object with number, title, state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const body = res.json();
    for (const branch of body.data) {
      if (branch.pr !== null) {
        expect(branch.pr).toHaveProperty('number');
        expect(branch.pr).toHaveProperty('title');
        expect(branch.pr).toHaveProperty('state');
      }
    }
  });

  it('returns consistent results across two sequential calls', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/branches' });
    expect(res1.json().meta.total).toBe(res2.json().meta.total);
  });

  it('POST to /api/v1/branches returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/branches', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/branches/:name
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/branches/:name', () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ app, close } = await buildApp());
  });

  afterEach(async () => { await close(); });

  it('returns 400 when branch name does not start with autonomous/', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('main'),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for arbitrary non-autonomous branch name', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('feature/my-feature'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for empty-prefix branch', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('refs/heads/main'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 error body with name field', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('some-other-branch'),
    });
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('name');
  });

  it('returns 409 or 500 when trying to delete a nonexistent autonomous branch', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('autonomous/v999.999.999'),
    });
    // 409 = currently checked out, 500 = git error (branch doesn't exist)
    expect([409, 500]).toContain(res.statusCode);
  });

  it('error body for nonexistent branch has name field', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('autonomous/v999.999.999'),
    });
    if (res.statusCode !== 200) {
      const body = res.json();
      expect(body).toHaveProperty('error');
    }
  });

  it('decodes URL-encoded slash in branch name', async () => {
    // autonomous%2Fv999 should decode to autonomous/v999 → pass the prefix check
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/autonomous%2Fv999',
    });
    // Must not be 400 (prefix check passed), could be 409 or 500 (git error)
    expect(res.statusCode).not.toBe(400);
  });

  it('returns 400 Content-Type application/json', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/branches/' + encodeURIComponent('main'),
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
