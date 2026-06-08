/**
 * Tests for GET /api/v5/cycles/:id/spend-report
 *
 * Tests:
 *   01 — happy path: spend-report.json present → 200 with data
 *   02 — cycle dir missing → 404 "Cycle not found"
 *   03 — spend-report.json absent (cycle dir exists) → 404 "Spend report not found"
 *   04 — invalid cycleId (unsafe chars) → 400
 *   05 — response meta.cycleId matches request param
 *   06 — response data matches the written artifact (perItem + totals)
 *   07 — corrupt spend-report.json → 500
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SpendReportArtifact } from '@agentforge/shared';

import { cycleSpendReportRoutes } from '../cycle-spend-report-route.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-spend-test-abc';

const SPEND_REPORT: SpendReportArtifact = {
  perItem: [
    { id: 'w1-a', plannedUsd: 2.5, actualUsd: 2.1 },
    { id: 'w2-b', plannedUsd: 1.0, actualUsd: 1.3 },
  ],
  totals: {
    executionUsd: 3.4,
    overheadUsd: 0.6,
    utilizationPct: 80,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await cycleSpendReportRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let cycleDir: string;
let app: FastifyInstance;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-spend-report-'));
  cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
  mkdirSync(cycleDir, { recursive: true });
});

afterEach(async () => {
  if (app) await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/spend-report', () => {
  it('01 — happy path: spend-report.json present → 200', async () => {
    writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify(SPEND_REPORT));
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReportArtifact; meta: { cycleId: string; timestamp: string } }>();
    expect(body.data).toBeDefined();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
    expect(typeof body.meta.timestamp).toBe('string');
  });

  it('02 — cycle dir missing → 404 with "Cycle not found"', async () => {
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/nonexistent-cycle/spend-report',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string; cycleId: string }>();
    expect(body.error).toContain('not found');
    expect(body.cycleId).toBe('nonexistent-cycle');
  });

  it('03 — spend-report.json absent (cycle dir exists) → 404 with "Spend report not found"', async () => {
    // cycleDir exists but no spend-report.json inside
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string; cycleId: string }>();
    expect(body.error).toContain('Spend report not found');
    expect(body.cycleId).toBe(CYCLE_ID);
  });

  it('04 — invalid cycleId (unsafe chars) → 400', async () => {
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad.id!/spend-report',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Invalid');
  });

  it('05 — response meta.cycleId matches request param', async () => {
    writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify(SPEND_REPORT));
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { cycleId: string } }>();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
  });

  it('06 — response data matches the written artifact (perItem + totals)', async () => {
    writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify(SPEND_REPORT));
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReportArtifact }>();
    expect(body.data.perItem).toHaveLength(2);
    expect(body.data.perItem[0]).toEqual({ id: 'w1-a', plannedUsd: 2.5, actualUsd: 2.1 });
    expect(body.data.perItem[1]).toEqual({ id: 'w2-b', plannedUsd: 1.0, actualUsd: 1.3 });
    expect(body.data.totals.executionUsd).toBe(3.4);
    expect(body.data.totals.overheadUsd).toBe(0.6);
    expect(body.data.totals.utilizationPct).toBe(80);
  });

  it('07 — corrupt spend-report.json → 500', async () => {
    writeFileSync(join(cycleDir, 'spend-report.json'), '{ invalid json !!!');
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toContain('Failed to parse');
  });
});
