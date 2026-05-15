// packages/server/src/routes/v5/__tests__/plan-endpoint.test.ts
//
// Tests for GET /api/v5/cycles/:id/plan — the new endpoint introduced by
// Track D (sprint → cycle plan.json migration).
//
// Also verifies that GET /api/v5/cycles/:id/sprint prefers plan.json over
// the legacy sprint-link.json → sprints/ resolution chain.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub cycle-sessions so tests don't interact with the real session store.
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

const CYCLE_ID = 'abc12345-0000-0000-0000-000000000001';

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-plan-ep-'));
  mkdirSync(join(dir, '.agentforge', 'cycles', CYCLE_ID), { recursive: true });
  mkdirSync(join(dir, '.agentforge', 'sprints'), { recursive: true });
  return dir;
}

async function buildApp(projectRoot: string) {
  const app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot });
  return app;
}

describe('GET /api/v5/cycles/:id/plan', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 when plan.json does not exist', async () => {
    tmpDir = makeTmp();
    // Write events.jsonl so the cycle dir is non-empty/recognized
    writeFileSync(join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'events.jsonl'), '');
    app = await buildApp(tmpDir);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/plan` });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/plan\.json not found/i);
  });

  it('returns plan.json contents when present', async () => {
    tmpDir = makeTmp();
    const plan = {
      version: '10.7.0',
      sprintId: 'v10-7-0-autonomous',
      title: 'AgentForge v10.7.0 — Autonomous Cycle',
      phase: 'planned',
      items: [{ id: 'i1', title: 'Fix imports', priority: 'P0', assignee: 'coder', status: 'planned' }],
      budget: 50,
      successCriteria: ['All tests pass'],
      versionDecision: { previousVersion: '10.6.0', nextVersion: '10.7.0', tier: 'minor', rationale: 'minor bump' },
    };
    writeFileSync(
      join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'),
      JSON.stringify(plan),
    );
    app = await buildApp(tmpDir);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/plan` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('10.7.0');
    expect(body.phase).toBe('planned');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.successCriteria).toEqual(['All tests pass']);
    expect(body.versionDecision.rationale).toBe('minor bump');
  });
});

describe('GET /api/v5/cycles/:id/sprint — prefers plan.json', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns plan.json as sprint when plan.json exists (new cycle path)', async () => {
    tmpDir = makeTmp();
    const plan = {
      version: '10.7.0',
      items: [{ id: 'i1', title: 'Task', status: 'planned', assignee: 'coder' }],
    };
    writeFileSync(
      join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'),
      JSON.stringify(plan),
    );
    // Also write a legacy sprint-link.json — should be ignored when plan.json exists
    writeFileSync(
      join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'sprint-link.json'),
      JSON.stringify({ sprintVersion: '10.6.0' }),
    );
    writeFileSync(
      join(tmpDir, '.agentforge', 'sprints', 'v10.6.0.json'),
      JSON.stringify({ version: '10.6.0', items: [] }),
    );
    app = await buildApp(tmpDir);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/sprint` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.file).toBe('plan.json');
    expect(body.sprint.version).toBe('10.7.0');
  });

  it('falls back to sprint-link.json when plan.json absent (legacy cycle)', async () => {
    tmpDir = makeTmp();
    writeFileSync(
      join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'sprint-link.json'),
      JSON.stringify({ sprintVersion: '10.6.0' }),
    );
    writeFileSync(
      join(tmpDir, '.agentforge', 'sprints', 'v10.6.0.json'),
      JSON.stringify({ version: '10.6.0', items: [{ id: 'x', title: 'Legacy task', status: 'completed' }] }),
    );
    app = await buildApp(tmpDir);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/sprint` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.file).toBe('v10.6.0.json');
    expect(body.sprint.version).toBe('10.6.0');
  });
});
