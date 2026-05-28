/**
 * GET /api/v5/cycles should include stages: ('pending'|'active'|'done')[] per row
 * (CYCLE_PHASES order) so the dashboard Topbar can render pipeline-progress bricks.
 *
 * Regression for the reported bug: progress bricks stayed empty because the list
 * response never supplied a `stages` array, so the widget fell back to all-pending.
 *
 * A phase is 'done' if EITHER its phases/<name>.json artifact exists OR the
 * checkpoint lists it as completed (union). A completed cycle is all 'done';
 * a terminal-but-not-completed cycle (killed/crashed/failed) shows no 'active'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let sessionFixture: Record<string, unknown> | null = null;
vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: (id: string) => (sessionFixture && sessionFixture['cycleId'] === id ? sessionFixture : null),
  list: () => (sessionFixture ? [sessionFixture] : []),
  reap: () => ({ reaped: 0, stillRunning: 0 }),
  startReaper: () => ({ stop: () => {} }),
  register: () => {},
  markTerminal: () => {},
  stop: async () => ({ ok: true, status: 'killed', message: 'mocked' }),
  isPidAlive: () => false,
}));

import { cyclesRoutes } from '../cycles.js';

const PHASES = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'];

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-stages-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
  sessionFixture = null;
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  sessionFixture = null;
});

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writePhase(dir: string, phase: string): void {
  mkdirSync(join(dir, 'phases'), { recursive: true });
  writeFileSync(join(dir, 'phases', `${phase}.json`), JSON.stringify({ costUsd: 0.1 }));
}
function writeCheckpoint(dir: string, completedPhases: string[], resumeFromPhase: string): void {
  writeFileSync(
    join(dir, 'checkpoint.json'),
    JSON.stringify({ capturedAt: new Date().toISOString(), completedPhases, resumeFromPhase }),
  );
}
async function rowFor(id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
  expect(res.statusCode).toBe(200);
  const rows = res.json().cycles as Array<Record<string, unknown>>;
  const row = rows.find((r) => r['cycleId'] === id);
  expect(row).toBeDefined();
  return row!;
}

describe('GET /api/v5/cycles — stages field', () => {
  it('marks every phase done for a completed cycle', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000001';
    const dir = makeCycleDir(id);
    writeFileSync(join(dir, 'cycle.json'), JSON.stringify({ cycleId: id, stage: 'completed' }));

    const row = await rowFor(id);
    expect(row['stages']).toEqual(PHASES.map(() => 'done'));
  });

  it('shows done/active/pending for a running cycle from disk artifacts + checkpoint', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000002';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'assign', at: new Date().toISOString() }) + '\n',
    );
    writePhase(dir, 'audit');
    writePhase(dir, 'plan');
    writeCheckpoint(dir, ['audit', 'plan'], 'assign');

    const row = await rowFor(id);
    expect(row['status']).toBe('running');
    // audit, plan done; assign active; rest pending
    expect(row['stages']).toEqual([
      'done', 'done', 'active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  it('unions disk artifacts even when the checkpoint pointer regressed', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000003';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'gate', at: new Date().toISOString() }) + '\n',
    );
    for (const p of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate']) writePhase(dir, p);
    // checkpoint regressed to an earlier phase; disk artifacts must still win.
    writeCheckpoint(dir, ['audit', 'plan', 'assign'], 'execute');

    const row = await rowFor(id);
    const stages = row['stages'] as string[];
    for (let i = 0; i <= 6; i++) expect(stages[i]).toBe('done'); // audit..gate
    expect(stages[7]).toBe('pending'); // release
    expect(stages[8]).toBe('pending'); // learn
  });

  it('shows no active brick for a terminal killed cycle', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000004';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, stage: 'run', cost: { totalUsd: 5 } }),
    );
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }) + '\n',
    );
    writePhase(dir, 'audit');
    writePhase(dir, 'plan');
    sessionFixture = {
      cycleId: id, pid: 1234, pgid: 1234, workspaceId: 'default', workspaceRoot: tmpRoot,
      startedAt: '2026-05-25T01:00:00.000Z', lastSeenAt: '2026-05-25T01:05:00.000Z', status: 'killed',
    };

    const row = await rowFor(id);
    expect(row['stage']).toBe('killed');
    const stages = row['stages'] as string[];
    expect(stages[0]).toBe('done');
    expect(stages[1]).toBe('done');
    expect(stages).not.toContain('active');
  });

  it('always includes a 9-element stages array (one per pipeline phase)', async () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000005';
    const dir = makeCycleDir(id);
    writeFileSync(join(dir, 'cycle.json'), JSON.stringify({ cycleId: id, stage: 'completed' }));

    const row = await rowFor(id);
    expect(Array.isArray(row['stages'])).toBe(true);
    expect((row['stages'] as string[]).length).toBe(PHASES.length);
  });
});
