/**
 * Tests for GET /api/v5/cycles/:id/decomposition
 *
 * Tests:
 *   01 — 200 with parsed waves when decomposition.json is present
 *   02 — 404 JSON body when decomposition.json is absent (cycle dir exists)
 *   03 — 404 JSON body when cycle directory does not exist at all
 *   04 — 400 for invalid cycleId containing unsafe characters
 *   05 — response meta.cycleId matches the request param
 *   06 — response data preserves all wave fields (waveIndex, children)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cycleDecompositionRoutes } from '../cycle-decomposition-route.js';
import type { DecompositionArtifact } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'test-cycle-abc123';

const SAMPLE_WAVES: DecompositionArtifact[] = [
  {
    waveIndex: 0,
    children: [
      {
        id: 'w0-a',
        title: 'Bootstrap schema',
        files: ['db/schema.sql'],
        estimatedCostUsd: 2.5,
        status: 'pending',
      },
    ],
  },
  {
    waveIndex: 1,
    children: [
      {
        id: 'w1-a',
        title: 'Add route handler',
        files: ['packages/server/src/routes/v5/foo.ts'],
        estimatedCostUsd: 1.0,
        status: 'completed',
      },
      {
        id: 'w1-b',
        title: 'Write unit tests',
        files: ['tests/server/foo.test.ts'],
        estimatedCostUsd: 0.5,
        status: 'in-progress',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-decomp-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cycleDecompositionRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/decomposition', () => {
  it('01 — 200 with parsed waves when decomposition.json is present', async () => {
    const dir = makeCycleDir(CYCLE_ID);
    writeFileSync(join(dir, 'decomposition.json'), JSON.stringify(SAMPLE_WAVES));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: DecompositionArtifact[];
      meta: { cycleId: string; timestamp: string };
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.waveIndex).toBe(0);
    expect(body.data[1]?.waveIndex).toBe(1);
    expect(typeof body.meta.timestamp).toBe('string');
  });

  it('02 — 404 JSON body when decomposition.json is absent (cycle dir exists)', async () => {
    makeCycleDir(CYCLE_ID); // create the cycle dir but NOT decomposition.json

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; cycleId: string };
    expect(body.error).toBe('Decomposition not found');
    expect(body.cycleId).toBe(CYCLE_ID);
  });

  it('03 — 404 JSON body when cycle directory does not exist at all', async () => {
    // No makeCycleDir call — cycle does not exist.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/nonexistent-cycle/decomposition',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; cycleId: string };
    expect(body.error).toBe('Decomposition not found');
    expect(body.cycleId).toBe('nonexistent-cycle');
  });

  it('04 — 400 for invalid cycleId containing unsafe characters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad.id.with.dots/decomposition',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toContain('Invalid cycleId');
  });

  it('05 — response meta.cycleId matches the request param', async () => {
    const dir = makeCycleDir(CYCLE_ID);
    writeFileSync(join(dir, 'decomposition.json'), JSON.stringify(SAMPLE_WAVES));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { meta: { cycleId: string } };
    expect(body.meta.cycleId).toBe(CYCLE_ID);
  });

  it('06 — response data preserves all wave children fields', async () => {
    const dir = makeCycleDir(CYCLE_ID);
    writeFileSync(join(dir, 'decomposition.json'), JSON.stringify(SAMPLE_WAVES));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: DecompositionArtifact[] };
    const wave0 = body.data[0];
    expect(wave0).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const child = wave0!.children[0];
    expect(child).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(child!.id).toBe('w0-a');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(child!.title).toBe('Bootstrap schema');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(child!.estimatedCostUsd).toBe(2.5);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(child!.status).toBe('pending');
  });
});
