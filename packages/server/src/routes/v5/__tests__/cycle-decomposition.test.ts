/**
 * Tests for GET /api/v5/cycles/:id/decomposition
 *
 * Tests:
 *   01 — 200 with parsed decomposition.json when file exists
 *   02 — meta.cycleId matches the request param
 *   03 — meta.timestamp is a valid ISO string
 *   04 — 404 when decomposition.json is absent
 *   05 — 400 when cycleId contains unsafe characters
 *   06 — 400 on path traversal attempt
 *   07 — response data matches written fixture content
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cycleDecompositionRoutes } from '../cycle-decomposition.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-decomp-test-01';

const DECOMPOSITION_FIXTURE = {
  version: '1.0',
  items: [
    { id: 'item-1', title: 'Do something', agentId: 'agent-alpha' },
    { id: 'item-2', title: 'Do another thing', agentId: 'agent-beta' },
  ],
  meta: { generatedAt: '2026-06-10T00:00:00.000Z' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await cycleDecompositionRoutes(a, { projectRoot });
  await a.ready();
  return a;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let cycleDir: string;
let app: FastifyInstance;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-decomp-'));
  cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
  mkdirSync(cycleDir, { recursive: true });
});

afterEach(async () => {
  if (app) await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/decomposition', () => {
  it('01 — 200 with parsed data when decomposition.json exists', async () => {
    writeFileSync(
      join(cycleDir, 'decomposition.json'),
      JSON.stringify(DECOMPOSITION_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: typeof DECOMPOSITION_FIXTURE; meta: { cycleId: string } }>();
    expect(body.data).toBeDefined();
    expect(body.data.version).toBe('1.0');
    expect(body.data.items).toHaveLength(2);
  });

  it('02 — meta.cycleId matches the request param', async () => {
    writeFileSync(
      join(cycleDir, 'decomposition.json'),
      JSON.stringify(DECOMPOSITION_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { cycleId: string } }>();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
  });

  it('03 — meta.timestamp is a valid ISO string', async () => {
    writeFileSync(
      join(cycleDir, 'decomposition.json'),
      JSON.stringify(DECOMPOSITION_FIXTURE),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { timestamp: string } }>();
    expect(() => new Date(body.meta.timestamp).toISOString()).not.toThrow();
  });

  it('04 — 404 when decomposition.json is absent', async () => {
    // cycleDir exists but no decomposition.json
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('decomposition not found');
  });

  it('05 — 400 when cycleId contains unsafe characters', async () => {
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad!id/decomposition',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('Invalid');
  });

  it('06 — 400 on path traversal attempt', async () => {
    app = await buildApp(tmpRoot);

    // Fastify URL-decodes params, so encode the dots to force traversal attempt
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/..%2F..%2Fetc%2Fpasswd/decomposition',
    });

    expect([400, 404]).toContain(res.statusCode);
  });

  it('07 — response data matches written fixture content', async () => {
    const fixture = { epic: 'my-epic', waves: [{ id: 'w1', tasks: ['t1', 't2'] }] };
    writeFileSync(
      join(cycleDir, 'decomposition.json'),
      JSON.stringify(fixture),
    );
    app = await buildApp(tmpRoot);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: typeof fixture }>();
    expect(body.data).toEqual(fixture);
  });
});
