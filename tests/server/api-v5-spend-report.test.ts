import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSpendReportRoutes, type SpendReport } from '@agentforge/core';

const CYCLE_ID = 'resume-cost-cycle';

let app: FastifyInstance | null = null;
let tmpRoot: string | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (tmpRoot !== null) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  await registerSpendReportRoutes(fastify, { projectRoot });
  await fastify.ready();
  return fastify;
}

describe('GET /api/v5/cycles/:id/spend-report', () => {
  it('returns restored per-item resume costs and restored total', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-api-spend-report-'));
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
    const phasesDir = join(cycleDir, 'phases');
    mkdirSync(phasesDir, { recursive: true });

    writeJson(join(cycleDir, 'plan.json'), {
      items: [
        {
          id: 'child-1',
          title: 'Restore prior item',
          estimatedCostUsd: 2,
          estimatedComplexity: 'medium',
        },
        {
          id: 'child-2',
          title: 'Run remaining item',
          estimatedCostUsd: 1.5,
          estimatedComplexity: 'low',
        },
      ],
    });
    writeJson(join(cycleDir, 'completed.json'), {
      cost: {
        budgetUsd: 10,
      },
    });
    writeJson(join(phasesDir, 'execute.json'), {
      phase: 'execute',
      costUsd: 1.25,
      itemResults: [
        {
          itemId: 'child-1',
          status: 'skipped',
          costUsd: 0,
        },
        {
          itemId: 'child-2',
          status: 'completed',
          costUsd: 1.25,
        },
      ],
    });
    writeJson(join(phasesDir, 'audit.json'), {
      phase: 'audit',
      costUsd: 0.5,
    });
    writeJson(join(cycleDir, 'checkpoint-execute.json'), {
      schemaVersion: 3,
      cycleId: CYCLE_ID,
      phase: 'execute',
      completedItemIds: ['child-1'],
      currentItemId: null,
      totalItems: 2,
      lastUpdatedAt: '2026-06-11T12:00:00.000Z',
      items: {
        'child-1': {
          itemId: 'child-1',
          status: 'completed',
          costUsd: 2.75,
          agentId: 'coder',
          completedAt: '2026-06-11T12:00:00.000Z',
        },
      },
    });

    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: SpendReport }>();
    expect(body.data.budgetUsd).toBe(10);
    expect(body.data.executionUsd).toBe(4);
    expect(body.data.overheadUsd).toBe(0.5);
    expect(body.data.totalUsd).toBe(4.5);
    expect(body.data.utilization).toBe(0.45);

    const byItem = new Map(body.data.perItem.map((item) => [item.itemId, item]));
    expect(byItem.get('child-1')).toMatchObject({
      itemId: 'child-1',
      title: 'Restore prior item',
      actualUsd: 2.75,
      status: 'completed',
      estimateAccuracy: 1.38,
    });
    expect(byItem.get('child-2')).toMatchObject({
      itemId: 'child-2',
      actualUsd: 1.25,
      status: 'completed',
    });
  });
});
