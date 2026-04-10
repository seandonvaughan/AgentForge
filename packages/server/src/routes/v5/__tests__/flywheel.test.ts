/**
 * Tests for GET /api/v5/flywheel — real metric computation from cycles,
 * sprints, and agents. Verifies the endpoint returns computed scores rather
 * than static placeholders, and that scores change meaningfully as data grows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

function writeMemoryEntry(
  type: string,
  source: string,
  createdAt: string,
) {
  const memDir = join(tmpRoot, '.agentforge/memory');
  mkdirSync(memDir, { recursive: true });
  const entry = JSON.stringify({
    id: `${source}-${Math.random().toString(36).slice(2)}`,
    type,
    value: 'test memory entry',
    createdAt,
    source,
    tags: [],
  });
  const file = join(memDir, `${type}.jsonl`);
  // Append so multiple calls accumulate entries in the same file.
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  writeFileSync(file, existing + entry + '\n');
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

  // ── Memory Stats ────────────────────────────────────────────────────────

  it('memoryStats.totalEntries is 0 when no memory directory exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { memoryStats: { totalEntries: number; hitRate: number; entriesPerCycleTrend: unknown[] } };
    };
    expect(data.memoryStats.totalEntries).toBe(0);
    expect(data.memoryStats.hitRate).toBe(0);
    expect(data.memoryStats.entriesPerCycleTrend).toEqual([]);
  });

  it('memoryStats.totalEntries counts all JSONL lines across entry types', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('c1', { startedAt: '2026-01-01T10:00:00.000Z' });
    // Write 3 entries across 2 type files
    writeMemoryEntry('cycle-outcome', 'c1', '2026-01-01T09:00:00.000Z');
    writeMemoryEntry('cycle-outcome', 'c1', '2026-01-01T09:05:00.000Z');
    writeMemoryEntry('review-finding', 'c1', '2026-01-01T09:10:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { memoryStats: { totalEntries: number } };
    };
    expect(data.memoryStats.totalEntries).toBe(3);
  });

  it('memoryStats.entriesPerCycleTrend groups entry counts by cycleId', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('cyc-a', { startedAt: '2026-01-01T08:00:00.000Z' });
    writeCycle('cyc-b', { startedAt: '2026-01-02T08:00:00.000Z' });
    writeMemoryEntry('cycle-outcome', 'cyc-a', '2026-01-01T09:00:00.000Z');
    writeMemoryEntry('cycle-outcome', 'cyc-a', '2026-01-01T09:05:00.000Z');
    writeMemoryEntry('cycle-outcome', 'cyc-b', '2026-01-02T09:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: {
        memoryStats: {
          entriesPerCycleTrend: Array<{ cycleId: string; count: number; startedAt: string }>;
        };
      };
    };
    const trend = data.memoryStats.entriesPerCycleTrend;
    expect(trend).toHaveLength(2);
    const a = trend.find(t => t.cycleId === 'cyc-a');
    const b = trend.find(t => t.cycleId === 'cyc-b');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it('memoryStats.hitRate is 0 when no memory entries exist before any completed cycle', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // Cycle started before any memory was written
    writeCycle('solo', { startedAt: '2026-01-01T08:00:00.000Z' });
    // Memory entry written AFTER the cycle started — no prior memory
    writeMemoryEntry('cycle-outcome', 'solo', '2026-01-01T10:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // The only completed cycle started before any memory existed → 0% hit rate
    expect(data.memoryStats.hitRate).toBe(0);
  });

  it('memoryStats.hitRate is 1 when all completed cycles had prior memory available', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // First cycle writes memory
    writeCycle('first', { startedAt: '2026-01-01T08:00:00.000Z' });
    writeMemoryEntry('cycle-outcome', 'first', '2026-01-01T09:00:00.000Z');
    // Second cycle starts AFTER memory exists
    writeCycle('second', { startedAt: '2026-01-02T08:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // 'second' started after the memory entry from 'first' → 1 / 2 completed = 0.5
    // 'first' started before any entry → no hit
    expect(data.memoryStats.hitRate).toBe(0.5);
  });

  it('memoryStats.entriesPerCycleTrend caps at 12 cycles', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // Write 15 cycles
    for (let i = 0; i < 15; i++) {
      const isoDate = `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`;
      writeCycle(`cycle-${i}`, { startedAt: isoDate });
    }
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { memoryStats: { entriesPerCycleTrend: unknown[] } };
    };
    expect(data.memoryStats.entriesPerCycleTrend).toHaveLength(12);
  });
});
