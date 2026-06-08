/**
 * GET /api/v5/cycles — objective flag and childCount per list row.
 *
 * Tests:
 *   - Epic row: cycle-config.json has a non-empty objective string
 *     → objective: true, childCount = sum of children across all decomposition waves
 *   - Non-epic row: no cycle-config.json / no objective / no decomposition.json
 *     → objective: false, childCount: 0
 *   - decomposition.json present but no objective → childCount counts children, objective: false
 *   - objective present but no decomposition.json → objective: true, childCount: 0
 */
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

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-epic-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
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

function writeCycleJson(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'cycle.json'),
    JSON.stringify({ cycleId: id, stage: 'completed', ...extra }),
  );
}

function writeCycleConfig(dir: string, fields: Record<string, unknown>): void {
  writeFileSync(join(dir, 'cycle-config.json'), JSON.stringify(fields, null, 2));
}

/**
 * Write a decomposition.json with the given per-wave child counts.
 * e.g. childCounts = [3, 2] → two waves, 3 children in wave 0, 2 in wave 1.
 */
function writeDecomposition(dir: string, childCounts: number[]): void {
  const waves = childCounts.map((count, waveIndex) => ({
    waveIndex,
    children: Array.from({ length: count }, (_, i) => ({
      id: `w${waveIndex}-child-${i}`,
      title: `Child ${i} of wave ${waveIndex}`,
      files: [],
      estimatedCostUsd: 1.0,
      status: 'pending',
    })),
  }));
  writeFileSync(join(dir, 'decomposition.json'), JSON.stringify(waves, null, 2));
}

async function rowFor(id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
  expect(res.statusCode).toBe(200);
  const rows = res.json().cycles as Array<Record<string, unknown>>;
  const row = rows.find((r) => r['cycleId'] === id);
  expect(row).toBeDefined();
  return row!;
}

describe('GET /api/v5/cycles — objective and childCount fields', () => {
  it('epic row: objective=true and childCount=total children across all waves', async () => {
    const id = 'epic0001-0000-0000-0000-000000000001';
    const dir = makeCycleDir(id);
    writeCycleJson(dir, id);
    writeCycleConfig(dir, {
      cycleId: id,
      objective: 'Add OAuth2 login flow',
      budgetUsd: 50,
    });
    // 2 waves: 3 children + 2 children = 5 total
    writeDecomposition(dir, [3, 2]);

    const row = await rowFor(id);
    expect(row['objective']).toBe(true);
    expect(row['childCount']).toBe(5);
  });

  it('non-epic row: objective=false and childCount=0 when no config or decomposition', async () => {
    const id = 'epic0001-0000-0000-0000-000000000002';
    const dir = makeCycleDir(id);
    writeCycleJson(dir, id);
    // No cycle-config.json, no decomposition.json

    const row = await rowFor(id);
    expect(row['objective']).toBe(false);
    expect(row['childCount']).toBe(0);
  });

  it('objective=false when config exists but objective is null', async () => {
    const id = 'epic0001-0000-0000-0000-000000000003';
    const dir = makeCycleDir(id);
    writeCycleJson(dir, id);
    writeCycleConfig(dir, { cycleId: id, objective: null, budgetUsd: 30 });

    const row = await rowFor(id);
    expect(row['objective']).toBe(false);
    expect(row['childCount']).toBe(0);
  });

  it('childCount counts children when decomposition.json present but no objective', async () => {
    const id = 'epic0001-0000-0000-0000-000000000004';
    const dir = makeCycleDir(id);
    writeCycleJson(dir, id);
    writeCycleConfig(dir, { cycleId: id, objective: null });
    writeDecomposition(dir, [4]);

    const row = await rowFor(id);
    expect(row['objective']).toBe(false);
    expect(row['childCount']).toBe(4);
  });

  it('objective=true and childCount=0 when objective present but no decomposition.json', async () => {
    const id = 'epic0001-0000-0000-0000-000000000005';
    const dir = makeCycleDir(id);
    writeCycleJson(dir, id);
    writeCycleConfig(dir, { cycleId: id, objective: 'Improve test coverage', budgetUsd: 25 });
    // No decomposition.json

    const row = await rowFor(id);
    expect(row['objective']).toBe(true);
    expect(row['childCount']).toBe(0);
  });

  it('fields are present on in-progress rows (no cycle.json)', async () => {
    const id = 'epic0001-0000-0000-0000-000000000006';
    const dir = makeCycleDir(id);
    // No cycle.json → in-progress path
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }) + '\n',
    );
    writeCycleConfig(dir, { cycleId: id, objective: 'Refactor auth module', budgetUsd: 40 });
    writeDecomposition(dir, [2, 3]);

    const row = await rowFor(id);
    expect(row['objective']).toBe(true);
    expect(row['childCount']).toBe(5);
  });
});
