/**
 * Coverage for the GET /api/v5/cycles/:id in-progress synthesis branch.
 *
 * Before this branch existed, the route returned 404 while a cycle was still
 * running because cycle.json is only written at terminal stage. The dashboard
 * detail page treated every 404 as a fatal "Failed to load cycle: HTTP 404".
 * The fix synthesizes a partial payload from events.jsonl. These tests pin
 * that behavior so it doesn't silently regress to 404.
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

  it('synthesizes a 200 response from events.jsonl when cycle.json is missing (in-progress)', async () => {
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
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleId).toBe(id);
    expect(body.stage).toBe('plan');
    expect(body.sprintVersion).toBe('6.7.2');
    expect(body.startedAt).toBe('2026-04-07T10:00:00.000Z');
    expect(body.cycleInProgress).toBe(true);
    expect(body.completedAt).toBeNull();
  });

  it('synthesizes a default in-progress payload when the dir exists but events.jsonl is missing', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    makeCycleDir(id);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycleInProgress).toBe(true);
    expect(body.stage).toBe('plan');
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
    expect(res.statusCode).toBe(200);
    expect(res.json().stage).toBe('test');
  });
});
