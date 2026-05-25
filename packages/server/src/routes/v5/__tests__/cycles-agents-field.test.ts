/**
 * Fix 2: GET /api/v5/cycles?limit=N should include agents: string[] per row.
 *
 * The `summarizeCycle` function was updated to extract agent ids from
 * phases/*.json agentRuns arrays. This test asserts:
 *   - agents field is always present (empty array when no phase data)
 *   - agents is populated from agentRuns in phase files
 *   - agents is deduplicated (same agent appearing in multiple phases once)
 *   - agents is present in both the cycle.json path and the in-progress path
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

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-agents-'));
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

function writeCycleJson(id: string, dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'cycle.json'),
    JSON.stringify({ cycleId: id, stage: 'completed', ...extra }),
  );
}

function writePhase(dir: string, phase: string, agentRuns: Array<{ agentId: string }>): void {
  mkdirSync(join(dir, 'phases'), { recursive: true });
  writeFileSync(
    join(dir, 'phases', `${phase}.json`),
    JSON.stringify({ costUsd: 0.1, agentRuns }),
  );
}

describe('GET /api/v5/cycles — Fix 2: agents field', () => {
  it('includes agents: [] when no phase files exist (terminal cycle)', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';
    const dir = makeCycleDir(id);
    writeCycleJson(id, dir);

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(Array.isArray(row!['agents'])).toBe(true);
    expect(row!['agents']).toEqual([]);
  });

  it('populates agents from agentRuns in a single phase file', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000002';
    const dir = makeCycleDir(id);
    writeCycleJson(id, dir);
    writePhase(dir, 'execute', [{ agentId: 'backend-dev' }, { agentId: 'frontend-dev' }]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    const agents = row!['agents'] as string[];
    expect(agents).toContain('backend-dev');
    expect(agents).toContain('frontend-dev');
    expect(agents).toHaveLength(2);
  });

  it('deduplicates agents appearing in multiple phases', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000003';
    const dir = makeCycleDir(id);
    writeCycleJson(id, dir);
    // Same agent in both audit and execute phases
    writePhase(dir, 'audit', [{ agentId: 'audit-agent' }]);
    writePhase(dir, 'execute', [{ agentId: 'audit-agent' }, { agentId: 'exec-agent' }]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    const agents = row!['agents'] as string[];
    expect(agents).toContain('audit-agent');
    expect(agents).toContain('exec-agent');
    // Should only appear once despite being in two phases
    expect(agents.filter((a) => a === 'audit-agent')).toHaveLength(1);
    expect(agents).toHaveLength(2);
  });

  it('includes agents in the in-progress (no cycle.json) path', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000004';
    const dir = makeCycleDir(id);
    // No cycle.json — in-progress path
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }) + '\n',
    );
    writePhase(dir, 'execute', [{ agentId: 'exec-agent' }]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    const agents = row!['agents'] as string[];
    expect(agents).toContain('exec-agent');
  });

  it('does not classify heartbeat-only cycle.json as completed', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000006';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, lastHeartbeatAt: new Date().toISOString() }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['stage']).toBe('plan');
    expect(row!['completedAt']).toBeNull();
  });

  it('merges partial running cycle.json with live sprint and itemResult agents', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000009';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, stage: 'run', cost: { totalUsd: 5 } }),
    );
    writeFileSync(join(dir, 'sprint-link.json'), JSON.stringify({ sprintVersion: '10.38.0' }));
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ type: 'sprint.assigned', sprintVersion: '10.38.0', at: new Date().toISOString() }),
        JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }),
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

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['stage']).toBe('execute');
    expect(row!['status']).toBe('running');
    expect(row!['sprintVersion']).toBe('10.38.0');
    expect(row!['completedAt']).toBeNull();
    expect(row!['agents']).toEqual(['yaml-doctor']);
  });

  it('populates agents from both agentRuns and itemResults in the same phase file', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000011';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }) + '\n',
    );
    mkdirSync(join(dir, 'phases'), { recursive: true });
    writeFileSync(
      join(dir, 'phases', 'execute.json'),
      JSON.stringify({
        costUsd: 0.2,
        agentRuns: [{ agentId: 'route-engineer' }],
        itemResults: [{ agentId: 'test-author' }],
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['agents']).toEqual(['route-engineer', 'test-author']);
  });

  it('lets terminal cycle session status override partial running cycle.json', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000010';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: id, stage: 'run', cost: { totalUsd: 5 } }),
    );
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'execute', at: new Date().toISOString() }) + '\n',
    );
    sessionFixture = {
      cycleId: id,
      pid: 1234,
      pgid: 1234,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: '2026-05-25T01:00:00.000Z',
      lastSeenAt: '2026-05-25T01:05:00.000Z',
      status: 'killed',
    };

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['stage']).toBe('killed');
  });

  it('includes agents: [] in in-progress path when no phases written yet', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000005';
    const dir = makeCycleDir(id);
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ type: 'phase.start', phase: 'plan', at: new Date().toISOString() }) + '\n',
    );
    // No phases directory yet

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(Array.isArray(row!['agents'])).toBe(true);
    expect(row!['agents']).toEqual([]);
  });

  it('uses agent-prs ledger URL when cycle.json has no cycle-level PR', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000007';
    const dir = makeCycleDir(id);
    writeCycleJson(id, dir, { pr: { url: null, number: null, draft: false } });
    writeFileSync(join(dir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 99,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/99',
        branch: 'codex/agent-test',
        status: 'open',
        openedAt: '2026-05-19T18:56:08.691Z',
      },
    ]));

    const listRes = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(listRes.statusCode).toBe(200);
    const rows = listRes.json().cycles as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['cycleId'] === id);
    expect(row).toBeDefined();
    expect(row!['prUrl']).toBe('https://github.com/seandonvaughan/AgentForge/pull/99');

    const detailRes = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json() as Record<string, unknown>;
    expect(detail['prUrl']).toBe('https://github.com/seandonvaughan/AgentForge/pull/99');
    expect(detail['pr']).toMatchObject({
      url: 'https://github.com/seandonvaughan/AgentForge/pull/99',
      number: 99,
      source: 'agent-prs',
    });
  });

  it('uses the latest retry PR from the agent-prs ledger', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000008';
    const dir = makeCycleDir(id);
    writeCycleJson(id, dir, { pr: { url: null, number: null, draft: false } });
    writeFileSync(join(dir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 102,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/102',
        branch: 'codex/agent-test',
        status: 'open',
        openedAt: '2026-05-20T00:54:02.427Z',
      },
      {
        prNumber: 103,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/103',
        branch: 'codex/agent-test-retry-1',
        status: 'open',
        openedAt: '2026-05-20T01:01:07.957Z',
      },
    ]));

    const detailRes = await app.inject({ method: 'GET', url: `/api/v5/cycles/${id}` });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json() as Record<string, unknown>;
    expect(detail['prUrl']).toBe('https://github.com/seandonvaughan/AgentForge/pull/103');
    expect(detail['pr']).toMatchObject({
      url: 'https://github.com/seandonvaughan/AgentForge/pull/103',
      number: 103,
      source: 'agent-prs',
    });
  });
});
