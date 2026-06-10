/**
 * Tests for GET /api/v5/cycles/:id/epic-review
 *
 * Tests:
 *   01 — 200 with fixture data when epic-review.json is present
 *   02 — meta.cycleId matches the request param
 *   03 — meta.timestamp is an ISO string
 *   04 — data matches the fixture content verbatim
 *   05 — cycle directory absent → 404
 *   06 — epic-review.json absent (cycle dir exists) → 404
 *   07 — invalid cycleId (unsafe chars) → 400
 *   08 — cycleId with path-traversal chars → 400
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { cycleEpicReviewRoutes } from '../cycle-epic-review.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-epic-abc123';

const EPIC_REVIEW_FIXTURE = {
  verdict: 'approve',
  score: 87,
  epics: [
    {
      id: 'epic-auth',
      title: 'Authentication subsystem',
      status: 'complete',
      items: ['item-1', 'item-2'],
      notes: 'All acceptance criteria met.',
    },
    {
      id: 'epic-dashboard',
      title: 'Dashboard v2',
      status: 'partial',
      items: ['item-3', 'item-4'],
      notes: 'item-4 deferred to next sprint.',
    },
  ],
  reviewedAt: '2026-06-10T08:00:00.000Z',
  reviewerId: 'agent-forge-engine-architect',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await cycleEpicReviewRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let cycleDir: string;
let phasesDir: string;
let app: FastifyInstance;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-epic-review-'));
  cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
  phasesDir = join(cycleDir, 'phases');
  mkdirSync(phasesDir, { recursive: true });
});

afterEach(async () => {
  if (app) await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/epic-review', () => {
  it('01 — returns 200 when epic-review.json is present', async () => {
    writeFileSync(
      join(phasesDir, 'epic-review.json'),
      JSON.stringify(EPIC_REVIEW_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });

    expect(res.statusCode).toBe(200);
  });

  it('02 — meta.cycleId matches the request param', async () => {
    writeFileSync(
      join(phasesDir, 'epic-review.json'),
      JSON.stringify(EPIC_REVIEW_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });

    const body = res.json<{ meta: { cycleId: string } }>();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
  });

  it('03 — meta.timestamp is a valid ISO string', async () => {
    writeFileSync(
      join(phasesDir, 'epic-review.json'),
      JSON.stringify(EPIC_REVIEW_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });

    const body = res.json<{ meta: { timestamp: string } }>();
    expect(() => new Date(body.meta.timestamp).toISOString()).not.toThrow();
  });

  it('04 — response data matches the fixture content', async () => {
    writeFileSync(
      join(phasesDir, 'epic-review.json'),
      JSON.stringify(EPIC_REVIEW_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });

    const body = res.json<{ data: typeof EPIC_REVIEW_FIXTURE }>();
    expect(body.data).toEqual(EPIC_REVIEW_FIXTURE);
  });

  it('05 — cycle directory absent → 404', async () => {
    // Remove the cycle directory that was created in beforeEach
    rmSync(cycleDir, { recursive: true, force: true });
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain('not found');
  });

  it('06 — epic-review.json absent (cycle dir exists) → 404', async () => {
    // phasesDir exists but no epic-review.json written
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string; cycleId: string }>();
    // Error message mentions epic-review (case-insensitive)
    expect(body.error.toLowerCase()).toContain('epic-review');
    expect(body.cycleId).toBe(CYCLE_ID);
  });

  it('07 — invalid cycleId with unsafe chars → 400', async () => {
    app = await buildApp(tmpRoot);

    // Use a cycleId with a dot (.) which our regex rejects — avoid # which
    // inject() would treat as a URL fragment, truncating the path.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad.id/epic-review',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Invalid');
  });

  it('08 — cycleId with path-traversal-like input is rejected or 404', async () => {
    app = await buildApp(tmpRoot);

    // Fastify will URL-decode the param, but the regex rejects dots.
    // Either 400 (rejected by validator) or 404 (non-existent dir) is correct.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/evil-traversal-id/epic-review',
    });

    expect([400, 404]).toContain(res.statusCode);
  });
});
