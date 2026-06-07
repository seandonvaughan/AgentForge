import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCycleDecompositionRoutes, type DecompositionArtifact } from '../cycle-decomposition.js';

const CYCLE_ID = 'abc12345-0000-0000-0000-000000000001';

let app: FastifyInstance;
let projectRoot: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-decomposition-'));
  mkdirSync(join(projectRoot, '.agentforge', 'cycles', CYCLE_ID), { recursive: true });
  app = Fastify({ logger: false });
  await registerCycleDecompositionRoutes(app, { projectRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('GET /api/v5/cycles/:id/decomposition', () => {
  it('returns decomposition.json when present', async () => {
    const artifact: DecompositionArtifact = {
      epicId: 'epic-1',
      rationale: 'Split by dependency order.',
      children: [
        {
          id: 'child-1',
          title: 'Build route',
          description: 'Read the persisted decomposition artifact.',
          files: ['packages/server/src/lib/routes/cycle-decomposition.ts'],
          capabilityTags: ['fastify-route'],
          suggestedAssignee: 'fastify-v5-engineer',
          estimatedCostUsd: 3,
          estimatedComplexity: 'low',
          predecessors: [],
          wave: 0,
        },
      ],
      validationReport: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 1,
      },
    };
    writeFileSync(
      join(projectRoot, '.agentforge', 'cycles', CYCLE_ID, 'decomposition.json'),
      JSON.stringify(artifact),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/decomposition` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(artifact);
  });

  it('returns a 404 error body when decomposition.json is absent', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/decomposition` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'decomposition.json not found' });
  });
});
