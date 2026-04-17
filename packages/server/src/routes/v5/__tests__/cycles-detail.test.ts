/**
 * Coverage for the GET /api/v5/cycles/:id in-progress synthesis branch.
 *
 * v6.7.4+ API contract: when cycle.json is absent (cycle still running),
 * the endpoint returns HTTP 404 with a partial payload and cycleInProgress: true.
 * The 404 status distinguishes "running" from "terminal" so clients can handle
 * caching correctly. The body still carries live phase/event data so the
 * dashboard can render a live feed. Callers must parse JSON even on 404.
 *
 * Prior to this change, the route returned 200 to avoid the dashboard treating
 * 404 as a fatal error. The dashboard now reads JSON on both 200 and 404.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cyclesRoutes } from '../cycles.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-detail-'));
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
