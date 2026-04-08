/**
 * Tests for GET /api/v5/flywheel — real metric computation from cycles,
 * sprints, and agents. Verifies the endpoint returns computed scores rather
 * than static placeholders, and that scores change meaningfully as data grows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dashboardStubRoutes } from '../dashboard-stubs.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-flywheel-'));
  app = Fastify({ logger: false });
  await dashboardStubRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function mkdirs(...paths: string[]) {
  for (const p of paths) mkdirSync(p, { recursive: true });
}

function writeCycle(id: string, overrides: Record<string, unknown> = {}) {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify({
    cycleId: id,
    stage: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    tests: { passed: 10, failed: 0, total: 10, passRate: 1.0 },
    git: { filesChanged: ['src/foo.ts'] },
    pr: { number: 42, url: 'https://github.com/org/repo/pull/42' },
    ...overrides,
  }, null, 2));
}

function writeSprintFlat(filename: string, items: Array<{ status: string }>) {
  writeFileSync(
    join(tmpRoot, '.agentforge/sprints', filename),
    JSON.stringify({ version: filename.replace('.json', ''), items }),
  );
}

function writeSprintNested(filename: string, items: Array<{ status: string }>) {
  writeFileSync(
    join(tmpRoot, '.agentforge/sprints', filename),
    JSON.stringify({ sprints: [{ version: '1.0', items }] }),
  );
}

function writeAgent(name: string) {
  writeFileSync(join(tmpRoot, '.agentforge/agents', `${name}.yaml`), 'id: ' + name);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v5/flywheel', () => {
  it('returns 200 with metrics array when no data directories exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { data: unknown };
    const data = body.data as {
      metrics: Array<{ key: string; score: number }>;
      overallScore: number;
      updatedAt: string;
    };

    expect(data.metrics).toHaveLength(4);
    expect(data.metrics.map((m) => m.key)).toEqual([
      'meta_learning',
      'autonomy',
      'inheritance',
      'velocity',
    ]);
    // No data → all scores should be 0
    expect(data.overallScore).toBe(0);
    expect(data.updatedAt).toBeTruthy();
  });

  it('exposes debug counters in the payload', async () => {
    mkdirs(
      join(tmpRoot, '.agentforge/cycles'),
      join(tmpRoot, '.agentforge/sprints'),
      join(tmpRoot, '.agentforge/agents'),
    );
    writeCycle('aaa');
    writeSprintFlat('v1.0.json', [
      { status: 'completed' },
      { status: 'planned' },
    ]);
    writeAgent('ArchitectAgent');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: {
      debug: {
        cycleCount: number;
        completedCycleCount: number;
        sprintCount: number;
        agentCount: number;
        totalItems: number;
        completedItems: number;
      };
    } };

    expect(data.debug.cycleCount).toBe(1);
    expect(data.debug.completedCycleCount).toBe(1);
    expect(data.debug.sprintCount).toBe(1);
    expect(data.debug.agentCount).toBe(1);
    expect(data.debug.totalItems).toBe(2);
    expect(data.debug.completedItems).toBe(1);
  });

  it('autonomy score is 0 when no cycles exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const autonomy = data.metrics.find((m) => m.key === 'autonomy');
    expect(autonomy?.score).toBe(0);
  });

  it('autonomy score is non-zero when completed cycles exist', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('cycle-1');
    writeCycle('cycle-2', { stage: 'completed', tests: { passRate: 0.8 } });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const autonomy = data.metrics.find((m) => m.key === 'autonomy');
    expect(autonomy?.score).toBeGreaterThan(0);
  });

  it('velocity score reflects sprint item completion rate', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    // 8 of 10 items completed → ~56 pts item-rate component
    writeSprintFlat('v1.0.json', Array.from({ length: 10 }, (_, i) => ({
      status: i < 8 ? 'completed' : 'planned',
    })));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const velocity = data.metrics.find((m) => m.key === 'velocity');
    // 8/10 * 70 = 56, no cycle throughput → 56
    expect(velocity?.score).toBe(56);
  });

  it('inheritance score grows with agent count', async () => {
    mkdirs(join(tmpRoot, '.agentforge/agents'));
    // Write 75 agents → 75/150 * 80 = 40 pts
    for (let i = 0; i < 75; i++) writeAgent(`agent-${i}`);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const inheritance = data.metrics.find((m) => m.key === 'inheritance');
    expect(inheritance?.score).toBe(40);
  });

  it('handles nested { sprints: [...] } sprint file format', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    writeSprintNested('v4.3.json', [
      { status: 'completed' },
      { status: 'completed' },
      { status: 'planned' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { debug: { totalItems: number; completedItems: number } } };
    expect(data.debug.totalItems).toBe(3);
    expect(data.debug.completedItems).toBe(2);
  });

  it('handles flat { items: [...] } sprint file format', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    writeSprintFlat('v5.1.json', [
      { status: 'completed' },
      { status: 'completed' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { debug: { totalItems: number; completedItems: number } } };
    expect(data.debug.totalItems).toBe(2);
    expect(data.debug.completedItems).toBe(2);
  });

  it('meta_learning score includes description string', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    writeSprintFlat('v1.0.json', [{ status: 'completed' }]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { metrics: Array<{ key: string; description?: string }> };
    };
    const ml = data.metrics.find((m) => m.key === 'meta_learning');
    expect(ml?.description).toContain('sprint');
  });

  it('response is cached: repeated calls return same cachedAtMs within TTL', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const res2 = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });

    const body1 = JSON.parse(res1.body) as { meta: { cachedAtMs: number } };
    const body2 = JSON.parse(res2.body) as { meta: { cachedAtMs: number } };
    // Both calls hit the cache — the timestamp must be identical
    expect(body1.meta.cachedAtMs).toBe(body2.meta.cachedAtMs);
  });
});
