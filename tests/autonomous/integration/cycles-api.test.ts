// tests/autonomous/integration/cycles-api.test.ts
//
// v6.5.0 Agent A — integration tests for the autonomous cycles REST API.
//
// Seeds a throwaway .agentforge/cycles directory with fixture cycle dirs,
// registers the Fastify plugin against a projectRoot pointed at the tmp dir,
// and exercises every endpoint via app.inject().

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cyclesRoutes, startCycleEventsWatcher } from '../../../packages/server/src/routes/v5/cycles.js';
import { appendFileSync } from 'node:fs';

let tmpRoot: string;
let app: FastifyInstance;

function seedCycle(
  cycleId: string,
  cycleJson: Record<string, unknown> | null,
  opts: {
    scoring?: unknown;
    events?: unknown[];
    phases?: Record<string, unknown>;
    tests?: unknown;
    git?: unknown;
    pr?: unknown;
    approvalPending?: unknown;
    approvalDecision?: unknown;
  } = {},
): string {
  const dir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  if (cycleJson !== null) {
    writeFileSync(join(dir, 'cycle.json'), JSON.stringify(cycleJson));
  }
  if (opts.scoring !== undefined) {
    writeFileSync(join(dir, 'scoring.json'), JSON.stringify(opts.scoring));
  }
  if (opts.events) {
    writeFileSync(
      join(dir, 'events.jsonl'),
      opts.events.map(e => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  if (opts.phases) {
    mkdirSync(join(dir, 'phases'), { recursive: true });
    for (const [name, body] of Object.entries(opts.phases)) {
      writeFileSync(join(dir, 'phases', `${name}.json`), JSON.stringify(body));
    }
  }
  if (opts.tests !== undefined) writeFileSync(join(dir, 'tests.json'), JSON.stringify(opts.tests));
  if (opts.git !== undefined) writeFileSync(join(dir, 'git.json'), JSON.stringify(opts.git));
  if (opts.pr !== undefined) writeFileSync(join(dir, 'pr.json'), JSON.stringify(opts.pr));
  if (opts.approvalPending !== undefined) {
    writeFileSync(join(dir, 'approval-pending.json'), JSON.stringify(opts.approvalPending));
  }
  if (opts.approvalDecision !== undefined) {
    writeFileSync(join(dir, 'approval-decision.json'), JSON.stringify(opts.approvalDecision));
  }
  return dir;
}

function makeCycleJson(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    cycleId: 'abc',
    sprintVersion: 'v6.5.0',
    stage: 'completed',
    startedAt: '2026-04-06T10:00:00.000Z',
    completedAt: '2026-04-06T10:30:00.000Z',
    durationMs: 1_800_000,
    cost: { totalUsd: 2.34, budgetUsd: 10, byAgent: {}, byPhase: {} },
    tests: { passed: 42, failed: 0, skipped: 1, total: 43, passRate: 0.977, newFailures: [] },
    git: { branch: 'autonomous/v6.5.0', commitSha: 'deadbeef', filesChanged: ['a.ts'] },
    pr: { url: 'https://github.com/x/y/pull/1', number: 1, draft: false },
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-api-'));
  mkdirSync(join(tmpRoot, '.agentforge', 'cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /api/v5/cycles', () => {
  it('returns empty array when cycles dir has no entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cycles: [] });
  });

  it('lists completed cycles with summarized fields', async () => {
    seedCycle('cycle-1', makeCycleJson({ cycleId: 'cycle-1', startedAt: '2026-04-06T09:00:00.000Z' }));
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cycles).toHaveLength(1);
    expect(body.cycles[0]).toMatchObject({
      cycleId: 'cycle-1',
      sprintVersion: 'v6.5.0',
      stage: 'completed',
      costUsd: 2.34,
      budgetUsd: 10,
      testsPassed: 42,
      testsTotal: 43,
      prUrl: 'https://github.com/x/y/pull/1',
      hasApprovalPending: false,
    });
  });

  it('sorts cycles by startedAt DESC', async () => {
    seedCycle('older', makeCycleJson({ cycleId: 'older', startedAt: '2026-04-01T00:00:00.000Z' }));
    seedCycle('newest', makeCycleJson({ cycleId: 'newest', startedAt: '2026-04-06T00:00:00.000Z' }));
    seedCycle('middle', makeCycleJson({ cycleId: 'middle', startedAt: '2026-04-03T00:00:00.000Z' }));
    const body = (await app.inject({ method: 'GET', url: '/api/v5/cycles' })).json();
    expect(body.cycles.map((c: { cycleId: string }) => c.cycleId)).toEqual(['newest', 'middle', 'older']);
  });

  it('respects ?limit query param', async () => {
    for (let i = 0; i < 5; i++) {
      seedCycle(`cycle-${i}`, makeCycleJson({ cycleId: `cycle-${i}`, startedAt: `2026-04-0${i + 1}T00:00:00.000Z` }));
    }
    const body = (await app.inject({ method: 'GET', url: '/api/v5/cycles?limit=2' })).json();
    expect(body.cycles).toHaveLength(2);
  });

  it('flags hasApprovalPending when approval-pending.json exists without decision', async () => {
    seedCycle('pending', makeCycleJson({ cycleId: 'pending' }), {
      approvalPending: { requestedAt: 'now' },
    });
    seedCycle('decided', makeCycleJson({ cycleId: 'decided' }), {
      approvalPending: { requestedAt: 'now' },
      approvalDecision: { decision: 'approved' },
    });
    const body = (await app.inject({ method: 'GET', url: '/api/v5/cycles' })).json();
    const byId = Object.fromEntries(body.cycles.map((c: { cycleId: string }) => [c.cycleId, c]));
    expect(byId['pending'].hasApprovalPending).toBe(true);
    expect(byId['decided'].hasApprovalPending).toBe(false);
  });

  it('synthesizes a row for in-progress cycles with no cycle.json', async () => {
    seedCycle('running', null, {
      events: [{ type: 'phase.start', stage: 'run', at: '2026-04-06T12:00:00.000Z' }],
    });
    const body = (await app.inject({ method: 'GET', url: '/api/v5/cycles' })).json();
    expect(body.cycles).toHaveLength(1);
    expect(body.cycles[0].cycleId).toBe('running');
    expect(body.cycles[0].stage).toBe('run');
    expect(body.cycles[0].completedAt).toBeNull();
  });
});

describe('GET /api/v5/cycles/:id', () => {
  it('returns raw cycle.json when present', async () => {
    seedCycle('abc', makeCycleJson({ cycleId: 'abc' }));
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json().cycleId).toBe('abc');
  });

  it('returns 404 when cycle dir does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 with cycleInProgress when dir exists but cycle.json missing', async () => {
    seedCycle('in-progress', null);
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/in-progress' });
    expect(res.statusCode).toBe(404);
    expect(res.json().cycleInProgress).toBe(true);
  });

  it('rejects path traversal attempts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/..%2F..%2Fetc' });
    expect([400, 404]).toContain(res.statusCode);
    // Body should never leak file contents
    expect(res.payload).not.toContain('root:');
  });

  it('rejects ids with slashes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/foo..bar' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v5/cycles/:id/scoring', () => {
  it('returns scoring.json when present', async () => {
    seedCycle('abc', makeCycleJson(), { scoring: { result: { score: 0.9 }, at: 'now' } });
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/scoring' });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.score).toBe(0.9);
  });

  it('404s when scoring.json missing', async () => {
    seedCycle('abc', makeCycleJson());
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/scoring' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/v5/cycles/:id/events', () => {
  it('returns parsed events array', async () => {
    seedCycle('abc', makeCycleJson(), {
      events: [
        { type: 'cycle.start', at: 't1' },
        { type: 'phase.start', at: 't2', stage: 'plan' },
        { type: 'phase.end', at: 't3', stage: 'plan' },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/events' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it('supports ?since= for incremental polling', async () => {
    seedCycle('abc', makeCycleJson(), {
      events: [
        { type: 'a' }, { type: 'b' }, { type: 'c' }, { type: 'd' },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/events?since=2' });
    const body = res.json();
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(['c', 'd']);
    expect(body.total).toBe(4);
  });

  it('returns empty events when file absent', async () => {
    seedCycle('abc', makeCycleJson());
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/events' });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });
});

describe('GET /api/v5/cycles/:id/phases/:phase', () => {
  it('returns parsed phase json', async () => {
    seedCycle('abc', makeCycleJson(), { phases: { plan: { items: ['a', 'b'] } } });
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/phases/plan' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual(['a', 'b']);
  });

  it('404s when phase file missing', async () => {
    seedCycle('abc', makeCycleJson());
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/phases/plan' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects unknown phase names', async () => {
    seedCycle('abc', makeCycleJson());
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/phases/evil' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v5/cycles/:id/files/:name', () => {
  it('returns tests.json', async () => {
    seedCycle('abc', makeCycleJson(), { tests: { passed: 5 } });
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/files/tests' });
    expect(res.statusCode).toBe(200);
    expect(res.json().passed).toBe(5);
  });

  it('returns approval-pending.json', async () => {
    seedCycle('abc', makeCycleJson(), { approvalPending: { reason: 'budget' } });
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/files/approval-pending' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('budget');
  });

  it('rejects unknown file names with 400', async () => {
    seedCycle('abc', makeCycleJson());
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/files/secrets' });
    expect(res.statusCode).toBe(400);
  });

  it('404s when requested file missing', async () => {
    seedCycle('abc', makeCycleJson());
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles/abc/files/pr' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v5/cycles', () => {
  it('returns 202 with cycleId, startedAt, and pid', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles' });
    // Subprocess will fail (no CLI built in tmp root) but we capture stdout
    // to a log file. The handler must still return 202 synchronously.
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.cycleId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(typeof body.startedAt).toBe('string');
    expect(typeof body.pid).toBe('number');
  });
});

describe('startCycleEventsWatcher (v6.5.3-B)', () => {
  it('emits only events appended after watching began', async () => {
    // Pre-existing event — must NOT be emitted
    seedCycle('cycle-watch', makeCycleJson({ cycleId: 'cycle-watch' }), {
      events: [{ type: 'phase.start', phase: 'audit', at: '2026-04-06T10:00:00.000Z' }],
    });

    const seen: Array<Record<string, unknown>> = [];
    const watcher = startCycleEventsWatcher(
      tmpRoot,
      { emit: (msg) => { seen.push(msg as unknown as Record<string, unknown>); } },
      10_000, // long interval — we drive ticks manually
    );

    try {
      // First tick anchors the file size — should NOT emit history
      await watcher.tick();
      expect(seen).toHaveLength(0);

      // Append a new event line
      const eventsFile = join(tmpRoot, '.agentforge', 'cycles', 'cycle-watch', 'events.jsonl');
      appendFileSync(
        eventsFile,
        JSON.stringify({ type: 'phase.result', phase: 'audit', at: '2026-04-06T10:01:00.000Z' }) + '\n',
      );

      await watcher.tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        cycleId: 'cycle-watch',
        type: 'phase.result',
        phase: 'audit',
      });

      // Append two more
      appendFileSync(
        eventsFile,
        JSON.stringify({ type: 'phase.start', phase: 'plan', at: '2026-04-06T10:02:00.000Z' }) + '\n' +
        JSON.stringify({ type: 'phase.result', phase: 'plan', at: '2026-04-06T10:03:00.000Z' }) + '\n',
      );
      await watcher.tick();
      expect(seen).toHaveLength(3);
      expect((seen[2] as { phase: string }).phase).toBe('plan');
    } finally {
      watcher.stop();
    }
  });

  it('handles a new cycle dir created after watching began', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const watcher = startCycleEventsWatcher(
      tmpRoot,
      { emit: (msg) => { seen.push(msg as unknown as Record<string, unknown>); } },
      10_000,
    );
    try {
      await watcher.tick(); // no files yet
      // Create a brand-new cycle with one event
      seedCycle('fresh-cycle', null, {
        events: [{ type: 'phase.start', phase: 'audit', at: '2026-04-06T11:00:00.000Z' }],
      });
      // First tick: anchors size, emits nothing
      await watcher.tick();
      expect(seen).toHaveLength(0);
      // Append another
      appendFileSync(
        join(tmpRoot, '.agentforge', 'cycles', 'fresh-cycle', 'events.jsonl'),
        JSON.stringify({ type: 'phase.result', phase: 'audit', at: '2026-04-06T11:01:00.000Z' }) + '\n',
      );
      await watcher.tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ cycleId: 'fresh-cycle', type: 'phase.result' });
    } finally {
      watcher.stop();
    }
  });
});
