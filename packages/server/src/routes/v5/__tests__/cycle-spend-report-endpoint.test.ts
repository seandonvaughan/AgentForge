import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: () => null,
  list: () => [],
  reap: () => ({ reaped: 0, stillRunning: 0 }),
  startReaper: () => ({ stop: () => {} }),
  register: () => {},
  markTerminal: () => {},
  stop: async () => ({ ok: true, status: 'killed', message: 'mocked' }),
  isPidAlive: () => false,
}));

import { cyclesRoutes } from '../cycles.js';

const CYCLE_ID = '11111111-2222-3333-4444-555555555555';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-spend-report-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCycleDir(id = CYCLE_ID): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('GET /api/v5/cycles/:id/spend-report', () => {
  it('returns 404 JSON when spend-report.json is absent', async () => {
    makeCycleDir();

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/spend-report` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'spend-report.json not found' });
  });

  it('returns spend-report.json with per-item planned-vs-actual fields when present', async () => {
    const dir = makeCycleDir();
    writeFileSync(
      join(dir, 'spend-report.json'),
      JSON.stringify({
        schemaVersion: 1,
        cycleId: CYCLE_ID,
        budgetUsd: 20,
        totalUsd: 3.75,
        executionUsd: 2.5,
        overheadUsd: 1.25,
        utilization: 0.1875,
        perItem: [
          {
            itemId: 'child-4',
            title: 'Record planned-vs-actual spend',
            plannedUsd: 7,
            actualUsd: 2.5,
            status: 'completed',
          },
        ],
        generatedAt: '2026-06-06T12:00:00.000Z',
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/spend-report` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        schemaVersion: 1,
        cycleId: CYCLE_ID,
        budgetUsd: 20,
        totalUsd: 3.75,
        executionUsd: 2.5,
        overheadUsd: 1.25,
        utilization: 0.1875,
        perItem: [
          {
            itemId: 'child-4',
            title: 'Record planned-vs-actual spend',
            plannedUsd: 7,
            actualUsd: 2.5,
            status: 'completed',
          },
        ],
        generatedAt: '2026-06-06T12:00:00.000Z',
      },
      meta: {
        timestamp: expect.any(String),
        workspaceId: 'default',
      },
    });
  });
});
