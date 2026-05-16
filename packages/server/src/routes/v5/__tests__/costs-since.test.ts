/**
 * Fix 5: GET /api/v5/costs/summary?since=<ISO_date>
 *
 * Tests the matrix:
 *   - no ?since → returns all-time data
 *   - since=1d ago → filters to last 24h
 *   - since=7d ago → filters to last 7 days
 *   - since=30d ago → filters to last 30 days
 *   - since=future → returns empty result (no costs after future date)
 *   - invalid since → 400 with error message
 *   - since reflected in meta.since field
 *   - totalCostUsd sum matches filtered subset
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { costsRoutes } from '../costs.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;

/** Create a cost row with a specific created_at timestamp. */
function addCost(
  ad: WorkspaceAdapter,
  model: string,
  costUsd: number,
  createdAt: Date,
): void {
  // We insert directly via the underlying method; override created_at via the
  // timestamp pattern used by WorkspaceAdapter.
  ad.recordCost({
    agentId: 'test-agent',
    model,
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
  });
  // Patch the created_at of the last inserted row to our desired timestamp.
  const db = (ad as unknown as { db: import('better-sqlite3').Database }).db;
  db.prepare('UPDATE costs SET created_at = ? WHERE created_at = (SELECT MAX(created_at) FROM costs)').run(
    createdAt.toISOString(),
  );
}

beforeEach(async () => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = Fastify({ logger: false });
  await costsRoutes(app, { adapter });

  const now = new Date();
  const ago1d = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const ago3d = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const ago10d = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const ago45d = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

  // Insert 4 costs spread across time:
  //   $1.00 — 1 day ago (within 1d, 7d, 30d windows)
  //   $2.00 — 3 days ago (within 7d, 30d windows but NOT 1d)
  //   $4.00 — 10 days ago (within 30d window but NOT 1d or 7d)
  //   $8.00 — 45 days ago (NOT within any window, all-time only)
  addCost(adapter, 'sonnet', 1.0, ago1d);
  addCost(adapter, 'sonnet', 2.0, ago3d);
  addCost(adapter, 'opus', 4.0, ago10d);
  addCost(adapter, 'haiku', 8.0, ago45d);
});

afterEach(async () => {
  await app.close();
});

function since(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 - 1000); // 1s buffer
  return d.toISOString();
}

describe('GET /api/v5/costs/summary — Fix 5: ?since filter', () => {
  it('no ?since returns all-time total ($15.00)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalSessions).toBe(4);
    expect(data.totalCostUsd).toBeCloseTo(15.0, 5);
  });

  it('?since=1d returns only costs from last ~24h ($1.00)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${since(1)}`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalSessions).toBe(1);
    expect(data.totalCostUsd).toBeCloseTo(1.0, 5);
  });

  it('?since=7d returns costs from last ~7 days ($1+$2=$3.00)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${since(7)}`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalSessions).toBe(2);
    expect(data.totalCostUsd).toBeCloseTo(3.0, 5);
  });

  it('?since=30d returns costs from last ~30 days ($1+$2+$4=$7.00)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${since(30)}`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalSessions).toBe(3);
    expect(data.totalCostUsd).toBeCloseTo(7.0, 5);
  });

  it('?since=future timestamp returns empty result', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${future}`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalSessions).toBe(0);
    expect(data.totalCostUsd).toBe(0);
  });

  it('?since is reflected in meta.since in the response', async () => {
    const sinceVal = since(7);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${sinceVal}`,
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json().meta;
    // meta.since should be a parseable ISO date close to sinceVal
    expect(typeof meta.since).toBe('string');
    expect(new Date(meta.since as string).getTime()).toBeGreaterThan(0);
  });

  it('no ?since results in meta.since being null', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.since).toBeNull();
  });

  it('invalid ?since returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/costs/summary?since=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('since');
  });

  it('byModel breakdown is filtered by since', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${since(1)}`,
    });
    expect(res.statusCode).toBe(200);
    const { byModel } = res.json().data as { byModel: Array<{ model: string; costUsd: number }> };
    // Only 'sonnet' cost from 1d ago should be present
    expect(byModel).toHaveLength(1);
    expect(byModel[0]!.model).toBe('sonnet');
    expect(byModel[0]!.costUsd).toBeCloseTo(1.0, 5);
  });
});
