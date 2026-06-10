/**
 * Tests for epic and childCount fields on GET /api/v5/cycles rows.
 *
 * Sprint item: "Expose epic flag and childCount per row on the GET /api/v5/cycles list"
 *
 * Fixtures covered:
 *   A — objective-with-decomposition: cycle-config.json has objective string +
 *       decomposition.json exists with a children array
 *   B — objective-without-decomposition: cycle-config.json has objective string
 *       but no decomposition.json exists
 *   C — plain cycle: no objective in config, no decomposition.json
 *
 * Assertions:
 *   01 — epic: true on cycle with objective + decomposition.json (fixture A)
 *   02 — childCount equals decomposition.json children.length (fixture A)
 *   03 — epic: true on cycle with objective but no decomposition.json (fixture B)
 *   04 — childCount: 0 when no decomposition.json exists (fixture B)
 *   05 — epic: false on plain cycle (fixture C)
 *   06 — childCount: 0 on plain cycle (fixture C)
 *   07 — childCount: 0 when decomposition.json has no children array
 *   08 — childCount: 0 when decomposition.json is malformed JSON (defensive read)
 *   09 — epic: true when decomposition.json exists even without objective in config
 *   10 — epic and childCount present in the in-progress (no cycle.json) path
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Stub cycle-sessions so tests do not touch ~/.agentforge/sessions.json
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTerminalCycle(id: string, dir: string): void {
  writeFileSync(
    join(dir, 'cycle.json'),
    JSON.stringify({ cycleId: id, stage: 'completed' }),
  );
}

function writeLaunchConfig(dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'cycle-config.json'), JSON.stringify(extra));
}

function writeDecomposition(dir: string, content: unknown): void {
  writeFileSync(join(dir, 'decomposition.json'), JSON.stringify(content));
}

async function listCycles(query = '') {
  const res = await app.inject({ method: 'GET', url: `/api/v5/cycles${query}` });
  expect(res.statusCode).toBe(200);
  return res.json().cycles as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles — epic and childCount fields', () => {
  it('01 — epic: true on cycle with objective + decomposition.json (fixture A)', async () => {
    const id = 'epic-test-cycle-A-01';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { objective: 'Build the feature' });
    writeDecomposition(dir, { children: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['epic']).toBe(true);
  });

  it('02 — childCount equals decomposition.json children.length (fixture A)', async () => {
    const id = 'epic-test-cycle-A-02';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { objective: 'Refactor the API' });
    writeDecomposition(dir, { children: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['childCount']).toBe(3);
  });

  it('03 — epic: true on cycle with objective but no decomposition.json (fixture B)', async () => {
    const id = 'epic-test-cycle-B-03';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { objective: 'Improve test coverage' });
    // No decomposition.json

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['epic']).toBe(true);
  });

  it('04 — childCount: 0 when no decomposition.json exists (fixture B)', async () => {
    const id = 'epic-test-cycle-B-04';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { objective: 'Add monitoring' });
    // No decomposition.json

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['childCount']).toBe(0);
  });

  it('05 — epic: false on plain cycle with no objective (fixture C)', async () => {
    const id = 'epic-test-cycle-C-05';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { budgetUsd: 50 });
    // No objective, no decomposition.json

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['epic']).toBe(false);
  });

  it('06 — childCount: 0 on plain cycle (fixture C)', async () => {
    const id = 'epic-test-cycle-C-06';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { budgetUsd: 30 });
    // No objective, no decomposition.json

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['childCount']).toBe(0);
  });

  it('07 — childCount: 0 when decomposition.json has no children array', async () => {
    const id = 'epic-test-cycle-D-07';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { objective: 'Ship v2' });
    writeDecomposition(dir, { waves: [{ id: 'w1' }], version: '1.0' });
    // decomposition.json present but no `children` key

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['epic']).toBe(true);
    expect(row!['childCount']).toBe(0);
  });

  it('08 — childCount: 0 when decomposition.json is malformed JSON (defensive read)', async () => {
    const id = 'epic-test-cycle-E-08';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { objective: 'Ship v3' });
    // Write invalid JSON
    writeFileSync(join(dir, 'decomposition.json'), '{ not valid json ');

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    // decomposition.json exists → epic:true even though it's malformed
    expect(row!['epic']).toBe(true);
    expect(row!['childCount']).toBe(0);
  });

  it('09 — epic: true when decomposition.json exists even without objective in config', async () => {
    const id = 'epic-test-cycle-F-09';
    const dir = makeCycleDir(id);
    writeTerminalCycle(id, dir);
    writeLaunchConfig(dir, { budgetUsd: 100 });
    // no objective string, but decomposition.json exists
    writeDecomposition(dir, { children: [{ id: 'c1' }] });

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['epic']).toBe(true);
    expect(row!['childCount']).toBe(1);
  });

  it('10 — epic and childCount present in the in-progress (no cycle.json) path', async () => {
    const id = 'epic-test-cycle-G-10';
    const dir = makeCycleDir(id);
    // No cycle.json → in-progress code path
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }) + '\n',
    );
    writeLaunchConfig(dir, { objective: 'Live epic cycle' });
    writeDecomposition(dir, { children: [{ id: 'c1' }, { id: 'c2' }] });

    const rows = await listCycles();
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['epic']).toBe(true);
    expect(row!['childCount']).toBe(2);
  });
});
