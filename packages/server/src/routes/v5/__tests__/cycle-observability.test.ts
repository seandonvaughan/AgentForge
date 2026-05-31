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
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-observability-'));
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

describe('GET /api/v5/cycles/:id/observability', () => {
  it('passes through providerUsage + phaseErrorSummary and recomputes stale heartbeat as dead', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const dir = makeCycleDir(id);
    const lastHeartbeatAt = new Date(Date.now() - 20 * 60_000).toISOString();
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({
        cycleId: id,
        providerUsage: { 'codex-cli': { items: 2, costUsd: 0.3 } },
        phaseErrorSummary: { execute: { failed: 1, retried: 0 } },
        lastHeartbeatAt,
        heartbeatStaleness: 'healthy',
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}/observability` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      cycleId: id,
      providerUsage: { 'codex-cli': { items: 2, costUsd: 0.3 } },
      phaseErrorSummary: { execute: { failed: 1, retried: 0 } },
      lastHeartbeatAt,
      heartbeatStaleness: 'dead',
    });
  });

  it('recomputes heartbeat staleness as healthy for a current heartbeat', async () => {
    const id = '66666666-7777-8888-9999-000000000000';
    const dir = makeCycleDir(id);
    const nowHeartbeat = new Date().toISOString();
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({
        lastHeartbeatAt: nowHeartbeat,
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}/observability` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      cycleId: id,
      providerUsage: {},
      phaseErrorSummary: {},
      lastHeartbeatAt: nowHeartbeat,
      heartbeatStaleness: 'healthy',
    });
  });

  it('returns 404 when cycle.json is absent', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    makeCycleDir(id);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}/observability` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
  });
});
