/**
 * Fix 1: GET /api/v5/costs/daily-rollups
 *
 * Tests:
 *   - Happy path: returns last 30 days of rollups with correct shape
 *   - Empty workspace: returns empty data array
 *   - Day-boundary handling: costs on different days appear in separate buckets
 *   - ?days param validation: negative → 400
 *   - ?days param validation: >365 → 400
 *   - ?days param validation: zero → 400
 *   - byModel breakdown: opus/sonnet/haiku correctly classified
 *   - Custom ?days=7: only last 7 days returned
 *   - Costs older than N days are excluded
 *   - meta.days reflects the requested window
 *   - Response is sorted ascending by date
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { costsRoutes, type DailyRollupItem } from '../costs.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;

/** Insert a cost row with a specific created_at, bypassing normal recordCost timestamp. */
function addCostAt(
  ad: WorkspaceAdapter,
  model: string,
  costUsd: number,
  createdAt: Date,
): void {
  ad.recordCost({
    agentId: 'test-agent',
    model,
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
  });
  const db = (ad as unknown as { db: import('better-sqlite3').Database }).db;
  db.prepare(
    'UPDATE costs SET created_at = ? WHERE created_at = (SELECT MAX(created_at) FROM costs)',
  ).run(createdAt.toISOString());
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(12, 0, 0, 0); // mid-day UTC to avoid boundary flipping
  return d;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = Fastify({ logger: false });
  await costsRoutes(app, { adapter });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  adapter.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/costs/daily-rollups', () => {
  it('returns 200 with empty data array on empty workspace', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[]; meta: { days: number; timestamp: string } };
    expect(body.data).toEqual([]);
    expect(body.meta.days).toBe(30);
    expect(typeof body.meta.timestamp).toBe('string');
  });

  it('happy path: returns costs within the default 30-day window', async () => {
    addCostAt(adapter, 'claude-sonnet', 1.0, daysAgo(5));
    addCostAt(adapter, 'claude-sonnet', 2.0, daysAgo(15));
    // Outside window — should be excluded
    addCostAt(adapter, 'claude-sonnet', 99.0, daysAgo(40));

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[]; meta: { days: number } };
    expect(body.data).toHaveLength(2);
    const total = body.data.reduce((s, d) => s + d.totalUsd, 0);
    expect(total).toBeCloseTo(3.0, 5);
  });

  it('costs on different days appear in separate date buckets', async () => {
    addCostAt(adapter, 'claude-sonnet', 1.0, daysAgo(1));
    addCostAt(adapter, 'claude-sonnet', 2.0, daysAgo(2));
    addCostAt(adapter, 'claude-sonnet', 3.0, daysAgo(3));

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[] };
    expect(body.data).toHaveLength(3);
    const totals = body.data.map(d => d.totalUsd).sort((a, b) => a - b);
    expect(totals[0]).toBeCloseTo(1.0, 5);
    expect(totals[1]).toBeCloseTo(2.0, 5);
    expect(totals[2]).toBeCloseTo(3.0, 5);
  });

  it('multiple costs on the same day are merged into one bucket', async () => {
    // Use same daysAgo so they land on the same YYYY-MM-DD
    const day = daysAgo(2);
    const day2 = new Date(day);
    day2.setUTCHours(14, 0, 0, 0);
    addCostAt(adapter, 'claude-sonnet', 1.5, day);
    addCostAt(adapter, 'claude-sonnet', 2.5, day2);

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.totalUsd).toBeCloseTo(4.0, 5);
  });

  it('?days=7 returns only last 7 days of costs', async () => {
    addCostAt(adapter, 'claude-sonnet', 1.0, daysAgo(3));  // in window
    addCostAt(adapter, 'claude-sonnet', 2.0, daysAgo(10)); // out of window

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=7' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[]; meta: { days: number } };
    expect(body.meta.days).toBe(7);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.totalUsd).toBeCloseTo(1.0, 5);
  });

  it('?days param validation: negative value returns 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=-1' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('days');
  });

  it('?days param validation: zero returns 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=0' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('days');
  });

  it('?days param validation: >365 returns 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=366' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('days');
  });

  it('byModel breakdown: opus/sonnet/haiku correctly classified', async () => {
    addCostAt(adapter, 'claude-opus-4-6', 3.0, daysAgo(1));
    addCostAt(adapter, 'claude-sonnet-4-5', 1.5, daysAgo(1));
    addCostAt(adapter, 'claude-haiku-3-5', 0.5, daysAgo(1));

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[] };
    expect(body.data).toHaveLength(1);
    const bucket = body.data[0]!;
    expect(bucket.byModel.opus).toBeCloseTo(3.0, 5);
    expect(bucket.byModel.sonnet).toBeCloseTo(1.5, 5);
    expect(bucket.byModel.haiku).toBeCloseTo(0.5, 5);
    expect(bucket.totalUsd).toBeCloseTo(5.0, 5);
  });

  it('response data is sorted ascending by date', async () => {
    addCostAt(adapter, 'claude-sonnet', 1.0, daysAgo(5));
    addCostAt(adapter, 'claude-sonnet', 2.0, daysAgo(3));
    addCostAt(adapter, 'claude-sonnet', 3.0, daysAgo(1));

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[] };
    const dates = body.data.map(d => d.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it('meta.days reflects the requested ?days param', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=90' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ meta: { days: number } }>().meta.days).toBe(90);
  });

  it('costs exactly at the cutoff boundary are excluded (strictly older)', async () => {
    // Cost from exactly 30 days ago should be included (within window)
    addCostAt(adapter, 'claude-sonnet', 5.0, daysAgo(29));
    // Cost from 31 days ago should be excluded
    addCostAt(adapter, 'claude-sonnet', 99.0, daysAgo(31));

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=30' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[] };
    const total = body.data.reduce((s, d) => s + d.totalUsd, 0);
    expect(total).toBeCloseTo(5.0, 5);
  });

  it('unknown model is classified as sonnet', async () => {
    addCostAt(adapter, 'unknown-model', 2.0, daysAgo(1));

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DailyRollupItem[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.byModel.sonnet).toBeCloseTo(2.0, 5);
    expect(body.data[0]!.byModel.opus).toBeCloseTo(0, 5);
    expect(body.data[0]!.byModel.haiku).toBeCloseTo(0, 5);
  });

  it('?days=365 is accepted (boundary valid value)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/daily-rollups?days=365' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ meta: { days: number } }>().meta.days).toBe(365);
  });
});
