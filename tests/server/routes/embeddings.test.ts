/**
 * tests/server/routes/embeddings.test.ts
 *
 * Integration tests for POST /api/v5/embeddings/search
 *
 * The endpoint performs keyword-based search across sessions, kv_store, and
 * feedback.  These tests verify the contract the dashboard page depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postSearch(app: FastifyInstance, body: object) {
  return app.inject({
    method: 'POST',
    url: '/api/v5/embeddings/search',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v5/embeddings/search', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    db = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 for a valid query', async () => {
    const res = await postSearch(app, { query: 'hello' });
    expect(res.statusCode).toBe(200);
  });

  it('returns JSON with data array and meta', async () => {
    const res = await postSearch(app, { query: 'test' });
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).toHaveProperty('meta');
    expect(typeof body.meta.total).toBe('number');
  });

  it('returns empty data for blank query', async () => {
    const res = await postSearch(app, { query: '' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('returns empty data when nothing matches', async () => {
    const res = await postSearch(app, { query: 'xyzzy_no_match_ever' });
    const body = res.json();
    expect(body.data).toHaveLength(0);
  });

  it('finds a kv_store entry by value keyword', async () => {
    // Write a memory entry whose value contains a distinctive keyword
    adapter.writeFile('my-agent/state', 'deployment pipeline finished successfully');

    const res = await postSearch(app, { query: 'deployment pipeline' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);

    const hit = body.data.find((r: { type: string }) => r.type === 'memory');
    expect(hit).toBeDefined();
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.score).toBeLessThanOrEqual(1);
  });

  it('finds a kv_store entry by key keyword', async () => {
    adapter.writeFile('orchestrator/plan', 'nothing special here');

    const res = await postSearch(app, { query: 'orchestrator' });
    const body = res.json();
    const hit = body.data.find(
      (r: { source: string }) => r.source === 'orchestrator/plan'
    );
    expect(hit).toBeDefined();
  });

  it('finds a session by task keyword', async () => {
    adapter.insertSession({
      id: 'sess-001',
      agent_id: 'lead-architect',
      agent_name: 'Lead Architect',
      model: 'sonnet',
      task: 'refactor authentication module',
      response: null,
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      estimated_tokens: null,
      autonomy_tier: null,
      resume_count: 0,
      parent_session_id: null,
      delegation_depth: 0,
    });

    const res = await postSearch(app, { query: 'authentication' });
    const body = res.json();
    const hit = body.data.find((r: { id: string }) => r.id === 'sess-001');
    expect(hit).toBeDefined();
    expect(hit.type).toBe('session');
    expect(hit.source).toBe('lead-architect');
  });

  it('respects the limit parameter', async () => {
    // Write 10 kv entries all containing the search term
    for (let i = 0; i < 10; i++) {
      adapter.writeFile(`key-${i}`, `common keyword present item ${i}`);
    }

    const res = await postSearch(app, { query: 'common keyword', limit: 3 });
    const body = res.json();
    expect(body.data.length).toBeLessThanOrEqual(3);
    // meta.total reflects all matches, not just the page
    expect(body.meta.total).toBeGreaterThanOrEqual(body.data.length);
  });

  it('sorts results by score descending', async () => {
    // One entry matches both query terms; another matches only one
    adapter.writeFile('strong-match', 'alpha beta gamma');
    adapter.writeFile('weak-match', 'alpha only');

    const res = await postSearch(app, { query: 'alpha beta' });
    const body = res.json();
    const scores: number[] = body.data.map((r: { score: number }) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it('each result has required SearchResult fields', async () => {
    adapter.writeFile('check-fields', 'some content to find');

    const res = await postSearch(app, { query: 'content' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);

    const result = body.data[0];
    expect(typeof result.content).toBe('string');
    expect(typeof result.score).toBe('number');
    // type and source are optional but should be present for kv_store hits
    expect(result.type).toBeDefined();
    expect(result.source).toBeDefined();
  });

  it('handles missing body gracefully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/embeddings/search',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(0);
  });
});
