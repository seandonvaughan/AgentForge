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
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-decomposition-'));
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

function writeDecomposition(dir: string): void {
  writeFileSync(
    join(dir, 'decomposition.json'),
    JSON.stringify({
      epicId: 'epic-11111111',
      rationale: 'Split the API work into independent children.',
      children: [
        {
          id: 'child-1',
          title: 'Add endpoint',
          description: 'Expose decomposition view.',
          files: ['packages/server/src/routes/v5/cycles.ts'],
          capabilityTags: ['fastify-route'],
          suggestedAssignee: 'fastify-v5-engineer',
          estimatedCostUsd: 2,
          estimatedComplexity: 'low',
          predecessors: [],
          wave: 0,
        },
        {
          id: 'child-2',
          title: 'Wire UI',
          description: 'Fetch the endpoint from the Epic tab.',
          files: ['packages/dashboard/src/routes/cycles/[id]/+page.svelte'],
          capabilityTags: ['dashboard'],
          suggestedAssignee: 'dashboard-engineer',
          estimatedCostUsd: 3,
          estimatedComplexity: 'medium',
          predecessors: ['child-1'],
          wave: 1,
        },
      ],
      validationReport: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 2,
      },
    }),
  );
}

describe('GET /api/v5/cycles/:id/decomposition', () => {
  it('returns 404 JSON when decomposition.json is absent', async () => {
    makeCycleDir();

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/decomposition` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'decomposition.json not found' });
  });

  it('returns the decomposition view when decomposition.json is present', async () => {
    const dir = makeCycleDir();
    writeDecomposition(dir);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/decomposition` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.workspaceId).toBe('default');
    expect(body.meta.timestamp).toEqual(expect.any(String));
    expect(body.data).toMatchObject({
      cycleId: CYCLE_ID,
      epicId: 'epic-11111111',
      summary: {
        childCount: 2,
        waveCount: 2,
        estimatedCostUsd: 5,
        actualCostUsd: 0,
      },
    });
    expect(body.data.children.map((child: { id: string }) => child.id)).toEqual(['child-1', 'child-2']);
    expect(body.data.decomposition.children[0].title).toBe('Add endpoint');
  });

  it('projects live child costs from phases/execute.json', async () => {
    const dir = makeCycleDir();
    writeDecomposition(dir);
    mkdirSync(join(dir, 'phases'), { recursive: true });
    writeFileSync(
      join(dir, 'phases', 'execute.json'),
      JSON.stringify({
        itemResults: [
          { itemId: 'child-1', status: 'completed', costUsd: 1.25 },
          { itemId: 'child-2', status: 'in_progress', costUsd: 0.5 },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/decomposition` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.summary.actualCostUsd).toBe(1.75);
    expect(body.data.summary.completedCount).toBe(1);
    expect(body.data.summary.inProgressCount).toBe(1);
    expect(body.data.children).toMatchObject([
      { id: 'child-1', status: 'completed', costUsd: 1.25 },
      { id: 'child-2', status: 'in_progress', costUsd: 0.5 },
    ]);
    expect(body.data.decomposition.children).toMatchObject(body.data.children);
  });
});
