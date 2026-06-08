/**
 * __tests__/cycle-epic-review-route.test.ts
 *
 * Colocated vitest tests for GET /api/v5/cycles/:id/epic-review
 *
 * Coverage:
 *   - 200 with EpicReviewArtifact when phases/epic-review.json exists
 *   - 404 with structured JSON body when the artifact file is absent
 *   - 400 for cycleId containing characters outside [a-zA-Z0-9_-]
 *   - 500 on corrupt JSON in epic-review.json
 *   - meta envelope contains cycleId and ISO timestamp
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EpicReviewArtifact } from '@agentforge/shared';
import { cycleEpicReviewRoutes } from '../cycle-epic-review-route.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-review-test';

const SAMPLE_ARTIFACT: EpicReviewArtifact = {
  verdict: 'pass',
  rationale: 'All items met acceptance criteria.',
  faultedItems: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let tmpDir: string;

function writeArtifact(cycleId: string, data: unknown): void {
  const phasesDir = join(tmpDir, '.agentforge', 'cycles', cycleId, 'phases');
  mkdirSync(phasesDir, { recursive: true });
  writeFileSync(join(phasesDir, 'epic-review.json'), JSON.stringify(data), 'utf-8');
}

async function request(cycleId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v5/cycles/${cycleId}/epic-review`,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'epic-review-test-'));
  app = Fastify({ logger: false });
  await cycleEpicReviewRoutes(app, { projectRoot: tmpDir });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/epic-review', () => {
  it('returns 200 with artifact data when phases/epic-review.json exists', async () => {
    writeArtifact(CYCLE_ID, SAMPLE_ARTIFACT);

    const res = await request(CYCLE_ID);
    expect(res.statusCode).toBe(200);

    const body = res.json<{ data: EpicReviewArtifact; meta: { cycleId: string; timestamp: string } }>();
    expect(body.data.verdict).toBe('pass');
    expect(body.data.rationale).toBe('All items met acceptance criteria.');
    expect(body.data.faultedItems).toEqual([]);
  });

  it('returns 404 with structured JSON body when artifact is absent', async () => {
    const res = await request('nonexistent-cycle');
    expect(res.statusCode).toBe(404);

    const body = res.json<{ error: string; cycleId: string }>();
    expect(body.error).toMatch(/not found/i);
    expect(body.cycleId).toBe('nonexistent-cycle');
  });

  it('returns 400 for a cycleId containing spaces (URL-encoded)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/foo%20bar/epic-review',
    });
    // Fastify decodes %20 → space; SAFE_CYCLE_ID rejects spaces.
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 on corrupt JSON in epic-review.json', async () => {
    const phasesDir = join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'phases');
    mkdirSync(phasesDir, { recursive: true });
    writeFileSync(join(phasesDir, 'epic-review.json'), '{ invalid json {{{{', 'utf-8');

    const res = await request(CYCLE_ID);
    expect(res.statusCode).toBe(500);

    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/parse/i);
  });

  it('meta envelope contains the cycleId and a valid ISO timestamp', async () => {
    writeArtifact(CYCLE_ID, SAMPLE_ARTIFACT);

    const res = await request(CYCLE_ID);
    expect(res.statusCode).toBe(200);

    const body = res.json<{ meta: { cycleId: string; timestamp: string } }>();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
    expect(new Date(body.meta.timestamp).toISOString()).toBe(body.meta.timestamp);
  });

  it('carries faultedItems through on a partial verdict', async () => {
    const partialArtifact: EpicReviewArtifact = {
      verdict: 'partial',
      rationale: 'Two items passed; one missed edge-case test.',
      faultedItems: ['w2-c'],
    };
    writeArtifact(CYCLE_ID, partialArtifact);

    const res = await request(CYCLE_ID);
    expect(res.statusCode).toBe(200);

    const body = res.json<{ data: EpicReviewArtifact }>();
    expect(body.data.verdict).toBe('partial');
    expect(body.data.faultedItems).toEqual(['w2-c']);
  });

  it('returns 404 path hint in the response body', async () => {
    const res = await request('missing-cycle-xyz');
    expect(res.statusCode).toBe(404);

    const body = res.json<{ path: string }>();
    expect(body.path).toBe('phases/epic-review.json');
  });
});
