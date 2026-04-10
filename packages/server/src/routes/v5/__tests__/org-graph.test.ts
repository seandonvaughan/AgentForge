/**
 * Integration tests for GET /api/v5/org-graph.
 *
 * Verifies that the route reads real YAML files from
 * <projectRoot>/.agentforge/agents/*.yaml, extracts delegation edges from
 * collaboration.can_delegate_to / collaboration.reports_to, and returns the
 * correct { data: { nodes, edges }, meta } shape.
 *
 * All tests are hermetic — they write to isolated tmp dirs so CI never touches
 * the real project files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerV5 } from '../../../server.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-org-graph-'));
  tmpDirs.push(dir);
  return dir;
}

function makeAgentsDir(root: string): string {
  const agentsDir = join(root, '.agentforge', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  return agentsDir;
}

// ── Shape tests ────────────────────────────────────────────────────────────

describe('GET /api/v5/org-graph — response shape', () => {
  it('returns 200 with { data: { nodes, edges }, meta } when no agents exist', async () => {
    const projectRoot = makeTmpRoot(); // no .agentforge dir at all
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { nodes: unknown[]; edges: unknown[] }; meta: { total: number; edgeCount: number } }>();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data.nodes)).toBe(true);
    expect(Array.isArray(body.data.edges)).toBe(true);
    expect(body.data.nodes).toHaveLength(0);
    expect(body.data.edges).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.edgeCount).toBe(0);
  });

  it('meta.total equals nodes.length', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'ceo.yaml'), 'name: CEO\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'cto.yaml'), 'name: CTO\nmodel: opus\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { nodes: { id: string }[] }; meta: { total: number } }>();
    expect(body.meta.total).toBe(body.data.nodes.length);
  });

  it('meta includes timestamp', async () => {
    const projectRoot = makeTmpRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ meta: { timestamp: string } }>();
    expect(typeof body.meta.timestamp).toBe('string');
    expect(new Date(body.meta.timestamp).getTime()).toBeGreaterThan(0);
  });
});

// ── Node tests ─────────────────────────────────────────────────────────────

describe('GET /api/v5/org-graph — nodes', () => {
  it('each node has id (string) and label (string)', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'architect.yaml'), 'name: Architect\nmodel: opus\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { nodes: { id: string; label: string; model?: string }[] } }>();
    expect(body.data.nodes).toHaveLength(1);
    const node = body.data.nodes[0]!;
    expect(node.id).toBe('architect');
    expect(node.label).toBe('Architect'); // name field from YAML becomes label
    expect(typeof node.label).toBe('string');
  });

  it('node label falls back to id when name is absent', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'unnamed-agent.yaml'), 'model: haiku\n'); // no name field

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { nodes: { id: string; label: string }[] } }>();
    const node = body.data.nodes[0]!;
    expect(node.label).toBe('unnamed-agent'); // id fallback
  });

  it('model is included when present in YAML', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'coder.yaml'), 'name: Coder\nmodel: haiku\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { nodes: { id: string; model?: string }[] } }>();
    expect(body.data.nodes[0]!.model).toBe('haiku');
  });

  it('node IDs are unique', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'alpha.yaml'), 'name: Alpha\nmodel: sonnet\n');
    writeFileSync(join(agentsDir, 'beta.yaml'), 'name: Beta\nmodel: haiku\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { nodes: { id: string }[] } }>();
    const ids = body.data.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('genesis and genesis-pipeline-dev are excluded from nodes', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'genesis.yaml'), 'name: Genesis\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'genesis-pipeline-dev.yaml'), 'name: Genesis Pipeline Dev\nmodel: haiku\n');
    writeFileSync(join(agentsDir, 'ceo.yaml'), 'name: CEO\nmodel: opus\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { nodes: { id: string }[] } }>();
    const ids = body.data.nodes.map(n => n.id);
    expect(ids).not.toContain('genesis');
    expect(ids).not.toContain('genesis-pipeline-dev');
    expect(ids).toContain('ceo');
  });

  it('skips malformed YAML files without crashing', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'good.yaml'), 'name: Good\nmodel: sonnet\n');
    writeFileSync(join(agentsDir, 'bad.yaml'), '{ invalid: yaml: [[[');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { nodes: { id: string }[] } }>();
    const ids = body.data.nodes.map(n => n.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('bad');
  });
});

// ── Edge tests ─────────────────────────────────────────────────────────────

describe('GET /api/v5/org-graph — edges', () => {
  it('builds edges from can_delegate_to (parent → child)', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'ceo.yaml'), [
      'name: CEO',
      'model: opus',
      'collaboration:',
      '  can_delegate_to: [cto, coo]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'cto.yaml'), 'name: CTO\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'coo.yaml'), 'name: COO\nmodel: sonnet\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: { from: string; to: string }[] } }>();
    const edges = body.data.edges;

    expect(edges.some(e => e.from === 'ceo' && e.to === 'cto')).toBe(true);
    expect(edges.some(e => e.from === 'ceo' && e.to === 'coo')).toBe(true);
  });

  it('builds edges from reports_to (fills gaps in can_delegate_to)', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'manager.yaml'), 'name: Manager\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'worker.yaml'), [
      'name: Worker',
      'model: haiku',
      'collaboration:',
      '  reports_to: manager',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: { from: string; to: string }[] } }>();
    expect(body.data.edges.some(e => e.from === 'manager' && e.to === 'worker')).toBe(true);
  });

  it('deduplicates edges from multiple sources', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    // Both can_delegate_to and reports_to would produce ceo→cto
    writeFileSync(join(agentsDir, 'ceo.yaml'), [
      'name: CEO',
      'model: opus',
      'collaboration:',
      '  can_delegate_to: [cto]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'cto.yaml'), [
      'name: CTO',
      'model: opus',
      'collaboration:',
      '  reports_to: ceo',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: { from: string; to: string }[] } }>();
    const ceoToCto = body.data.edges.filter(e => e.from === 'ceo' && e.to === 'cto');
    expect(ceoToCto).toHaveLength(1); // no duplicate
  });

  it('each edge has from and to as non-empty strings', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'parent.yaml'), [
      'name: Parent',
      'model: opus',
      'collaboration:',
      '  can_delegate_to: [child]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'child.yaml'), 'name: Child\nmodel: haiku\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: { from: string; to: string }[] } }>();
    for (const edge of body.data.edges) {
      expect(typeof edge.from).toBe('string');
      expect(typeof edge.to).toBe('string');
      expect(edge.from.length).toBeGreaterThan(0);
      expect(edge.to.length).toBeGreaterThan(0);
    }
  });

  it('edges to/from excluded agents are dropped', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'genesis.yaml'), [
      'name: Genesis',
      'model: opus',
      'collaboration:',
      '  can_delegate_to: [ceo]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'ceo.yaml'), [
      'name: CEO',
      'model: opus',
      'collaboration:',
      '  can_delegate_to: [genesis]',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: { from: string; to: string }[] } }>();
    for (const edge of body.data.edges) {
      expect(edge.from).not.toBe('genesis');
      expect(edge.to).not.toBe('genesis');
    }
  });

  it('reads supplementary edges from delegation.yaml', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'lead.yaml'), 'name: Lead\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'dev.yaml'), 'name: Dev\nmodel: haiku\n');

    const configDir = join(projectRoot, '.agentforge', 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'delegation.yaml'), 'lead:\n  - dev\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: { from: string; to: string }[] } }>();
    expect(body.data.edges.some(e => e.from === 'lead' && e.to === 'dev')).toBe(true);
  });

  it('meta.edgeCount equals edges.length', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = makeAgentsDir(projectRoot);
    writeFileSync(join(agentsDir, 'a.yaml'), [
      'name: A', 'model: opus', 'collaboration:', '  can_delegate_to: [b, c]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'b.yaml'), 'name: B\nmodel: sonnet\n');
    writeFileSync(join(agentsDir, 'c.yaml'), 'name: C\nmodel: haiku\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    const body = res.json<{ data: { edges: unknown[] }; meta: { edgeCount: number } }>();
    expect(body.meta.edgeCount).toBe(body.data.edges.length);
  });
});

// ── Real-project smoke test ────────────────────────────────────────────────

describe('GET /api/v5/org-graph — real project data', () => {
  it('returns non-empty nodes from the live .agentforge/agents directory', async () => {
    // Use the actual project root so we exercise real YAML files.
    // This test deliberately reads the checked-in agent files to confirm the
    // route works end-to-end against production data.
    const projectRoot = join(import.meta.dirname, '../../../../../../');
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { nodes: { id: string; label: string; model?: string }[]; edges: { from: string; to: string }[] };
      meta: { total: number; edgeCount: number };
    }>();

    // Confirm real agent YAMLs were found
    expect(body.data.nodes.length).toBeGreaterThan(0);

    // Known top-level agents must be present
    const ids = new Set(body.data.nodes.map(n => n.id));
    expect(ids.has('ceo')).toBe(true);

    // Every node must have a non-empty label (never falls back to empty string)
    for (const node of body.data.nodes) {
      expect(node.label.length).toBeGreaterThan(0);
    }

    // Edge count must match meta
    expect(body.meta.edgeCount).toBe(body.data.edges.length);
    expect(body.meta.total).toBe(body.data.nodes.length);

    // Delegation hierarchy should exist (ceo → cto, cto → architect, etc.)
    expect(body.data.edges.length).toBeGreaterThan(0);
  });
});
