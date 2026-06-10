/**
 * epic-artifact-routes-registration.test.ts
 *
 * Guards against the child-4 gate failure: the three epic-artifact route
 * modules (cycleDecompositionRoutes, cycleEpicReviewRoutes,
 * cycleSpendReportRoutes) must be registered in the no-adapter server boot
 * path so the endpoints are reachable at runtime.
 *
 * Tests:
 *  - 404 (no fixture file) — endpoint is registered, returns 404 when data absent
 *  - 200 (fixture file created) — endpoint is registered and serves data
 *  - 400 — invalid cycleId is rejected
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerV5 } from '../server.js';

let createdApps: Array<{ close: () => Promise<void> }> = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  for (const app of createdApps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  createdApps = [];
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-epic-routes-'));
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// GET /api/v5/cycles/:id/decomposition
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/decomposition', () => {
  it('is registered — returns 404 when decomposition.json is absent', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/abc123/decomposition',
    });
    // 404 means the route is registered; the cycle artifact is just absent.
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with data envelope when decomposition.json exists', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'test-cycle-decomp';
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    const fixture = { objective: 'Ship epic feature', children: ['child-1', 'child-2'] };
    writeFileSync(join(cycleDir, 'decomposition.json'), JSON.stringify(fixture));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${cycleId}/decomposition`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: typeof fixture; meta: { cycleId: string } };
    expect(body.data).toEqual(fixture);
    expect(body.meta.cycleId).toBe(cycleId);
  });

  it('returns 400 for invalid cycleId (path traversal attempt)', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/..%2F..%2Fetc/decomposition',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/cycles/:id/epic-review
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/epic-review', () => {
  it('is registered — returns 404 when epic-review.json is absent', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'cycle-no-epic';
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${cycleId}/epic-review`,
    });
    // Cycle directory exists but phases/epic-review.json is absent → 404.
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with data envelope when epic-review.json exists', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'test-cycle-epic';
    const phasesDir = join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases');
    mkdirSync(phasesDir, { recursive: true });
    const fixture = { verdict: 'approved', score: 92, summary: 'All items merged' };
    writeFileSync(join(phasesDir, 'epic-review.json'), JSON.stringify(fixture));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${cycleId}/epic-review`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: typeof fixture; meta: { cycleId: string } };
    expect(body.data).toEqual(fixture);
    expect(body.meta.cycleId).toBe(cycleId);
  });

  it('returns 400 for invalid cycleId', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad!id/epic-review',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/cycles/:id/spend-report
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/spend-report', () => {
  it('is registered — returns 404 when spend-report.json is absent', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/abc123/spend-report',
    });
    // 404 means the route is registered; no spend-report.json on disk.
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with data envelope when spend-report.json exists', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'test-cycle-spend';
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    const fixture = {
      schemaVersion: 1 as const,
      cycleId,
      budgetUsd: 10,
      totalUsd: 7.5,
      executionUsd: 6,
      overheadUsd: 1.5,
      utilization: 0.75,
      perItem: [],
      generatedAt: '2026-06-10T00:00:00.000Z',
    };
    writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify(fixture));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${cycleId}/spend-report`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: typeof fixture; meta: { cycleId: string } };
    expect(body.data.budgetUsd).toBe(10);
    expect(body.data.totalUsd).toBe(7.5);
    expect(body.meta.cycleId).toBe(cycleId);
  });

  it('returns 400 for invalid cycleId', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad!id/spend-report',
    });
    expect(res.statusCode).toBe(400);
  });
});
