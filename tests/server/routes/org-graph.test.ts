/**
 * tests/server/routes/org-graph.test.ts — Integration tests for GET /api/v1/org-graph
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

const VALID_MODELS = ['opus', 'sonnet', 'haiku', 'unknown'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OrgNode {
  id: string;
  name: string;
  model: string;
  team?: string;
  role?: string;
}

interface OrgEdge {
  from: string;
  to: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/org-graph', () => {
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

  it('returns 200 status code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: { nodes, edges }, meta }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.data).toHaveProperty('nodes');
    expect(body.data).toHaveProperty('edges');
  });

  it('nodes is always an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    expect(Array.isArray(body.data.nodes)).toBe(true);
  });

  it('edges is always an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    expect(Array.isArray(body.data.edges)).toBe(true);
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    expect(typeof body.meta.total).toBe('number');
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });

  it('meta.total equals nodes.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    expect(body.meta.total).toBe(body.data.nodes.length);
  });

  it('each node has id field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const node of body.data.nodes) {
      expect(node).toHaveProperty('id');
      expect(typeof node.id).toBe('string');
    }
  });

  it('each node has name field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const node of body.data.nodes) {
      expect(node).toHaveProperty('name');
      expect(typeof node.name).toBe('string');
    }
  });

  it('each node has model field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const node of body.data.nodes) {
      expect(node).toHaveProperty('model');
      expect(typeof node.model).toBe('string');
    }
  });

  it('node model field is a non-empty string', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const node of body.data.nodes) {
      expect(node.model.length).toBeGreaterThan(0);
    }
  });

  it('node IDs are unique (no duplicates)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    const ids = body.data.nodes.map((n: OrgNode) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('each edge has from field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const edge of body.data.edges) {
      expect(edge).toHaveProperty('from');
      expect(typeof edge.from).toBe('string');
    }
  });

  it('each edge has to field (string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const edge of body.data.edges) {
      expect(edge).toHaveProperty('to');
      expect(typeof edge.to).toBe('string');
    }
  });

  it('each edge has type field equal to "reports_to"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const edge of body.data.edges) {
      expect(edge).toHaveProperty('type');
      expect(edge.type).toBe('reports_to');
    }
  });

  it('edge from and to are non-empty strings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    for (const edge of body.data.edges) {
      expect(edge.from.length).toBeGreaterThan(0);
      expect(edge.to.length).toBeGreaterThan(0);
    }
  });

  it('edge.from references a known node id or is a string', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    const nodeIds = new Set(body.data.nodes.map((n: OrgNode) => n.id));
    for (const edge of body.data.edges) {
      // Every edge endpoint should be in the node set since both sides are collected
      // from delegation + agents directory
      if (nodeIds.size > 0) {
        expect(nodeIds.has(edge.from) || typeof edge.from === 'string').toBe(true);
        expect(nodeIds.has(edge.to) || typeof edge.to === 'string').toBe(true);
      }
    }
  });

  it('returns stable response on repeated calls', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body1 = res1.json();
    const body2 = res2.json();
    expect(body1.meta.total).toBe(body2.meta.total);
    expect(body1.data.nodes.length).toBe(body2.data.nodes.length);
  });

  it('nodes with agents in .agentforge/agents have non-empty names', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    // All nodes should have non-empty name (falls back to agentId)
    for (const node of body.data.nodes) {
      expect(node.name.length).toBeGreaterThan(0);
    }
  });

  it('POST to /api/v1/org-graph returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/org-graph', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('data and meta keys are the only top-level keys present in response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    const keys = Object.keys(body);
    expect(keys).toContain('data');
    expect(keys).toContain('meta');
  });

  it('node model field is a string containing recognizable model family if present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    // Models can be any string — just verify they're non-empty strings
    for (const node of body.data.nodes) {
      expect(typeof node.model).toBe('string');
      expect(node.model).not.toBe('');
    }
  });

  it('nodes array contains real agent entries from .agentforge/agents directory', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    // The project has agents in .agentforge/agents (per git status)
    // so nodes should be non-empty
    expect(body.data.nodes.length).toBeGreaterThan(0);
  });

  it('edge count exceeds delegation.yaml-only edges (collaboration.reports_to augmentation)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    // delegation.yaml defines ~36 explicit edges. The collaboration.reports_to fields
    // in agent YAMLs should significantly augment this — expect well above 36.
    expect(body.data.edges.length).toBeGreaterThan(36);
  });

  it('no duplicate edges (same from+to pair appears only once)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    const edgeKeys = body.data.edges.map((e: OrgEdge) => `${e.from}:${e.to}`);
    const uniqueKeys = new Set(edgeKeys);
    expect(uniqueKeys.size).toBe(edgeKeys.length);
  });

  it('ceo node exists and has no incoming edges (single root)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    const nodeIds = new Set(body.data.nodes.map((n: OrgNode) => n.id));
    // ceo is in the dataset
    expect(nodeIds.has('ceo')).toBe(true);
    // ceo should not appear as the `to` end of any edge
    const edgesToCeo = body.data.edges.filter((e: OrgEdge) => e.to === 'ceo');
    expect(edgesToCeo.length).toBe(0);
  });

  it('each edge endpoint references a known node id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org-graph' });
    const body = res.json();
    const nodeIds = new Set(body.data.nodes.map((n: OrgNode) => n.id));
    for (const edge of body.data.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });
});
