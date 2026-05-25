/**
 * Coverage for the GET /api/v5/cycles/:id in-progress synthesis branch.
 *
 * API contract: when cycle.json is absent (cycle still running), the endpoint
 * returns HTTP 200 with a partial payload and cycleInProgress: true. The body
 * carries live phase/event data so the dashboard can render a live feed without
 * browser console noise from failed resource loads.
 *
 * v10.7.0 addition: when cycle.json is absent AND cycle-sessions shows the
 * cycle is terminal (killed/crashed/failed/completed), the endpoint returns
 * HTTP 200 with partialTerminal:true and cycleInProgress:false. This closes
 * the "cycle says it is still running and it isn't" gap that previously kept
 * dashboards polling dead cycles forever.
 *
 * Older versions returned 404+cycleInProgress for live cycles; the dashboard
 * parsed that body, but browsers still logged failed resource loads.
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

  it('synthesizes a 200+cycleInProgress response from events.jsonl when cycle.json is missing (in-progress)', async () => {
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
    // A running session is required to prevent the v15.1.0 staleness heuristic
    // from promoting this to partialTerminal. Real in-progress cycles always have
    // a session entry (created by POST /api/v5/cycles at spawn time).
    sessionFixture = {
      cycleId: id,
      pid: 11111,
      pgid: 11111,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-07T10:00:00.000Z',
      lastSeenAt: '2026-04-07T10:01:00.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // 200 with cycleInProgress: true — cycle is running but cycle.json not yet written
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleId).toBe(id);
    expect(body.stage).toBe('plan');
    expect(body.sprintVersion).toBe('6.7.2');
    expect(body.startedAt).toBe('2026-04-07T10:00:00.000Z');
    expect(body.cycleInProgress).toBe(true);
    expect(body.completedAt).toBeNull();
  });

  it('synthesizes a default 200+cycleInProgress payload when dir exists but events.jsonl is missing', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    makeCycleDir(id);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // 200 with cycleInProgress: true — dir exists but no events yet
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleInProgress).toBe(true);
    expect(body.stage).toBe('plan');
  });

  it('treats heartbeat-only cycle.json as in-progress, not terminal', async () => {
    const id = '44444444-4444-4444-4444-444444444444';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, lastHeartbeatAt: '2026-04-07T10:00:00.000Z' }),
    );
    sessionFixture = {
      cycleId: id,
      pid: 11111,
      pgid: 11111,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-07T10:00:00.000Z',
      lastSeenAt: '2026-04-07T10:00:30.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stage).toBe('plan');
    expect(body.cycleInProgress).toBe(true);
    expect(body.completedAt).toBeNull();
  });

  it('merges partial running cycle.json with live sprint, PR, and phase data', async () => {
    const id = '4a4a4a4a-4444-4444-4444-444444444444';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, stage: 'run', cost: { totalUsd: 5 } }),
    );
    writeFileSync(join(dir, 'sprint-link.json'), JSON.stringify({ sprintVersion: '10.38.0' }));
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ type: 'sprint.assigned', sprintVersion: '10.38.0', at: '2026-05-25T01:00:00.000Z' }),
        JSON.stringify({ type: 'phase.start', phase: 'execute', at: '2026-05-25T01:05:00.000Z' }),
      ].join('\n') + '\n',
    );
    mkdirSync(join(dir, 'phases'), { recursive: true });
    writeFileSync(
      join(dir, 'phases', 'execute.json'),
      JSON.stringify({
        costUsd: 1.25,
        itemResults: [
          { itemId: 'backlog-bl-012', agentId: 'yaml-doctor', status: 'completed', costUsd: 1.25 },
        ],
      }),
    );
    writeFileSync(join(dir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 144,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/144',
        branch: 'codex/agent-yaml-doctor',
        status: 'open',
        openedAt: '2026-05-25T02:13:44.527Z',
      },
    ]));
    sessionFixture = {
      cycleId: id,
      pid: 11111,
      pgid: 11111,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-05-25T01:00:00.000Z',
      lastSeenAt: '2026-05-25T01:05:00.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleInProgress).toBe(true);
    expect(body.stage).toBe('execute');
    expect(body.status).toBe('running');
    expect(body.sprintVersion).toBe('10.38.0');
    expect(body.cost.totalUsd).toBe(1.25);
    expect(body.agentRunCount).toBe(1);
    expect(body.prUrl).toBe('https://github.com/seandonvaughan/AgentForge/pull/144');
    expect(body.pr).toMatchObject({
      url: 'https://github.com/seandonvaughan/AgentForge/pull/144',
      number: 144,
      source: 'agent-prs',
    });
  });

  it('lets terminal session status correct a partial running cycle.json detail snapshot', async () => {
    const id = '4b4b4b4b-4444-4444-4444-444444444444';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, stage: 'run', cost: { totalUsd: 5 } }),
    );
    writeFileSync(join(dir, 'sprint-link.json'), JSON.stringify({ sprintVersion: '10.39.0' }));
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ type: 'sprint.assigned', sprintVersion: '10.39.0', at: '2026-05-25T01:00:00.000Z' }),
        JSON.stringify({ type: 'phase.start', phase: 'execute', at: '2026-05-25T01:05:00.000Z' }),
      ].join('\n') + '\n',
    );
    sessionFixture = {
      cycleId: id,
      pid: 11111,
      pgid: 11111,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-05-25T01:00:00.000Z',
      lastSeenAt: '2026-05-25T01:10:00.000Z',
      status: 'crashed',
      exitNote: 'PID disappeared',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sprintVersion).toBe('10.39.0');
    expect(body.stage).toBe('crashed');
    expect(body.status).toBe('crashed');
    expect(body.partialTerminal).toBe(true);
    expect(body.cycleInProgress).toBe(false);
  });

  it('counts agentRuns and itemResults from the same live phase artifact', async () => {
    const id = '4c4c4c4c-4444-4444-4444-444444444444';
    const dir = makeCycleDir(id);
    writeFileSync(join(dir, 'sprint-link.json'), JSON.stringify({ sprintVersion: '10.40.0' }));
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: '2026-05-25T01:05:00.000Z' }) + '\n',
    );
    mkdirSync(join(dir, 'phases'), { recursive: true });
    writeFileSync(
      join(dir, 'phases', 'execute.json'),
      JSON.stringify({
        costUsd: 3.75,
        agentRuns: [
          { itemId: 'backlog-bl-101', agentId: 'route-engineer', status: 'completed', costUsd: 1.25 },
        ],
        itemResults: [
          { itemId: 'backlog-bl-102', agentId: 'test-author', status: 'completed', costUsd: 2.5 },
        ],
      }),
    );
    sessionFixture = {
      cycleId: id,
      pid: 11111,
      pgid: 11111,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-05-25T01:00:00.000Z',
      lastSeenAt: '2026-05-25T01:06:00.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentRunCount).toBe(2);
    expect(body.cost.byAgent).toMatchObject({
      'route-engineer': 1.25,
      'test-author': 2.5,
    });
  });

  it('uses launch-config budget in synthesized in-progress detail payloads', async () => {
    const id = '45454545-4545-4545-4545-454545454545';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle-config.json'),
      JSON.stringify({ cycleId: id, budgetUsd: 25, runtimeMode: 'codex-cli', modelCap: 'sonnet', effortCap: 'high' }),
    );
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'audit', at: '2026-04-07T10:00:00.000Z' }) + '\n',
    );
    sessionFixture = {
      cycleId: id,
      pid: 11111,
      pgid: 11111,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-07T10:00:00.000Z',
      lastSeenAt: '2026-04-07T10:00:30.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleInProgress).toBe(true);
    expect(body.cost.budgetUsd).toBe(25);
    expect(body.runtimeMode).toBe('codex-cli');
    expect(body.modelCap).toBe('sonnet');
    expect(body.effortCap).toBe('high');
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

  it('returns 200 + partialTerminal for a hard-killed cycle whose session was lost (stale events, kill recorded)', async () => {
    // v15.1.0 gap fix: OS-level kill between server restarts — no cycle.json,
    // no session record, but events.jsonl recorded a kill event.
    // Previously returned 404+cycleInProgress, causing the dashboard to poll forever.
    // After fix: staleness heuristic fires → 200+partialTerminal so polling stops.
    const id = '66666666-6666-6666-6666-666666666666';
    const dir = makeCycleDir(id);
    const events = [
      { type: 'phase.start', phase: 'audit', at: '2026-04-10T09:00:00.000Z', sprintVersion: '11.1.0' },
      { type: 'phase.start', phase: 'execute', at: '2026-04-10T09:05:00.000Z' },
      { stage: 'killed', at: '2026-04-10T09:12:00.000Z', type: 'cycle.killed' },
    ];
    writeFileSync(
      join(dir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    // No sessionFixture — simulates server restart that cleared the registry.

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // With the staleness fix: no session + events are months old → 200+partialTerminal.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // stage preserved from events ('killed' is in the inferred-terminal allowlist)
    expect(body.stage).toBe('killed');
    expect(body.sprintVersion).toBe('11.1.0');
    expect(body.partialTerminal).toBe(true);
    expect(body.cycleInProgress).toBe(false);
    expect(typeof body.exitNote).toBe('string');
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

  it('still returns 200 + cycleInProgress for a running session (no terminal handoff)', async () => {
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
    expect(res.statusCode).toBe(200);
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
    // Running session prevents the v15.1.0 staleness path so we exercise the
    // malformed-line skipping rather than the inferred-terminal branch.
    sessionFixture = {
      cycleId: id,
      pid: 44444,
      pgid: 44444,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-04-07T10:00:00.000Z',
      lastSeenAt: '2026-04-07T10:01:00.000Z',
      status: 'running',
    };

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    // 200 + body even for malformed lines — must not crash
    expect(res.statusCode).toBe(200);
    expect(res.json().stage).toBe('test');
  });

  it('returns 200 + partialTerminal for a killed-mid-execute cycle with no session and no kill event (v15.1.0 gap)', async () => {
    // The primary gap case: budget enforcer kills the cycle mid-execute.
    // The OS-level kill doesn't allow a graceful shutdown so:
    //   - cycle.json is never written
    //   - no 'killed' event is appended to events.jsonl
    //   - session record was lost on server restart
    // Before v15.1.0: endpoint returned 404+cycleInProgress indefinitely.
    // After v15.1.0: staleness heuristic promotes to 200+partialTerminal+stage:'crashed'.
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const dir = makeCycleDir(id);
    const events = [
      { type: 'phase.start', phase: 'audit', at: '2026-04-10T09:00:00.000Z', sprintVersion: '15.1.0' },
      { type: 'phase.start', phase: 'execute', at: '2026-04-10T09:05:00.000Z' },
      // No kill event — abrupt OS kill, no graceful shutdown
    ];
    writeFileSync(
      join(dir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    // No sessionFixture — server was restarted after the kill, registry is gone.

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 'execute' is not in killed/crashed/failed so inferred stage is 'crashed'
    expect(body.stage).toBe('crashed');
    expect(body.sprintVersion).toBe('15.1.0');
    expect(body.partialTerminal).toBe(true);
    expect(body.cycleInProgress).toBe(false);
    expect(body.status).toBe('crashed');
    expect(body.exitNote).toContain('event staleness');
  });
});
