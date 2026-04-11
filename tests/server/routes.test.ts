/**
 * tests/server/routes.test.ts — REST API endpoint tests for P0-5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../src/server/server.js';
import { AgentDatabase } from '../../src/db/database.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import type { SessionRow } from '../../src/db/database.js';
import type { CostRow } from '../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _sessionSeq = 0;

function makeSession(overrides: Partial<Omit<SessionRow, 'created_at'>> = {}): Omit<SessionRow, 'created_at'> {
  _sessionSeq++;
  const id = overrides.id ?? `sess-${_sessionSeq}`;
  return {
    id,
    agent_id: 'agent-a',
    agent_name: 'Agent A',
    model: 'claude-3-sonnet',
    task: `task-${_sessionSeq}`,
    response: null,
    status: 'completed',
    started_at: new Date(1700000000000 + _sessionSeq * 1000).toISOString(),
    completed_at: new Date(1700000005000 + _sessionSeq * 1000).toISOString(),
    estimated_tokens: null,
    autonomy_tier: 1,
    resume_count: 0,
    parent_session_id: null,
    delegation_depth: 0,
    ...overrides,
  };
}

function makeCost(overrides: Partial<CostRow> = {}): CostRow {
  _sessionSeq++;
  return {
    id: `cost-${_sessionSeq}`,
    session_id: null,
    agent_id: 'agent-a',
    model: 'claude-3-sonnet',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.01,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('REST API Routes', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let tmpRoot: string;

  beforeEach(async () => {
    _sessionSeq = 0;
    // Isolated temp project root — no .agentforge/agents YAML files, so the
    // agentsRoutes handler returns only session-derived agents in these tests.
    tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-routes-test-'));
    mkdirSync(join(tmpRoot, '.agentforge', 'agents'), { recursive: true });
    db = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter, projectRoot: tmpRoot });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/sessions
  // -------------------------------------------------------------------------

  describe('GET /api/v1/sessions', () => {
    it('returns empty data array when no sessions exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    it('returns sessions with default meta (limit 50, offset 0)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
      const body = res.json();
      expect(body.meta.limit).toBe(50);
      expect(body.meta.offset).toBe(0);
    });

    it('returns sessions sorted by created_at desc', async () => {
      adapter.insertSession(makeSession({ id: 'old-sess', task: 'first task' }));
      adapter.insertSession(makeSession({ id: 'new-sess', task: 'second task' }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      // Newer session should come first (sorted DESC)
      expect(body.data[0].id).toBe('new-sess');
      expect(body.data[1].id).toBe('old-sess');
    });

    it('filters sessions by agentId query param', async () => {
      adapter.insertSession(makeSession({ id: 's1', agent_id: 'agent-x' }));
      adapter.insertSession(makeSession({ id: 's2', agent_id: 'agent-y' }));
      adapter.insertSession(makeSession({ id: 's3', agent_id: 'agent-x' }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions?agentId=agent-x' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      for (const s of body.data) {
        expect(s.agent_id).toBe('agent-x');
      }
    });

    it('respects limit query param', async () => {
      for (let i = 0; i < 5; i++) {
        adapter.insertSession(makeSession());
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions?limit=2' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      expect(body.meta.limit).toBe(2);
      expect(body.meta.total).toBe(5);
    });

    it('filters sessions by status query param', async () => {
      adapter.insertSession(makeSession({ id: 'c1', status: 'completed' }));
      adapter.insertSession(makeSession({ id: 'f1', status: 'failed' }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions?status=failed' });
      const body = res.json();
      expect(body.data.length).toBe(1);
      expect(body.data[0].id).toBe('f1');
    });

    it('returns total count reflecting all matching sessions (not just page)', async () => {
      for (let i = 0; i < 10; i++) {
        adapter.insertSession(makeSession());
      }
      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions?limit=3' });
      const body = res.json();
      expect(body.meta.total).toBe(10);
      expect(body.data.length).toBe(3);
    });

    it('filters sessions by since date range', async () => {
      const oldDate = '2023-01-01T00:00:00.000Z';
      const newDate = '2025-01-01T00:00:00.000Z';
      const cutoffDate = '2024-01-01T00:00:00.000Z';

      // Insert using raw db to set created_at explicitly
      adapter.insertSession(makeSession({ id: 'old-sess' }));
      adapter.insertSession(makeSession({ id: 'new-sess' }));

      // Update created_at directly
      const db = adapter.getAgentDatabase().getDb();
      db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(oldDate, 'old-sess');
      db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(newDate, 'new-sess');

      const res = await app.inject({ method: 'GET', url: `/api/v1/sessions?since=${encodeURIComponent(cutoffDate)}` });
      const body = res.json();
      expect(body.data.length).toBe(1);
      expect(body.data[0].id).toBe('new-sess');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/sessions/:id
  // -------------------------------------------------------------------------

  describe('GET /api/v1/sessions/:id', () => {
    it('returns 404 for an unknown session id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions/no-such-id' });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBeDefined();
    });

    it('returns session with empty children when no delegations', async () => {
      adapter.insertSession(makeSession({ id: 'root-sess' }));
      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions/root-sess' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.id).toBe('root-sess');
      expect(body.data.children).toEqual([]);
    });

    it('returns delegation chain in children array', async () => {
      adapter.insertSession(makeSession({ id: 'parent', delegation_depth: 0 }));
      adapter.insertSession(makeSession({
        id: 'child-1',
        parent_session_id: 'parent',
        delegation_depth: 1,
      }));
      adapter.insertSession(makeSession({
        id: 'child-2',
        parent_session_id: 'parent',
        delegation_depth: 1,
      }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/sessions/parent' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.id).toBe('parent');
      expect(body.data.children.length).toBe(2);
      const childIds = body.data.children.map((c: SessionRow) => c.id);
      expect(childIds).toContain('child-1');
      expect(childIds).toContain('child-2');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/agents
  // -------------------------------------------------------------------------

  describe('GET /api/v1/agents', () => {
    it('returns empty data when no sessions exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    it('returns aggregated stats per agent', async () => {
      adapter.insertSession(makeSession({ agent_id: 'bot-1', status: 'completed' }));
      adapter.insertSession(makeSession({ agent_id: 'bot-1', status: 'failed' }));
      adapter.insertSession(makeSession({ agent_id: 'bot-2', status: 'completed' }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      expect(body.meta.total).toBe(2);

      const bot1 = body.data.find((a: { agentId: string }) => a.agentId === 'bot-1');
      expect(bot1).toBeDefined();
      expect(bot1.sessionCount).toBe(2);
      expect(bot1.successCount).toBe(1);
      expect(bot1.failureCount).toBe(1);
    });

    it('includes totalCostUsd from agent_costs table', async () => {
      adapter.insertSession(makeSession({ agent_id: 'cost-agent' }));
      adapter.insertCost(makeCost({ agent_id: 'cost-agent', cost_usd: 0.05 }));
      adapter.insertCost(makeCost({ agent_id: 'cost-agent', cost_usd: 0.10 }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      const body = res.json();
      const agent = body.data.find((a: { agentId: string }) => a.agentId === 'cost-agent');
      expect(agent).toBeDefined();
      expect(agent.totalCostUsd).toBeCloseTo(0.15, 5);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:id
  // -------------------------------------------------------------------------

  describe('GET /api/v1/agents/:id', () => {
    it('returns 404 for unknown agent id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/agents/ghost-agent' });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBeDefined();
    });

    it('returns agent summary with recentSessions', async () => {
      adapter.insertSession(makeSession({ id: 's1', agent_id: 'target-bot', status: 'completed' }));
      adapter.insertSession(makeSession({ id: 's2', agent_id: 'target-bot', status: 'completed' }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents/target-bot' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.agentId).toBe('target-bot');
      expect(body.data.sessionCount).toBe(2);
      expect(body.data.recentSessions.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/agents — YAML-backed agent listing
  // Verifies that agents defined in .agentforge/agents/*.yaml appear in the
  // listing even when they have zero sessions.
  // -------------------------------------------------------------------------

  describe('GET /api/v1/agents — YAML-backed listing', () => {
    function writeAgentYaml(agentId: string, content: string) {
      writeFileSync(join(tmpRoot, '.agentforge', 'agents', `${agentId}.yaml`), content, 'utf-8');
    }

    it('returns YAML-defined agents with zero sessions', async () => {
      writeAgentYaml('lead-architect', [
        'name: Lead Architect',
        'model: opus',
        'description: >',
        '  Cross-team technical design authority.',
      ].join('\n'));

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      const agent = body.data.find((a: { agentId: string }) => a.agentId === 'lead-architect');
      expect(agent).toBeDefined();
      expect(agent.name).toBe('Lead Architect');
      expect(agent.model).toBe('opus');
      expect(agent.sessionCount).toBe(0);
    });

    it('returns multiple YAML-defined agents sorted alphabetically', async () => {
      writeAgentYaml('sprint-planner', 'name: Sprint Planner\nmodel: sonnet\n');
      writeAgentYaml('cto-assistant', 'name: CTO Assistant\nmodel: haiku\n');

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      const body = res.json();
      const ids = body.data.map((a: { agentId: string }) => a.agentId);
      expect(ids).toContain('sprint-planner');
      expect(ids).toContain('cto-assistant');
      // Alphabetical order: cto-assistant before sprint-planner
      expect(ids.indexOf('cto-assistant')).toBeLessThan(ids.indexOf('sprint-planner'));
    });

    it('merges session stats into YAML-defined agents', async () => {
      writeAgentYaml('qa-agent', 'name: QA Agent\nmodel: sonnet\n');
      adapter.insertSession(makeSession({ agent_id: 'qa-agent', status: 'completed' }));
      adapter.insertSession(makeSession({ agent_id: 'qa-agent', status: 'failed' }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      const body = res.json();
      const agent = body.data.find((a: { agentId: string }) => a.agentId === 'qa-agent');
      expect(agent).toBeDefined();
      expect(agent.name).toBe('QA Agent');
      expect(agent.sessionCount).toBe(2);
      expect(agent.successCount).toBe(1);
      expect(agent.failureCount).toBe(1);
    });

    it('normalises unknown model strings to sonnet', async () => {
      writeAgentYaml('weird-agent', 'name: Weird Agent\nmodel: gpt-4\n');

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      const body = res.json();
      const agent = body.data.find((a: { agentId: string }) => a.agentId === 'weird-agent');
      expect(agent).toBeDefined();
      expect(agent.model).toBe('sonnet');
    });

    it('skips malformed YAML files silently', async () => {
      writeAgentYaml('good-agent', 'name: Good Agent\nmodel: haiku\n');
      writeAgentYaml('broken-agent', 'BROKEN: [unclosed');

      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      const body = res.json();
      const ids = body.data.map((a: { agentId: string }) => a.agentId);
      expect(ids).toContain('good-agent');
      expect(ids).not.toContain('broken-agent');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v5/agents — v5 alias mirrors v1 listing
  // -------------------------------------------------------------------------

  describe('GET /api/v5/agents', () => {
    it('returns same shape as /api/v1/agents', async () => {
      writeFileSync(
        join(tmpRoot, '.agentforge', 'agents', 'ceo.yaml'),
        'name: CEO\nmodel: opus\ndescription: Chief Executive Officer\n',
        'utf-8',
      );

      const [v1Res, v5Res] = await Promise.all([
        app.inject({ method: 'GET', url: '/api/v1/agents' }),
        app.inject({ method: 'GET', url: '/api/v5/agents' }),
      ]);

      expect(v5Res.statusCode).toBe(200);
      const v1Body = v1Res.json();
      const v5Body = v5Res.json();
      expect(v5Body.data.length).toBe(v1Body.data.length);
      expect(v5Body.meta.total).toBe(v1Body.meta.total);

      const v5Agent = v5Body.data.find((a: { agentId: string }) => a.agentId === 'ceo');
      expect(v5Agent).toBeDefined();
      expect(v5Agent.name).toBe('CEO');
      expect(v5Agent.model).toBe('opus');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/costs
  // -------------------------------------------------------------------------

  describe('GET /api/v1/costs', () => {
    it('returns empty data when no costs exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/costs' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.meta.totalUsd).toBe(0);
    });

    it('returns cost totals grouped by agent (default)', async () => {
      adapter.insertCost(makeCost({ agent_id: 'agt-1', cost_usd: 0.02 }));
      adapter.insertCost(makeCost({ agent_id: 'agt-1', cost_usd: 0.03 }));
      adapter.insertCost(makeCost({ agent_id: 'agt-2', cost_usd: 0.10 }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/costs' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      expect(body.meta.totalUsd).toBeCloseTo(0.15, 5);

      const agt1 = body.data.find((c: { groupKey: string }) => c.groupKey === 'agt-1');
      expect(agt1.totalUsd).toBeCloseTo(0.05, 5);
      expect(agt1.rowCount).toBe(2);
    });

    it('groups costs by model when groupBy=model', async () => {
      adapter.insertCost(makeCost({ model: 'claude-3-sonnet', cost_usd: 0.01 }));
      adapter.insertCost(makeCost({ model: 'claude-3-opus', cost_usd: 0.05 }));
      adapter.insertCost(makeCost({ model: 'claude-3-sonnet', cost_usd: 0.01 }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/costs?groupBy=model' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      const sonnet = body.data.find((c: { groupKey: string }) => c.groupKey === 'claude-3-sonnet');
      expect(sonnet.rowCount).toBe(2);
    });

    it('filters costs by agentId when specified', async () => {
      adapter.insertCost(makeCost({ agent_id: 'only-me', cost_usd: 0.07 }));
      adapter.insertCost(makeCost({ agent_id: 'other', cost_usd: 0.99 }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/costs?agentId=only-me' });
      const body = res.json();
      expect(body.meta.totalUsd).toBeCloseTo(0.07, 5);
      expect(body.data.length).toBe(1);
      expect(body.data[0].groupKey).toBe('only-me');
    });

    it('groups costs by day when groupBy=day', async () => {
      adapter.insertCost(makeCost({
        cost_usd: 0.01,
        created_at: '2024-01-15T10:00:00.000Z',
      }));
      adapter.insertCost(makeCost({
        cost_usd: 0.02,
        created_at: '2024-01-15T14:00:00.000Z',
      }));
      adapter.insertCost(makeCost({
        cost_usd: 0.03,
        created_at: '2024-01-16T09:00:00.000Z',
      }));

      const res = await app.inject({ method: 'GET', url: '/api/v1/costs?groupBy=day' });
      const body = res.json();
      expect(body.data.length).toBe(2);
      const jan15 = body.data.find((c: { groupKey: string }) => c.groupKey === '2024-01-15');
      expect(jan15).toBeDefined();
      expect(jan15.rowCount).toBe(2);
      expect(jan15.totalUsd).toBeCloseTo(0.03, 5);
    });
  });
});
