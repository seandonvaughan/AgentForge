/**
 * tests/server/routes/autonomy.test.ts — Integration tests for GET /api/v1/autonomy
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import type { PromotionRow } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function makePromotion(overrides: Partial<PromotionRow> = {}): PromotionRow {
  _seq++;
  return {
    id: `promo-${_seq}`,
    agent_id: `agent-${_seq}`,
    previous_tier: 1,
    new_tier: 2,
    promoted: 1,
    demoted: 0,
    reason: 'High task success rate',
    created_at: new Date(1700000000000 + _seq * 1000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/autonomy', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    _seq = 0;
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
    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: PromotionRow[], meta: { total } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('total');
  });

  it('returns empty array when no promotion history', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('meta.total matches data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.length);
  });

  it('returns promotions after inserting records', async () => {
    adapter.insertPromotion(makePromotion({ id: 'p1' }));
    adapter.insertPromotion(makePromotion({ id: 'p2' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.meta.total).toBe(2);
  });

  it('data array contains objects with required fields', async () => {
    adapter.insertPromotion(makePromotion({ id: 'p-check' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    const entry = body.data[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('agent_id');
    expect(entry).toHaveProperty('previous_tier');
    expect(entry).toHaveProperty('new_tier');
    expect(entry).toHaveProperty('promoted');
    expect(entry).toHaveProperty('created_at');
  });

  it('id field is a string', async () => {
    adapter.insertPromotion(makePromotion({ id: 'string-id-test' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(typeof body.data[0].id).toBe('string');
  });

  it('agent_id field is a string', async () => {
    adapter.insertPromotion(makePromotion({ id: 'agent-id-test', agent_id: 'my-agent' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(typeof body.data[0].agent_id).toBe('string');
    expect(body.data[0].agent_id).toBe('my-agent');
  });

  it('previous_tier and new_tier are numbers', async () => {
    adapter.insertPromotion(makePromotion({ id: 'tier-test', previous_tier: 1, new_tier: 2 }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(typeof body.data[0].previous_tier).toBe('number');
    expect(typeof body.data[0].new_tier).toBe('number');
  });

  it('promoted field is a number (0 or 1)', async () => {
    adapter.insertPromotion(makePromotion({ id: 'promo-test', promoted: 1 }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect([0, 1]).toContain(body.data[0].promoted);
  });

  it('created_at field is a string', async () => {
    adapter.insertPromotion(makePromotion({ id: 'date-test' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(typeof body.data[0].created_at).toBe('string');
  });

  it('data is sorted by created_at descending', async () => {
    adapter.insertPromotion(makePromotion({
      id: 'older',
      created_at: '2024-01-01T00:00:00.000Z',
    }));
    adapter.insertPromotion(makePromotion({
      id: 'newer',
      created_at: '2024-06-01T00:00:00.000Z',
    }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(body.data[0].id).toBe('newer');
    expect(body.data[1].id).toBe('older');
  });

  it('POST to /api/v1/autonomy returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/autonomy', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/autonomy' });
    const body = res.json();
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });
});
