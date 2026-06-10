/**
 * child-4 — registration tests for the three epic-artifact route modules
 * (cycle-decomposition / cycle-epic-review / cycle-spend-report).
 *
 * The repo convention requires every v5 route to be reachable through BOTH
 * server entry paths: createServerV5's no-adapter stack (server.ts) and the
 * adapter-mode registerV5Routes (routes/v5/index.ts). These tests boot the
 * no-adapter server (which also exercises duplicate-route detection via
 * app.ready()) and assert each endpoint answers — 200 with a fixture present
 * and 404 JSON when the artifact is absent — proving the modules are imported
 * and awaited rather than dead exports.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerV5 } from '../server.js';

let createdApps: Array<{ close: () => Promise<void> }> = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  for (const app of createdApps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  createdApps = [];
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-epic-routes-'));
  tmpDirs.push(dir);
  return dir;
}

const CYCLE_ID = '11111111-2222-3333-4444-555555555555';

function seedCycleArtifacts(projectRoot: string): void {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', CYCLE_ID);
  mkdirSync(join(cycleDir, 'phases'), { recursive: true });
  writeFileSync(
    join(cycleDir, 'decomposition.json'),
    JSON.stringify({ epicId: 'epic-test', rationale: 'r', children: [] }),
  );
  writeFileSync(
    join(cycleDir, 'phases', 'epic-review.json'),
    JSON.stringify({ phase: 'gate', mode: 'epic-review', verdict: 'APPROVE', faultedItems: [] }),
  );
  writeFileSync(
    join(cycleDir, 'spend-report.json'),
    JSON.stringify({ schemaVersion: 1, cycleId: CYCLE_ID, totalUsd: 1, perItem: [] }),
  );
}

describe('epic-artifact route registration (no-adapter path)', () => {
  it('serves all three artifacts when fixtures exist', async () => {
    const projectRoot = makeTmpRoot();
    seedCycleArtifacts(projectRoot);
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const decomposition = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
    });
    expect(decomposition.statusCode).toBe(200);
    expect(decomposition.json().epicId ?? decomposition.json().data?.epicId).toBeDefined();

    const review = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/epic-review`,
    });
    expect(review.statusCode).toBe(200);

    const spend = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/spend-report`,
    });
    expect(spend.statusCode).toBe(200);
  });

  it('returns 404 JSON (not a route miss) when the artifact is absent', async () => {
    const projectRoot = makeTmpRoot();
    // Cycle dir exists but holds no artifacts — the route must answer 404
    // itself; an unregistered route would also 404 but without our JSON body.
    mkdirSync(join(projectRoot, '.agentforge', 'cycles', CYCLE_ID), { recursive: true });
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    for (const tail of ['decomposition', 'epic-review', 'spend-report']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v5/cycles/${CYCLE_ID}/${tail}`,
      });
      expect(res.statusCode).toBe(404);
      // Registered handlers return a JSON error body; Fastify's default
      // not-found handler returns {message:"Route GET:... not found"} —
      // assert we did NOT get the default router miss.
      const body = res.json() as { message?: string };
      expect(body.message ?? '').not.toContain('not found');
    }
  });
});
