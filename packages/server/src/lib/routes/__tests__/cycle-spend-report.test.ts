import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cycleSpendReportRoutes, type SpendReport } from '../cycle-spend-report.js';

const CYCLE_ID = 'cycle-spend-1';

function makeReport(): SpendReport {
  return {
    schemaVersion: 1,
    cycleId: CYCLE_ID,
    epicId: 'epic-1',
    objective: 'Ship spend tab endpoint',
    budgetUsd: 10,
    totalUsd: 3.5,
    executionUsd: 2.5,
    overheadUsd: 1,
    utilization: 0.35,
    perItem: [
      {
        itemId: 'C12',
        title: 'Dashboard Spend tab',
        plannedUsd: 4,
        actualUsd: 3.5,
        status: 'completed',
      },
    ],
    generatedAt: '2026-06-06T12:00:00.000Z',
  };
}

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await cycleSpendReportRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

describe('GET /api/v5/cycles/:id/spend-report', () => {
  let tmpRoot: string;
  let cycleDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-spend-report-'));
    cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
    mkdirSync(cycleDir, { recursive: true });
  });

  afterEach(async () => {
    if (app) await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the spend report when spend-report.json exists', async () => {
    const report = makeReport();
    writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify(report));

    app = await buildApp(tmpRoot);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      data: report,
      meta: {
        cycleId: CYCLE_ID,
        timestamp: expect.any(String),
      },
    });
  });

  it('returns 404 JSON when spend-report.json is absent', async () => {
    app = await buildApp(tmpRoot);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      data: null,
      error: 'Spend report not found',
      meta: {
        cycleId: CYCLE_ID,
        timestamp: expect.any(String),
      },
    });
  });
});
