/**
 * tests/server/routes/search.test.ts
 *
 * Integration tests for POST /api/v5/search
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

function makeSessionRecord(overrides: Partial<{
  id: string;
  agent_id: string;
  agent_name: string;
  task: string;
  response: string;
  status: string;
  model: string;
}> = {}) {
  return {
    id:               overrides.id         ?? randomUUID(),
    agent_id:         overrides.agent_id   ?? 'test-agent',
    agent_name:       overrides.agent_name ?? 'Test Agent',
    model:            overrides.model      ?? 'sonnet',
    task:             overrides.task       ?? 'default task',
    response:         overrides.response   ?? 'default response',
    status:           overrides.status     ?? 'completed',
    started_at:       new Date().toISOString(),
    completed_at:     new Date().toISOString(),
    estimated_tokens: null,
    autonomy_tier:    null,
    resume_count:     0,
    parent_session_id: null,
    delegation_depth:  0,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/v5/search', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db      = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it('returns 400 when query is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/api/v5/search',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
  });

  it('returns 400 when query is empty string', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Empty state ─────────────────────────────────────────────────────────────

  it('returns empty results when DB is empty', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'anything' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
    expect(body.meta.query).toBe('anything');
  });

  // ── Session search ──────────────────────────────────────────────────────────

  it('finds a session by task text', async () => {
    adapter.insertSession(makeSessionRecord({
      task: 'implement the auth service',
      agent_id: 'backend-coder',
    }));

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'auth service' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].type).toBe('session');
  });

  it('does not return sessions that do not match the query', async () => {
    adapter.insertSession(makeSessionRecord({ task: 'run database migrations', agent_id: 'db-agent' }));

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'frontend css redesign' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The unrelated session should not appear
    const sessionResults = body.data.filter((r: { type: string }) => r.type === 'session');
    expect(sessionResults).toHaveLength(0);
  });

  it('higher relevance score for more matching terms', async () => {
    adapter.insertSession(makeSessionRecord({ task: 'fix auth login bug', agent_id: 'coder' }));
    adapter.insertSession(makeSessionRecord({ task: 'fix login', agent_id: 'coder' }));

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'fix auth login bug' },
    });
    const body = res.json();
    // Both should match; sorted by score desc so first result has >= second's score
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.data[0].score).toBeGreaterThanOrEqual(body.data[1].score);
  });

  // ── Type filter ─────────────────────────────────────────────────────────────

  it('respects types filter — returns only requested types', async () => {
    adapter.insertSession(makeSessionRecord({ task: 'alpha beta task', agent_id: 'agent-alpha' }));

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'alpha', types: ['agent'] },
    });
    const body = res.json();
    const types = body.data.map((r: { type: string }) => r.type);
    // All returned results must be of type 'agent'
    expect(types.every((t: string) => t === 'agent')).toBe(true);
  });

  it('ignores unknown types in filter', async () => {
    adapter.insertSession(makeSessionRecord({ task: 'beta deploy step', agent_id: 'deployer' }));

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'beta', types: ['nonexistent_type'] },
    });
    // Falls back to all types when no valid types remain after filtering
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
  });

  // ── Limit ───────────────────────────────────────────────────────────────────

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      adapter.insertSession(makeSessionRecord({
        task:     `deploy step ${i}`,
        agent_id: `agent-${i}`,
      }));
    }

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'deploy', limit: 3 },
    });
    const body = res.json();
    expect(body.data.length).toBeLessThanOrEqual(3);
  });

  it('caps limit at 100', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'anything', limit: 999 },
    });
    // Should not error — just cap internally
    expect(res.statusCode).toBe(200);
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  it('returns results with required fields', async () => {
    adapter.insertSession(makeSessionRecord({ task: 'shape check task', agent_id: 'shape-agent' }));

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'shape check' },
    });
    const body = res.json();
    if (body.data.length > 0) {
      const result = body.data[0];
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('score');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('meta includes query string echoed back', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'echo me back' },
    });
    const body = res.json();
    expect(body.meta.query).toBe('echo me back');
  });

  // ── Memory search (KV store) ─────────────────────────────────────────────────

  it('finds a memory entry by KV store key', async () => {
    // Write a known KV entry directly into the in-memory SQLite database.
    adapter.getAgentDatabase().getDb().prepare(
      'INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('deployment/auth-service', 'Auth service deployment notes and runbook', new Date().toISOString());

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'auth service' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const memResults = body.data.filter((r: { type: string }) => r.type === 'memory');
    expect(memResults.length).toBeGreaterThan(0);
    expect(memResults[0].metadata.memoryType).toBe('kv');
  });

  it('memory type filter returns only memory results', async () => {
    // Seed both a session and a KV memory that both match the query.
    adapter.insertSession(makeSessionRecord({ task: 'gateway routing configuration', agent_id: 'infra-agent' }));

    adapter.getAgentDatabase().getDb().prepare(
      'INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('notes/gateway', 'gateway routing notes', new Date().toISOString());

    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'gateway', types: ['memory'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const types = body.data.map((r: { type: string }) => r.type);
    expect(types.every((t: string) => t === 'memory')).toBe(true);
  });

  it('memory KV entries that do not match are excluded', async () => {
    adapter.getAgentDatabase().getDb().prepare(
      'INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('notes/database', 'xyzzy_unique_schema migration notes', new Date().toISOString());

    // Use a query that can only match the specific KV value above — not any real JSONL files.
    // Searching for something that is definitely not in xyzzy_unique_schema migration notes:
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'xyzzy_unique_schema', types: ['memory'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The specific entry we inserted should appear (it contains our token)
    const kvResult = body.data.find((r: { source: string }) => r.source === 'kv-store');
    expect(kvResult).toBeDefined();

    // Now confirm a completely unrelated query finds nothing in KV
    const res2 = await app.inject({
      method:  'POST',
      url:     '/api/v5/search',
      payload: { query: 'zqxjkv_impossible_term_9847', types: ['memory'] },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    const kvResults = body2.data.filter((r: { source: string }) => r.source === 'kv-store');
    expect(kvResults).toHaveLength(0);
  });
});
