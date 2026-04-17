/**
 * Coverage for the GET /api/v5/cycles/:id in-progress synthesis branch.
 *
 * v6.7.4+ API contract: when cycle.json is absent (cycle still running),
 * the endpoint returns HTTP 404 with a partial payload and cycleInProgress: true.
 * The 404 status distinguishes "running" from "terminal" so clients can handle
 * caching correctly. The body still carries live phase/event data so the
 * dashboard can render a live feed. Callers must parse JSON even on 404.
 *
 * v10.7.0 addition: when cycle.json is absent AND cycle-sessions shows the
 * cycle is terminal (killed/crashed/failed/completed), the endpoint returns
 * HTTP 200 with partialTerminal:true and cycleInProgress:false. This closes
 * the "cycle says it is still running and it isn't" gap that previously kept
 * dashboards polling dead cycles forever.
 *
 * Prior to this change, the route returned 200 to avoid the dashboard treating
 * 404 as a fatal error. The dashboard now reads JSON on both 200 and 404.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub cycle-sessions so tests don't read/write the user's ~/.agentforge/
// sessions.json. Each test sets sessionFixture to control get() output.
let sessionFixture: Record<string, unknown> | null = null;
vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: (id: string) => (sessionFixture && (sessionFixture as any).cycleId === id ? sessionFixture : null),
  list: () => (sessionFixture ? [sessionFixture] : []),
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-detail-'));
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

describe('GET /api/v5/cycles/:id', () => {
  it('returns 404 when the cycle directory does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with the parsed cycle.json when present (terminal cycle)', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, stage: 'completed', sprintVersion: '6.7.2' }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleId).toBe(id);
    expect(body.stage).toBe('completed');
    expect(body.sprintVersion).toBe('6.7.2');
    expect(body.cycleInProgress).toBeUndefined();
  });

  it('synthesizes a 404+cycleInProgress response from events.jsonl when cycle.json is missing (in-progress)', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const dir = makeCycleDir(id);
    // Three events: scoring start, audit phase, plan phase. Last phase wins
    // for stage; first event provides startedAt.
    const events = [
      { type: 'scoring.start', at: '2026-04-07T10:00:00.000Z', sprintVersion: '6.7.2' },
      { type: 'phase.start', phase: 'audit', at: '2026-04-07T10:00:30.000Z' },
      { type: 'phase.start', phase: 'plan', at: '2026-04-07T10:01:00.000Z' },
    ];
    writeFileSync(
      join(dir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // 404 with cycleInProgress: true — cycle is running but cycle.json not yet written
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.cycleId).toBe(id);
    expect(body.stage).toBe('plan');
    expect(body.sprintVersion).toBe('6.7.2');
    expect(body.startedAt).toBe('2026-04-07T10:00:00.000Z');
    expect(body.cycleInProgress).toBe(true);
    expect(body.completedAt).toBeNull();
  });

  it('synthesizes a default 404+cycleInProgress payload when dir exists but events.jsonl is missing', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    makeCycleDir(id);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // 404 with cycleInProgress: true — dir exists but no events yet
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.cycleInProgress).toBe(true);
    expect(body.stage).toBe('plan');
  });

  it('returns 200 with cycle.json for a killed cycle (kill-switch trip writes cycle.json)', async () => {
    const id = '55555555-5555-5555-5555-555555555555';
    const dir = makeCycleDir(id);
    // kill-switch trips write cycle.json with stage:'killed' + killSwitch metadata
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({
        cycleId: id,
        stage: 'killed',
        sprintVersion: '11.1.0',
        killSwitch: { reason: 'testFloor', detail: 'test pass rate 40% < floor 60%' },
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stage).toBe('killed');
    expect(body.killSwitch?.reason).toBe('testFloor');
    // killed cycles are terminal — should NOT have cycleInProgress
    expect(body.cycleInProgress).toBeUndefined();
  });

  it('synthesizes partial payload for a hard-killed cycle without cycle.json, last stage from events', async () => {
    const id = '66666666-6666-6666-6666-666666666666';
    const dir = makeCycleDir(id);
    // OS-level kill: no cycle.json, but events.jsonl shows the kill signal was recorded
    const events = [
      { type: 'phase.start', phase: 'audit', at: '2026-04-10T09:00:00.000Z', sprintVersion: '11.1.0' },
      { type: 'phase.start', phase: 'execute', at: '2026-04-10T09:05:00.000Z' },
      { stage: 'killed', at: '2026-04-10T09:12:00.000Z', type: 'cycle.killed' },
    ];
    writeFileSync(
      join(dir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // cycle.json absent → synthesized 404 payload
    expect(res.statusCode).toBe(404);
    const body = res.json();
    // last stage event records 'killed', so the dashboard knows it's terminal
    expect(body.stage).toBe('killed');
    expect(body.sprintVersion).toBe('11.1.0');
    expect(body.cycleInProgress).toBe(true);
  });

  it('returns 200 + partialTerminal when cycle-sessions reports killed but cycle.json is missing', async () => {
    // Reproduces the e148f3eb bug: dashboard polls a dead cycle forever because
    // the detail endpoint infers "in progress" from the filesystem alone. The
    // fix is to cross-check cycle-sessions — a terminal session wins over the
    // missing-cycle.json heuristic.
    const id = '77777777-7777-7777-7777-777777777777';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'plan', at: '2026-04-17T21:56:40.000Z', sprintVersion: '10.7.0' }) + '\n',
    );
    sessionFixture = {
      cycleId: id,
      pid: 30543,
      pgid: 30543,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-17T21:56:39.812Z',
      lastSeenAt: '2026-04-17T22:01:02.474Z',
      status: 'killed',
      exitNote: 'SIGKILL after grace period expired',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleInProgress).toBe(false);
    expect(body.partialTerminal).toBe(true);
    expect(body.status).toBe('killed');
    expect(body.stage).toBe('killed');
    expect(body.exitNote).toBe('SIGKILL after grace period expired');
    expect(body.completedAt).toBe('2026-04-17T22:01:02.474Z');
  });

  it('returns 200 + partialTerminal for a crashed session (PID disappeared)', async () => {
    const id = '88888888-8888-8888-8888-888888888888';
    makeCycleDir(id);
    sessionFixture = {
      cycleId: id,
      pid: 9999,
      pgid: 9999,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-17T10:00:00.000Z',
      lastSeenAt: '2026-04-17T10:01:00.000Z',
      status: 'crashed',
      exitNote: 'PID disappeared (reaper sweep)',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('crashed');
    expect(body.cycleInProgress).toBe(false);
    expect(body.partialTerminal).toBe(true);
  });

  it('still returns 404 + cycleInProgress for a running session (no terminal handoff)', async () => {
    const id = '99999999-9999-9999-9999-999999999999';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: '2026-04-17T12:00:00.000Z' }) + '\n',
    );
    sessionFixture = {
      cycleId: id,
      pid: 12345,
      pgid: 12345,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-17T12:00:00.000Z',
      lastSeenAt: '2026-04-17T12:00:10.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().cycleInProgress).toBe(true);
    expect(res.json().partialTerminal).toBeUndefined();
  });

  it('skips malformed events.jsonl lines without crashing', async () => {
    const id = '44444444-4444-4444-4444-444444444444';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        '{"type":"phase.start","phase":"audit","at":"2026-04-07T10:00:00.000Z"}',
        'this is not json',
        '{"type":"phase.start","phase":"test","at":"2026-04-07T10:01:00.000Z"}',
      ].join('\n') + '\n',
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // 404 + body even for malformed lines — must not crash
    expect(res.statusCode).toBe(404);
    expect(res.json().stage).toBe('test');
  });
});
