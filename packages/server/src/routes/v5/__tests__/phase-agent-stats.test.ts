/**
 * W6 visibility — phase agents in stats + objective previews listing.
 *
 * 1. /api/v5/cycles/:id/agents must include agentRuns from
 *    phases/epic-review.json (the strong-model reviewer was invisible
 *    because the phase scan list omitted it).
 * 2. /api/v5/agents/activity must aggregate runs from EVERY phase artifact —
 *    plan.json (epic-planner), gate.json, … — not just execute.json.
 * 3. /api/v5/previews lists .agentforge/previews/<dir>/preview.json
 *    artifacts written by `cycle preview --objective`.
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
import { agentRoutes } from '../agents.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-phase-agent-stats-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
  await agentRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(join(dir, 'phases'), { recursive: true });
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify({ cycleId: id, stage: 'completed' }));
  return dir;
}

function writePhase(dir: string, phase: string, payload: Record<string, unknown>): void {
  writeFileSync(join(dir, 'phases', `${phase}.json`), JSON.stringify(payload));
}

describe('phase agents in stats', () => {
  it('cycle agents endpoint includes epic-review agentRuns', async () => {
    const dir = makeCycleDir('c-epic-1');
    writePhase(dir, 'plan', {
      costUsd: 2.5,
      agentRuns: [{ agentId: 'epic-planner', costUsd: 2.5, durationMs: 60_000 }],
    });
    writePhase(dir, 'epic-review', {
      mode: 'epic-review',
      costUsd: 1.25,
      agentRuns: [{ agentId: 'epic-reviewer', costUsd: 1.25, durationMs: 30_000, verdict: 'APPROVE' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/c-epic-1/agents' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { runs: Array<{ agentId: string; phase: string }>; byAgent: Record<string, unknown> };
    const agentIds = body.runs.map((r) => r.agentId);
    expect(agentIds).toContain('epic-planner');
    expect(agentIds).toContain('epic-reviewer');
    expect(Object.keys(body.byAgent)).toContain('epic-reviewer');
  });

  it('agents activity rollup includes phase-level agents (epic-planner from plan.json)', async () => {
    const dir = makeCycleDir('c-epic-2');
    const nowIso = new Date().toISOString();
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: 'c-epic-2', stage: 'completed', completedAt: nowIso }),
    );
    writePhase(dir, 'plan', {
      costUsd: 3.0,
      agentRuns: [{ agentId: 'epic-planner', costUsd: 3.0, durationMs: 60_000, completedAt: nowIso }],
    });
    writePhase(dir, 'execute', {
      costUsd: 1.0,
      agentRuns: [{ agentId: 'coder', costUsd: 1.0, durationMs: 10_000, completedAt: nowIso }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/activity' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ agentId: string; spend24h: number }> };
    const byId = new Map(body.data.map((r) => [r.agentId, r]));
    expect(byId.has('epic-planner')).toBe(true);
    expect(byId.get('epic-planner')!.spend24h).toBeCloseTo(3.0);
    expect(byId.has('coder')).toBe(true);
  });
});

describe('GET /api/v5/previews', () => {
  it('returns [] when no previews directory exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/previews' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ previews: [] });
  });

  it('lists preview artifacts with summary fields', async () => {
    const dir = join(tmpRoot, '.agentforge', 'previews', 'objective-2026-06-09T22-00-00-000Z');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'preview.json'),
      JSON.stringify({
        status: 'ok',
        objective: { id: 'epic-preview-x', title: 'Build the thing', createdAt: '2026-06-09T22:00:00.000Z' },
        plan: { epicId: 'epic-preview-x', rationale: 'r', children: [{ id: 'c1' }, { id: 'c2' }] },
        report: {
          waveCount: 2,
          budget: { budgetUsd: 150, spendableUsd: 120, sumUsd: 100, lowerUsd: 84, upperUsd: 120, withinBand: true },
        },
        plannerCostUsd: 4.2,
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v5/previews' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { previews: Array<Record<string, unknown>> };
    expect(body.previews).toHaveLength(1);
    expect(body.previews[0]).toMatchObject({
      id: 'objective-2026-06-09T22-00-00-000Z',
      status: 'ok',
      title: 'Build the thing',
      childCount: 2,
      waveCount: 2,
      plannerCostUsd: 4.2,
      budgetUsd: 150,
      withinBand: true,
    });
  });
});
