/**
 * Tests for GET /api/v5/cycles/:id/spend-report
 *
 * Tests:
 *   01 — happy path: spend-report.json present → 200 with data envelope
 *   02 — response data matches fixture fields (schemaVersion, cycleId, etc.)
 *   03 — meta.cycleId matches request param
 *   04 — meta.timestamp is a valid ISO string
 *   05 — spend-report.json absent → 404
 *   06 — cycle dir missing → 404
 *   07 — invalid cycleId (special chars) → 400
 *   08 — path traversal cycleId → 400
 *   09 — perItem array is preserved
 *   10 — resumed cycle returns non-zero perItem actuals
 *   11 — corrupt spend-report.json → 500
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { cycleSpendReportRoutes, type SpendReport } from '../cycle-spend-report.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-spend-abc123';
const RESUMED_CYCLE_ID = 'cycle-resumed-spend-abc123';

const FIXTURE_REPORT: SpendReport = {
  schemaVersion: 1,
  cycleId: CYCLE_ID,
  budgetUsd: 30,
  totalUsd: 12.45,
  executionUsd: 10.0,
  overheadUsd: 2.45,
  utilization: 0.415,
  perItem: [
    {
      itemId: 'item-001',
      title: 'Add endpoint',
      plannedUsd: 5.0,
      actualUsd: 4.8,
      status: 'completed',
      estimatedComplexity: 'medium',
      estimateAccuracy: 0.96,
    },
    {
      itemId: 'item-002',
      title: 'Write tests',
      plannedUsd: null,
      actualUsd: 5.2,
      status: 'completed',
    },
  ],
  generatedAt: '2026-06-10T12:00:00.000Z',
};

const RESUMED_FIXTURE_REPORT: SpendReport = {
  schemaVersion: 1,
  cycleId: RESUMED_CYCLE_ID,
  epicId: 'epic-resumed-001',
  objective: 'Resume an interrupted epic and report actuals',
  budgetUsd: 40,
  totalUsd: 18.75,
  executionUsd: 16.25,
  overheadUsd: 2.5,
  utilization: 0.8667,
  perItem: [
    {
      itemId: 'item-resume-001',
      title: 'Complete resumed implementation',
      plannedUsd: null,
      actualUsd: 9.5,
      status: 'completed',
    },
    {
      itemId: 'item-resume-002',
      title: 'Validate resumed epic',
      plannedUsd: 6,
      actualUsd: 6.75,
      status: 'completed',
    },
  ],
  generatedAt: '2026-06-10T13:00:00.000Z',
};

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

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await cycleSpendReportRoutes(a, { projectRoot });
  await a.ready();
  return a;
}

function writeReport(report: SpendReport): void {
  writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify(report));
}

function writeReportForCycle(cycleId: string, report: SpendReport): void {
  const dir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spend-report.json'), JSON.stringify(report));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/spend-report', () => {
  it('01 — happy path: spend-report.json present → 200', async () => {
    writeReport(FIXTURE_REPORT);
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReport; meta: { cycleId: string; timestamp: string } }>();
    expect(body.data).toBeDefined();
    expect(body.meta).toBeDefined();
  });

  it('02 — response data matches fixture fields', async () => {
    writeReport(FIXTURE_REPORT);
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReport }>();
    const data = body.data;

    expect(data.schemaVersion).toBe(1);
    expect(data.cycleId).toBe(CYCLE_ID);
    expect(data.budgetUsd).toBe(30);
    expect(data.totalUsd).toBe(12.45);
    expect(data.executionUsd).toBe(10.0);
    expect(data.overheadUsd).toBe(2.45);
    expect(typeof data.utilization).toBe('number');
    expect(data.generatedAt).toBe('2026-06-10T12:00:00.000Z');
  });

  it('03 — meta.cycleId matches request param', async () => {
    writeReport(FIXTURE_REPORT);
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { cycleId: string } }>();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
  });

  it('04 — meta.timestamp is a valid ISO string', async () => {
    writeReport(FIXTURE_REPORT);
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { timestamp: string } }>();
    expect(typeof body.meta.timestamp).toBe('string');
    expect(() => new Date(body.meta.timestamp)).not.toThrow();
    expect(isNaN(new Date(body.meta.timestamp).getTime())).toBe(false);
  });

  it('05 — spend-report.json absent → 404', async () => {
    // cycleDir exists but no spend-report.json
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string; cycleId: string }>();
    expect(body.error).toContain('not found');
    expect(body.cycleId).toBe(CYCLE_ID);
  });

  it('06 — cycle dir missing → 404', async () => {
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/nonexistent-cycle-xyz/spend-report',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain('not found');
  });

  it('07 — invalid cycleId (special chars) → 400', async () => {
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad.id!/spend-report',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Invalid');
  });

  it('08 — path traversal cycleId → 400 or 404', async () => {
    app = await buildApp(tmpRoot);

    // Fastify URL-decodes params, so %2F becomes / — the SAFE_CYCLE_ID regex
    // will reject anything with a slash or dot-dot pattern.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/..%2F..%2Fetc%2Fpasswd/spend-report',
    });

    expect([400, 404]).toContain(res.statusCode);
  });

  it('09 — perItem array is preserved with correct length and shape', async () => {
    writeReport(FIXTURE_REPORT);
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReport }>();
    expect(Array.isArray(body.data.perItem)).toBe(true);
    expect(body.data.perItem).toHaveLength(2);

    const first = body.data.perItem[0]!;
    expect(first.itemId).toBe('item-001');
    expect(first.title).toBe('Add endpoint');
    expect(first.plannedUsd).toBe(5.0);
    expect(first.actualUsd).toBe(4.8);
    expect(first.status).toBe('completed');
    expect(first.estimatedComplexity).toBe('medium');
    expect(first.estimateAccuracy).toBe(0.96);

    const second = body.data.perItem[1]!;
    expect(second.plannedUsd).toBeNull();
    expect(second.actualUsd).toBe(5.2);
  });

  it('10 — resumed cycle preserves non-zero perItem actuals', async () => {
    writeReportForCycle(RESUMED_CYCLE_ID, RESUMED_FIXTURE_REPORT);
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${RESUMED_CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReport }>();
    expect(body.data.cycleId).toBe(RESUMED_CYCLE_ID);
    expect(body.data.executionUsd).toBe(16.25);
    expect(body.data.overheadUsd).toBe(2.5);
    expect(body.data.perItem.map((item) => item.actualUsd)).toEqual([9.5, 6.75]);
    expect(body.data.perItem.every((item) => item.actualUsd > 0)).toBe(true);
    expect(body.data.perItem[0]!.plannedUsd).toBeNull();
  });

  it('11 — corrupt spend-report.json → 500', async () => {
    writeFileSync(join(cycleDir, 'spend-report.json'), '{ invalid json }');
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toContain('parse');
  });
});
