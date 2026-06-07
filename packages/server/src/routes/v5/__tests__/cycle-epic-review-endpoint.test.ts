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
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-epic-review-'));
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

describe('GET /api/v5/cycles/:id/epic-review', () => {
  it('returns 404 JSON when phases/epic-review.json is absent', async () => {
    makeCycleDir();

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/epic-review` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'epic-review.json not found' });
  });

  it('returns the epic review view when phases/epic-review.json is present', async () => {
    const dir = makeCycleDir();
    mkdirSync(join(dir, 'phases'), { recursive: true });
    writeFileSync(
      join(dir, 'phases', 'epic-review.json'),
      JSON.stringify({
        cycleId: CYCLE_ID,
        mode: 'epic-review',
        schemaValidationOk: true,
        triageUsed: false,
        verdict: 'REQUEST_CHANGES',
        rationale: 'child-2 missed the consumer contract.',
        faultedItems: [
          {
            itemId: 'child-2',
            reason: 'Endpoint response does not include the verdict card fields.',
            files: ['packages/server/src/routes/v5/cycles.ts'],
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/epic-review` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        verdict: 'REQUEST_CHANGES',
        rationale: 'child-2 missed the consumer contract.',
        faultedItems: [
          {
            itemId: 'child-2',
            reason: 'Endpoint response does not include the verdict card fields.',
            files: ['packages/server/src/routes/v5/cycles.ts'],
          },
        ],
      },
      meta: {
        timestamp: expect.any(String),
        workspaceId: 'default',
      },
    });
  });
});
