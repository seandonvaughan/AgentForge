/**
 * Integration tests for POST /api/v5/search.
 *
 * Uses a temporary project root per test so results are fully hermetic —
 * real .agentforge data never leaks into assertions.
 *
 * Two test groups:
 *   1. No-adapter tests — cover agents, sprints, cycles, and memory.
 *   2. With-adapter tests — cover sessions (which require a WorkspaceAdapter).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerV5 } from '../../../server.js';
import { WorkspaceManager } from '@agentforge/core';

let createdApps: Array<{ close: () => Promise<void> }> = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  for (const app of createdApps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  createdApps = [];
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-search-'));
  tmpDirs.push(dir);
  return dir;
}

interface SearchResult {
  id: string;
  content: string;
  score: number;
  type: string;
  source: string;
  metadata?: Record<string, unknown>;
}

interface SearchResponse {
  data: SearchResult[];
  meta: { total: number; query: string };
}

describe('POST /api/v5/search', () => {
  it('returns 400 when query is missing', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { limit: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when query is blank', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty results when no data directories exist', async () => {
    const projectRoot = makeTmpRoot(); // no .agentforge dirs created
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'anything' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
    expect(body.meta.query).toBe('anything');
  });

  it('finds agents by YAML content', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(join(agentsDir, 'architect.yaml'), [
      'name: Architect',
      'role: system-designer',
      'description: Designs the monorepo architecture',
      'model: opus',
    ].join('\n'));

    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: Coder',
      'role: implementer',
      'description: Writes TypeScript code',
      'model: sonnet',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'monorepo', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    // Only the architect YAML contains "monorepo"
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.type).toBe('agent');
    expect(body.data[0]!.id).toBe('agent:architect');
    expect(body.data[0]!.score).toBeGreaterThan(0);
  });

  it('extracts description text from YAML block scalars (> notation)', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    // YAML with block scalar description (the common real-world format)
    writeFileSync(join(agentsDir, 'pipeline-runner.yaml'), [
      'name: Pipeline Runner',
      'role: executor',
      'description: >',
      '  Orchestrates the CI pipeline execution workflow.',
      '  Handles job scheduling and artifact collection.',
      'model: sonnet',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'pipeline', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.type).toBe('agent');
    // Content preview must NOT show the bare ">" — it should contain the actual description text
    expect(body.data[0]!.content).not.toContain('Description: >');
    expect(body.data[0]!.content).toContain('Pipeline');
  });

  it('finds sprint items by title and description', async () => {
    const projectRoot = makeTmpRoot();
    const sprintsDir = join(projectRoot, '.agentforge', 'sprints');
    mkdirSync(sprintsDir, { recursive: true });

    writeFileSync(join(sprintsDir, 'v1.0.json'), JSON.stringify({
      sprints: [
        {
          version: '1.0',
          items: [
            {
              id: 'item-1',
              title: 'Dashboard Search Fix',
              description: 'Fix the search endpoint so it returns real results',
              status: 'in-progress',
              tags: ['search', 'dashboard'],
            },
            {
              id: 'item-2',
              title: 'Agent Billing Report',
              description: 'Generate cost report per agent model',
              status: 'completed',
              tags: ['cost', 'billing'],
            },
          ],
        },
      ],
    }));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    // Should match item-1 by title
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'Dashboard Search', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const sprintResults = body.data.filter(r => r.type === 'sprint');
    expect(sprintResults.length).toBeGreaterThanOrEqual(1);
    // The "Dashboard Search Fix" item should rank first among sprint results
    expect(sprintResults[0]!.content).toContain('Dashboard Search Fix');
  });

  it('finds in-progress cycles via sprint-link.json fallback', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'test-cycle-abc123';
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });

    // No cycle.json — simulates an in-progress cycle
    writeFileSync(join(cycleDir, 'sprint-link.json'), JSON.stringify({
      sprintVersion: '2.5.0',
      assignedAt: '2026-01-01T00:00:00Z',
    }));
    writeFileSync(join(cycleDir, 'events.jsonl'), [
      JSON.stringify({ type: 'phase.started', phase: 'execute', ts: '2026-01-01T00:01:00Z' }),
      JSON.stringify({ type: 'agent.dispatched', agentId: 'coder', ts: '2026-01-01T00:02:00Z' }),
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'execute', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const cycleResults = body.data.filter(r => r.type === 'cycle');
    expect(cycleResults.length).toBeGreaterThanOrEqual(1);
    expect(cycleResults[0]!.id).toBe(`cycle:${cycleId}`);
    expect(cycleResults[0]!.metadata?.stage).toBe('in-progress');
  });

  it('finds completed cycles via cycle.json', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'done-cycle-xyz999';
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });

    writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify({
      cycleId,
      stage: 'completed',
      sprintVersion: '3.0.0',
      startedAt: '2026-02-01T00:00:00Z',
      pr: { url: 'https://github.com/org/repo/pull/42', number: 42 },
    }));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'completed', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const cycleResults = body.data.filter(r => r.type === 'cycle');
    expect(cycleResults.length).toBeGreaterThanOrEqual(1);
    expect(cycleResults[0]!.id).toBe(`cycle:${cycleId}`);
    expect(cycleResults[0]!.metadata?.prNumber).toBe(42);
  });

  it('finds memory entries in .jsonl files', async () => {
    const projectRoot = makeTmpRoot();
    const memoryDir = join(projectRoot, '.agentforge', 'memory');
    mkdirSync(memoryDir, { recursive: true });

    writeFileSync(join(memoryDir, 'gate-verdict.jsonl'), [
      JSON.stringify({ id: 'gv-1', type: 'gate-verdict', value: 'gate passed: all tests green', createdAt: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'gv-2', type: 'gate-verdict', value: 'gate failed: coverage below threshold', createdAt: '2026-01-02T00:00:00Z' }),
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'coverage', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const memoryResults = body.data.filter(r => r.type === 'memory');
    expect(memoryResults.length).toBeGreaterThanOrEqual(1);
    // The "coverage below threshold" entry should match
    const matched = memoryResults.find(r => r.content.includes('coverage'));
    expect(matched).toBeDefined();
  });

  it('filters results by types array', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    const sprintsDir = join(projectRoot, '.agentforge', 'sprints');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sprintsDir, { recursive: true });

    writeFileSync(join(agentsDir, 'runner.yaml'), 'name: Runner\ndescription: Runs tests for the project');
    writeFileSync(join(sprintsDir, 'v1.0.json'), JSON.stringify({
      sprints: [{ version: '1.0', items: [{ id: 'i1', title: 'Run CI', description: 'Runs the CI pipeline for the project', status: 'done' }] }],
    }));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'project', types: ['agent'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    // Only agent results should be returned (sprint filtered out)
    expect(body.data.every(r => r.type === 'agent')).toBe(true);
  });

  it('sorts results by score descending', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    // High-frequency match: "search" appears many times
    writeFileSync(join(agentsDir, 'search-specialist.yaml'), [
      'name: Search Specialist',
      'description: search search search search search expert in search systems',
    ].join('\n'));

    // Low-frequency match: "search" appears once
    writeFileSync(join(agentsDir, 'general.yaml'), [
      'name: General Agent',
      'description: handles search and other tasks',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'search', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    expect(body.data.length).toBe(2);
    // Higher score first
    expect(body.data[0]!.score).toBeGreaterThanOrEqual(body.data[1]!.score);
    expect(body.data[0]!.id).toBe('agent:search-specialist');
  });

  it('finds cycles in cycles-archived directory', async () => {
    const projectRoot = makeTmpRoot();
    const cycleId = 'archived-cycle-abc888';
    const cycleDir = join(projectRoot, '.agentforge', 'cycles-archived', cycleId);
    mkdirSync(cycleDir, { recursive: true });

    writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify({
      cycleId,
      stage: 'completed',
      sprintVersion: '7.2.0',
      startedAt: '2026-03-01T00:00:00Z',
      pr: { url: 'https://github.com/org/repo/pull/99', number: 99 },
    }));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'archived', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const cycleResults = body.data.filter(r => r.type === 'cycle');
    expect(cycleResults.length).toBeGreaterThanOrEqual(1);
    // The archived cycle should be found and flagged
    const found = cycleResults.find(r => r.id === `cycle:${cycleId}`);
    expect(found).toBeDefined();
    expect(found?.metadata?.isArchived).toBe(true);
    expect(found?.metadata?.prNumber).toBe(99);
  });

  it('finds cycles across both active and archived directories', async () => {
    const projectRoot = makeTmpRoot();

    // Active cycle — uses a distinctive sprint name so the query is unambiguous
    const activeCycleId = 'active-cycle-111';
    const activeDir = join(projectRoot, '.agentforge', 'cycles', activeCycleId);
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, 'cycle.json'), JSON.stringify({
      cycleId: activeCycleId,
      stage: 'completed',
      sprintVersion: 'fluxcapacitor',
    }));

    // Archived cycle — same distinctive sprint name so both match the query
    const archivedCycleId = 'archived-cycle-222';
    const archivedDir = join(projectRoot, '.agentforge', 'cycles-archived', archivedCycleId);
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, 'cycle.json'), JSON.stringify({
      cycleId: archivedCycleId,
      stage: 'completed',
      sprintVersion: 'fluxcapacitor',
    }));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    // Both cycles share sprintVersion "fluxcapacitor" — both should appear
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'fluxcapacitor', limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const cycleResults = body.data.filter(r => r.type === 'cycle');
    expect(cycleResults.length).toBe(2);
    const ids = cycleResults.map(r => r.id);
    expect(ids).toContain(`cycle:${activeCycleId}`);
    expect(ids).toContain(`cycle:${archivedCycleId}`);
    // Active cycle should not have isArchived flag
    const active = cycleResults.find(r => r.id === `cycle:${activeCycleId}`);
    expect(active?.metadata?.isArchived).toBe(false);
    // Archived cycle should be flagged
    const archived = cycleResults.find(r => r.id === `cycle:${archivedCycleId}`);
    expect(archived?.metadata?.isArchived).toBe(true);
  });

  it('respects the limit parameter', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    // Create 5 agents all containing "agent"
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(agentsDir, `agent-${i}.yaml`), `name: Agent ${i}\ndescription: This is agent number ${i}`);
    }

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'agent', limit: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    expect(body.data).toHaveLength(3);
    expect(body.meta.total).toBe(3);
  });
});

// ── Sessions search (requires WorkspaceAdapter) ───────────────────────────────
// Sessions are the only content type that requires a live SQLite adapter;
// all other types are filesystem-backed. These tests verify the adapter-enabled
// path works correctly end-to-end.

describe('POST /api/v5/search — sessions (with adapter)', () => {
  let managers: WorkspaceManager[] = [];

  afterEach(async () => {
    for (const app of createdApps) {
      try { await app.close(); } catch { /* ignore */ }
    }
    createdApps = [];
    for (const m of managers) {
      try { m.close(); } catch { /* ignore */ }
    }
    managers = [];
    for (const dir of tmpDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  it('finds sessions by agentId when adapter is present', async () => {
    const projectRoot = makeTmpRoot();
    const dataDir = join(projectRoot, '.agentforge', 'v5');
    mkdirSync(dataDir, { recursive: true });

    const manager = new WorkspaceManager({ dataDir });
    managers.push(manager);
    const { adapter } = await manager.getOrCreateDefaultWorkspace();

    // Seed a distinctive session
    const session = adapter.createSession({
      agentId: 'search-integration-tester',
      task: 'Validate the keyword search integration for the dashboard',
      model: 'claude-sonnet-4-6',
    });
    adapter.completeSession(session.id, 'completed', 0.005);

    const { app } = await createServerV5({ listen: false, projectRoot, adapter });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'integration-tester', limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const sessionResults = body.data.filter(r => r.type === 'session');
    expect(sessionResults.length).toBeGreaterThanOrEqual(1);
    expect(sessionResults[0]!.source).toBe('search-integration-tester');
    expect(sessionResults[0]!.metadata?.status).toBe('completed');
  });

  it('finds sessions by task text', async () => {
    const projectRoot = makeTmpRoot();
    const dataDir = join(projectRoot, '.agentforge', 'v5');
    mkdirSync(dataDir, { recursive: true });

    const manager = new WorkspaceManager({ dataDir });
    managers.push(manager);
    const { adapter } = await manager.getOrCreateDefaultWorkspace();

    adapter.createSession({
      agentId: 'coder',
      task: 'Refactor the authentication middleware to support OAuth2 flows',
      model: 'claude-sonnet-4-6',
    });
    adapter.createSession({
      agentId: 'researcher',
      task: 'Survey vector database options for semantic search',
      model: 'claude-sonnet-4-6',
    });

    const { app } = await createServerV5({ listen: false, projectRoot, adapter });
    createdApps.push(app);

    // Only the "authentication middleware" session should match
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'authentication middleware', limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const sessionResults = body.data.filter(r => r.type === 'session');
    expect(sessionResults.length).toBeGreaterThanOrEqual(1);
    const matched = sessionResults.find(r =>
      typeof r.content === 'string' && r.content.toLowerCase().includes('authentication'),
    );
    expect(matched).toBeDefined();
  });

  it('session results include required metadata fields', async () => {
    const projectRoot = makeTmpRoot();
    const dataDir = join(projectRoot, '.agentforge', 'v5');
    mkdirSync(dataDir, { recursive: true });

    const manager = new WorkspaceManager({ dataDir });
    managers.push(manager);
    const { adapter } = await manager.getOrCreateDefaultWorkspace();

    const sess = adapter.createSession({
      agentId: 'metadata-check-agent',
      task: 'Check that metadata fields are present in search results',
      model: 'claude-opus-4-5',
    });
    adapter.completeSession(sess.id, 'completed', 0.01);

    const { app } = await createServerV5({ listen: false, projectRoot, adapter });
    createdApps.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'metadata-check-agent', limit: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    const r = body.data.find(d => d.type === 'session');
    expect(r).toBeDefined();
    expect(r?.metadata).toMatchObject({
      status: expect.any(String),
      agent_id: 'metadata-check-agent',
    });
    expect(r?.score).toBeGreaterThan(0);
    expect(r?.score).toBeLessThanOrEqual(1);
  });

  it('session type filter restricts results to sessions only', async () => {
    const projectRoot = makeTmpRoot();
    const dataDir = join(projectRoot, '.agentforge', 'v5');
    mkdirSync(dataDir, { recursive: true });

    const manager = new WorkspaceManager({ dataDir });
    managers.push(manager);
    const { adapter } = await manager.getOrCreateDefaultWorkspace();

    adapter.createSession({
      agentId: 'filter-test-agent',
      task: 'Run filter tests for the search subsystem',
      model: 'claude-sonnet-4-6',
    });

    // Also create an agent YAML that matches the same query
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'filter-test-agent.yaml'), [
      'name: Filter Test Agent',
      'description: Agent used for filter test scenarios in search subsystem',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot, adapter });
    createdApps.push(app);

    // With types:['session'], only session results should come back
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/search',
      payload: { query: 'filter test', types: ['session'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SearchResponse>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every(r => r.type === 'session')).toBe(true);
  });
});
