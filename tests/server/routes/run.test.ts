/**
 * tests/server/routes/run.test.ts
 *
 * Integration tests for /api/v5/run and /api/v5/run/history.
 * The POST /api/v5/run test verifies the response envelope shape and
 * validation without spawning a real Claude subprocess — the subprocess
 * failure is handled gracefully by the route (claude CLI may not be
 * present in CI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<{
  id: string;
  agent_id: string;
  agent_name: string;
  task: string;
  response: string;
  status: string;
  model: string;
  started_at: string;
}> = {}) {
  return {
    id:               overrides.id         ?? randomUUID(),
    agent_id:         overrides.agent_id   ?? 'test-agent',
    agent_name:       overrides.agent_name ?? 'Test Agent',
    model:            overrides.model      ?? 'sonnet',
    task:             overrides.task       ?? 'do something useful',
    response:         overrides.response   ?? 'task complete',
    status:           overrides.status     ?? 'completed',
    started_at:       overrides.started_at ?? new Date().toISOString(),
    completed_at:     new Date().toISOString(),
    estimated_tokens: null,
    autonomy_tier:    null,
    resume_count:     0,
    parent_session_id: null,
    delegation_depth:  0,
  };
}

// ---------------------------------------------------------------------------
// Suite — GET /api/v5/run/history
// ---------------------------------------------------------------------------

describe('GET /api/v5/run/history', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db      = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
  });

  afterEach(async () => {
    await app.close();
    adapter.getAgentDatabase().getDb().close();
  });

  it('returns empty data array when no sessions exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/run/history' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toHaveProperty('data');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toHaveLength(0);
  });

  it('returns sessions as RunHistory entries with correct shape', async () => {
    const s1 = makeSession({ agent_id: 'coder', task: 'write tests', status: 'completed', response: 'done' });
    const s2 = makeSession({ agent_id: 'debugger', task: 'fix bug', status: 'failed' });
    adapter.insertSession(s1);
    adapter.insertSession(s2);

    const res = await app.inject({ method: 'GET', url: '/api/v5/run/history' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toHaveLength(2);

    // Verify RunHistory shape for first entry (most recent first)
    const first = json.data[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('agentId');
    expect(first).toHaveProperty('task');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('startedAt');
    expect(first).toHaveProperty('sessionId');
    expect(first.agentId).toBe(first.sessionId === s2.id ? 'debugger' : 'coder');
  });

  it('maps session status correctly to RunHistory status values', async () => {
    const completed = makeSession({ status: 'completed' });
    const failed    = makeSession({ status: 'failed' });
    const running   = makeSession({ status: 'running' });
    adapter.insertSession(completed);
    adapter.insertSession(failed);
    adapter.insertSession(running);

    const res = await app.inject({ method: 'GET', url: '/api/v5/run/history' });
    const json = res.json();
    const statuses = new Set(json.data.map((r: { status: string }) => r.status));
    expect(statuses.has('completed')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
    expect(statuses.has('running')).toBe(true);
  });

  it('includes response as output when present', async () => {
    const s = makeSession({ response: 'the output text' });
    adapter.insertSession(s);

    const res = await app.inject({ method: 'GET', url: '/api/v5/run/history' });
    const json = res.json();
    expect(json.data[0].output).toBe('the output text');
  });

  it('does not expose output field when session has no response', async () => {
    // Manually insert with null response via the underlying DB
    adapter.getAgentDatabase().getDb().prepare(`
      INSERT INTO sessions (id, agent_id, agent_name, model, task, response, status, started_at, completed_at, estimated_tokens, autonomy_tier, resume_count, parent_session_id, delegation_depth, created_at)
      VALUES (?, 'coder', 'Coder', 'sonnet', 'task', NULL, 'running', ?, NULL, NULL, NULL, 0, NULL, 0, ?)
    `).run(randomUUID(), new Date().toISOString(), new Date().toISOString());

    const res = await app.inject({ method: 'GET', url: '/api/v5/run/history' });
    const json = res.json();
    const entry = json.data[0];
    expect(entry.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite — POST /api/v5/run
// ---------------------------------------------------------------------------

describe('POST /api/v5/run', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db      = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
  });

  afterEach(async () => {
    await app.close();
    adapter.getAgentDatabase().getDb().close();
  });

  it('returns 400 when agentId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { task: 'do something' },
    });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json).toHaveProperty('error');
  });

  it('returns 400 when task is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when both agentId and task are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 202 Accepted with sessionId when agentId and task are provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'write a hello world function' },
    });
    // 202 Accepted — the run is dispatched asynchronously
    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json).toHaveProperty('data');
    expect(json.data).toHaveProperty('sessionId');
    expect(json.data).toHaveProperty('agentId', 'coder');
    expect(json.data).toHaveProperty('status', 'running');
    expect(json.data).toHaveProperty('startedAt');
    // sessionId must be a valid UUID
    expect(json.data.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('returns a unique sessionId for each dispatch', async () => {
    const r1 = await app.inject({
      method: 'POST', url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'task one' },
    });
    const r2 = await app.inject({
      method: 'POST', url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'task two' },
    });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    expect(r1.json().data.sessionId).not.toBe(r2.json().data.sessionId);
  });
});
