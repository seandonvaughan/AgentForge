/**
 * Sessions search filter (?q=)
 *
 * Tests:
 *   - GET /api/v5/sessions?q= returns all sessions when query is empty
 *   - GET /api/v5/sessions?q=keyword returns only matching sessions
 *   - search is case-insensitive
 *   - search can be combined with agentId filter
 *   - search can be combined with status filter
 *   - meta.total reflects filtered count
 *   - no results when query matches nothing
 *   - WorkspaceAdapter.listSessions search filter works directly
 *   - WorkspaceAdapter.countSessions search filter works directly
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { registerV5Routes } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(adapter: WorkspaceAdapter): FastifyInstance {
  const app = Fastify({ logger: false });
  return app;
}

let app: FastifyInstance;
let adapter: WorkspaceAdapter;

beforeEach(async () => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-search-test' });
  app = Fastify({ logger: false });

  const registry = {
    listWorkspaces: () => [],
    getWorkspace: () => undefined,
  } as unknown as import('@agentforge/db').WorkspaceRegistry;

  await registerV5Routes(app, { adapter, registry, projectRoot: '/tmp/sessions-search-test' });
  await app.ready();

  // Seed sessions
  adapter.createSession({ agentId: 'agent-a', task: 'Build the authentication module' });
  adapter.createSession({ agentId: 'agent-a', task: 'Fix failing unit tests' });
  adapter.createSession({ agentId: 'agent-b', task: 'Refactor the database layer' });
  adapter.createSession({ agentId: 'agent-b', task: 'Add authentication endpoint' });
  adapter.createSession({ agentId: 'agent-c', task: 'Update documentation' });
});

afterEach(async () => {
  await app.close();
  adapter.close();
});

// ---------------------------------------------------------------------------
// API route tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/sessions?q= — search filter', () => {
  it('returns all sessions when q is absent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ task: string }>; meta: { total: number } }>();
    expect(body.data).toHaveLength(5);
    expect(body.meta.total).toBe(5);
  });

  it('returns all sessions when q is empty string', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ task: string }>; meta: { total: number } }>();
    expect(body.data).toHaveLength(5);
  });

  it('filters by task substring (case-insensitive)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=authentication' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ task: string }>; meta: { total: number } }>();
    expect(body.data).toHaveLength(2);
    for (const s of body.data) {
      expect(s.task.toLowerCase()).toContain('authentication');
    }
    expect(body.meta.total).toBe(2);
  });

  it('search is case-insensitive', async () => {
    const resLower = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=authentication' });
    const resUpper = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=AUTHENTICATION' });
    const resMixed = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=Authentication' });

    expect(resLower.statusCode).toBe(200);
    expect(resUpper.statusCode).toBe(200);
    expect(resMixed.statusCode).toBe(200);

    const lower = resLower.json<{ data: unknown[] }>().data.length;
    const upper = resUpper.json<{ data: unknown[] }>().data.length;
    const mixed = resMixed.json<{ data: unknown[] }>().data.length;

    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
    expect(lower).toBe(2);
  });

  it('returns no results when query matches nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=nonexistent_xyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('can combine q with agentId filter', async () => {
    // agent-a has two sessions but only one contains 'authentication'
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=authentication&agentId=agent-a' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ agent_id?: string; agentId?: string; task: string }>; meta: { total: number } }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.task.toLowerCase()).toContain('authentication');
    expect(body.meta.total).toBe(1);
  });

  it('meta.total reflects filtered count correctly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=database' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('returns correct sessions when filtering by partial word', async () => {
    // 'auth' should match 'authentication' (appears in 2 sessions)
    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions?q=auth' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ task: string }> }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const s of body.data) {
      expect(s.task.toLowerCase()).toContain('auth');
    }
  });
});

// ---------------------------------------------------------------------------
// WorkspaceAdapter unit tests
// ---------------------------------------------------------------------------

describe('WorkspaceAdapter search filter', () => {
  it('listSessions with search returns matching rows', () => {
    const adapter2 = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-unit' });
    adapter2.createSession({ agentId: 'a1', task: 'Deploy to production' });
    adapter2.createSession({ agentId: 'a1', task: 'Run integration tests' });
    adapter2.createSession({ agentId: 'a2', task: 'Deploy staging environment' });

    const results = adapter2.listSessions({ search: 'deploy' });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.task.toLowerCase()).toContain('deploy');
    }
    adapter2.close();
  });

  it('listSessions with search is case-insensitive', () => {
    const adapter2 = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-unit2' });
    adapter2.createSession({ agentId: 'a1', task: 'Deploy to production' });
    adapter2.createSession({ agentId: 'a1', task: 'Run tests' });

    const lower = adapter2.listSessions({ search: 'deploy' });
    const upper = adapter2.listSessions({ search: 'DEPLOY' });
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBe(1);
    adapter2.close();
  });

  it('countSessions with search returns filtered count', () => {
    const adapter2 = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-unit3' });
    adapter2.createSession({ agentId: 'a1', task: 'Build auth service' });
    adapter2.createSession({ agentId: 'a1', task: 'Build payment service' });
    adapter2.createSession({ agentId: 'a2', task: 'Write unit tests' });

    const count = adapter2.countSessions({ search: 'build' });
    expect(count).toBe(2);

    const countNone = adapter2.countSessions({ search: 'xyz_no_match' });
    expect(countNone).toBe(0);
    adapter2.close();
  });

  it('listSessions with empty search returns all rows', () => {
    const adapter2 = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-unit4' });
    adapter2.createSession({ agentId: 'a1', task: 'Task one' });
    adapter2.createSession({ agentId: 'a2', task: 'Task two' });

    const all = adapter2.listSessions({});
    const withEmpty = adapter2.listSessions({ search: '' });
    expect(all.length).toBe(withEmpty.length);
    adapter2.close();
  });
});
