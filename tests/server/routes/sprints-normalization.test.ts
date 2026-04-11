/**
 * tests/server/routes/sprints-normalization.test.ts
 *
 * Integration tests for GET /api/v5/sprints and GET /api/v5/sprints/:version.
 * Focuses on the normalization logic in src/server/routes/sprints.ts — especially
 * the auditFindings / risks fallback that has historically regressed.
 *
 * Test strategy: write controlled sprint JSON files to a temp directory and
 * start the server with `projectRoot` pointing there. This exercises the full
 * HTTP layer without touching the real .agentforge/sprints/ directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../../src/server/server.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentforge-sprints-test-'));
  mkdirSync(join(root, '.agentforge', 'sprints'), { recursive: true });
  return root;
}

function writeSprint(root: string, version: string, data: object): void {
  const content = JSON.stringify({ sprints: [{ version, phase: 'completed', items: [], ...data }] });
  writeFileSync(join(root, '.agentforge', 'sprints', `v${version}.json`), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/sprints/:version — normalization', () => {
  let app: FastifyInstance;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = makeTempRoot();
    const result = await createServer({ projectRoot: tmpRoot });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // auditFindings / risks fallback — the historically buggy path
  // -------------------------------------------------------------------------

  it('preserves auditFindings: [] even when risks array is present', async () => {
    // This was the v10.4.0 MAJOR bug: empty auditFindings was overridden by risks
    // because [].length === 0 is falsy. After the fix, null-check should preserve [].
    writeSprint(tmpRoot, '1.0.0', {
      auditFindings: [],
      risks: [{ risk: 'Deployment failure', mitigation: 'Staged rollout' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/1.0.0' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.data.auditFindings).toEqual([]);
  });

  it('uses auditFindings when it has content, ignoring risks', async () => {
    writeSprint(tmpRoot, '1.1.0', {
      auditFindings: ['Latency spike in P95', 'Cost overrun 12%'],
      risks: [{ risk: 'Should not appear', mitigation: 'N/A' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/1.1.0' });
    const body = JSON.parse(res.body);

    expect(body.data.auditFindings).toEqual(['Latency spike in P95', 'Cost overrun 12%']);
  });

  it('falls back to risks when auditFindings is absent', async () => {
    writeSprint(tmpRoot, '1.2.0', {
      // no auditFindings field at all
      risks: [
        { risk: 'Memory leak', mitigation: 'Add heap profiling' },
        'plain string risk',
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/1.2.0' });
    const body = JSON.parse(res.body);

    expect(body.data.auditFindings).toEqual([
      'Memory leak — Add heap profiling',
      'plain string risk',
    ]);
  });

  it('returns empty array when neither auditFindings nor risks are present', async () => {
    writeSprint(tmpRoot, '1.3.0', {
      // neither field
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/1.3.0' });
    const body = JSON.parse(res.body);

    expect(body.data.auditFindings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Core field normalization
  // -------------------------------------------------------------------------

  it('derives status from phase when no explicit status is present', async () => {
    writeSprint(tmpRoot, '2.0.0', { phase: 'release' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/2.0.0' });
    const body = JSON.parse(res.body);

    expect(body.data.status).toBe('completed');
  });

  it('normalizes item status "planned" → "pending"', async () => {
    writeSprint(tmpRoot, '2.1.0', {
      items: [{ id: 'i1', title: 'Planned item', priority: 'P1', status: 'planned' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/2.1.0' });
    const body = JSON.parse(res.body);

    expect(body.data.items[0].status).toBe('pending');
  });

  it('coalesces estimatedCostUsd → estimatedCost on items', async () => {
    writeSprint(tmpRoot, '2.2.0', {
      items: [{ id: 'i1', title: 'Costed item', priority: 'P0', status: 'completed', estimatedCostUsd: 12.5 }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/2.2.0' });
    const body = JSON.parse(res.body);

    expect(body.data.items[0].estimatedCost).toBe(12.5);
  });

  it('maps legacy test-count fields (testsPrior/testsAdded/testsTotal)', async () => {
    writeSprint(tmpRoot, '2.3.0', {
      testsPrior: 100,
      testsAdded: 20,
      testsTotal: 120,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/2.3.0' });
    const body = JSON.parse(res.body);

    expect(body.data.testCountBefore).toBe(100);
    expect(body.data.testCountDelta).toBe(20);
    expect(body.data.testCountAfter).toBe(120);
  });

  // -------------------------------------------------------------------------
  // HTTP contract
  // -------------------------------------------------------------------------

  it('returns 404 for a version that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/99.99.99' });
    expect(res.statusCode).toBe(404);
  });

  it('resolves both with and without "v" prefix in the URL', async () => {
    writeSprint(tmpRoot, '3.0.0', { title: 'Prefix test' });

    const resWithV = await app.inject({ method: 'GET', url: '/api/v5/sprints/v3.0.0' });
    const resWithout = await app.inject({ method: 'GET', url: '/api/v5/sprints/3.0.0' });

    expect(resWithV.statusCode).toBe(200);
    expect(resWithout.statusCode).toBe(200);
    expect(JSON.parse(resWithV.body).data.version).toBe(JSON.parse(resWithout.body).data.version);
  });
});

describe('GET /api/v5/sprints — list normalization', () => {
  let app: FastifyInstance;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = makeTempRoot();
    const result = await createServer({ projectRoot: tmpRoot });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list when no sprint files exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.data).toEqual([]);
  });

  it('returns all sprints from the directory', async () => {
    writeSprint(tmpRoot, '4.0.0', { title: 'First' });
    writeSprint(tmpRoot, '4.1.0', { title: 'Second' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    const body = JSON.parse(res.body);

    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
  });
});
