/**
 * Unit tests for the org +page.server.ts buildOrgGraph() helper.
 *
 * Verifies that the SSR-side data loading reads real agent YAML files,
 * extracts delegation edges from collaboration.can_delegate_to /
 * collaboration.reports_to, and returns the correct { nodes, edges } shape.
 *
 * All tests are hermetic — they write to isolated tmp dirs so they never
 * touch the real project files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildOrgGraph } from '../routes/org/+page.server.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-org-ssr-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeAgentsDir(): string {
  const dir = join(tmpRoot, '.agentforge', 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfigDir(): string {
  const dir = join(tmpRoot, '.agentforge', 'config');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Shape tests ───────────────────────────────────────────────────────────────

describe('buildOrgGraph — response shape', () => {
  it('returns { nodes, edges } arrays when no .agentforge dir exists', () => {
    const result = buildOrgGraph(tmpRoot);
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns nodes for each non-excluded agent YAML', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'alpha.yaml'), 'name: Alpha\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'beta.yaml'), 'name: Beta\nmodel: haiku\n');

    const result = buildOrgGraph(tmpRoot);
    expect(result.nodes).toHaveLength(2);
    const ids = result.nodes.map(n => n.id);
    expect(ids).toContain('alpha');
    expect(ids).toContain('beta');
  });
});

// ── Node shape ────────────────────────────────────────────────────────────────

describe('buildOrgGraph — node fields', () => {
  it('each node has id (filename without extension) and label (name field)', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'architect.yaml'), 'name: Architect\nmodel: sonnet\n');

    const result = buildOrgGraph(tmpRoot);
    expect(result.nodes).toHaveLength(1);
    const n = result.nodes[0]!;
    expect(n.id).toBe('architect');
    expect(n.label).toBe('Architect');
  });

  it('label falls back to id when name is missing', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'unnamed.yaml'), 'model: haiku\n');

    const result = buildOrgGraph(tmpRoot);
    expect(result.nodes[0]!.label).toBe('unnamed');
  });

  it('model field is populated from YAML', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'coder.yaml'), 'name: Coder\nmodel: haiku\n');

    const { nodes } = buildOrgGraph(tmpRoot);
    expect(nodes[0]!.model).toBe('haiku');
  });

  it('genesis and genesis-pipeline-dev are excluded from nodes', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'genesis.yaml'), 'name: Genesis\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'genesis-pipeline-dev.yaml'), 'name: GPD\nmodel: haiku\n');
    writeFileSync(join(agentsDir, 'ceo.yaml'), 'name: CEO\nmodel: opus\n');

    const { nodes } = buildOrgGraph(tmpRoot);
    const ids = nodes.map(n => n.id);
    expect(ids).not.toContain('genesis');
    expect(ids).not.toContain('genesis-pipeline-dev');
    expect(ids).toContain('ceo');
  });

  it('does not crash on malformed YAML — uses regex-based parser, falls back gracefully', () => {
    // The SSR YAML parser is intentionally lenient (no js-yaml dep):
    // it uses regex line-scanning and just yields whatever fields it can find.
    // Files that are syntactically invalid still produce a node (with id fallback).
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'good.yaml'), 'name: Good\nmodel: sonnet\n');
    writeFileSync(join(agentsDir, 'bad.yaml'), '{ invalid: yaml: [[[');

    // Must not throw
    expect(() => buildOrgGraph(tmpRoot)).not.toThrow();
    const { nodes } = buildOrgGraph(tmpRoot);
    // The 'good' agent must always be present with correct label
    const good = nodes.find(n => n.id === 'good');
    expect(good).toBeDefined();
    expect(good!.label).toBe('Good');
  });
});

// ── Edge extraction ───────────────────────────────────────────────────────────

describe('buildOrgGraph — edges', () => {
  it('builds edges from collaboration.can_delegate_to (block sequence)', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'ceo.yaml'), [
      'name: CEO', 'model: opus',
      'collaboration:',
      '  can_delegate_to:',
      '    - cto',
      '    - coo',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'cto.yaml'), 'name: CTO\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'coo.yaml'), 'name: COO\nmodel: sonnet\n');

    const { edges } = buildOrgGraph(tmpRoot);
    expect(edges.some(e => e.from === 'ceo' && e.to === 'cto')).toBe(true);
    expect(edges.some(e => e.from === 'ceo' && e.to === 'coo')).toBe(true);
  });

  it('builds edges from collaboration.can_delegate_to (inline list)', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'lead.yaml'), [
      'name: Lead', 'model: opus',
      'collaboration:',
      '  can_delegate_to: [worker1, worker2]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'worker1.yaml'), 'name: W1\nmodel: haiku\n');
    writeFileSync(join(agentsDir, 'worker2.yaml'), 'name: W2\nmodel: haiku\n');

    const { edges } = buildOrgGraph(tmpRoot);
    expect(edges.some(e => e.from === 'lead' && e.to === 'worker1')).toBe(true);
    expect(edges.some(e => e.from === 'lead' && e.to === 'worker2')).toBe(true);
  });

  it('builds edges from collaboration.reports_to (fills gaps)', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'manager.yaml'), 'name: Manager\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'worker.yaml'), [
      'name: Worker', 'model: haiku',
      'collaboration:',
      '  reports_to: manager',
    ].join('\n'));

    const { edges } = buildOrgGraph(tmpRoot);
    expect(edges.some(e => e.from === 'manager' && e.to === 'worker')).toBe(true);
  });

  it('deduplicates edges from multiple sources', () => {
    const agentsDir = makeAgentsDir();
    // Both can_delegate_to and reports_to produce ceo→cto
    writeFileSync(join(agentsDir, 'ceo.yaml'), [
      'name: CEO', 'model: opus',
      'collaboration:',
      '  can_delegate_to: [cto]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'cto.yaml'), [
      'name: CTO', 'model: opus',
      'collaboration:',
      '  reports_to: ceo',
    ].join('\n'));

    const { edges } = buildOrgGraph(tmpRoot);
    const ceoToCto = edges.filter(e => e.from === 'ceo' && e.to === 'cto');
    expect(ceoToCto).toHaveLength(1);
  });

  it('reads supplementary edges from delegation.yaml', () => {
    const agentsDir = makeAgentsDir();
    makeConfigDir();
    writeFileSync(join(agentsDir, 'lead.yaml'), 'name: Lead\nmodel: opus\n');
    writeFileSync(join(agentsDir, 'dev.yaml'), 'name: Dev\nmodel: haiku\n');
    writeFileSync(join(tmpRoot, '.agentforge', 'config', 'delegation.yaml'), 'lead:\n  - dev\n');

    const { edges } = buildOrgGraph(tmpRoot);
    expect(edges.some(e => e.from === 'lead' && e.to === 'dev')).toBe(true);
  });

  it('drops edges involving excluded agents', () => {
    const agentsDir = makeAgentsDir();
    writeFileSync(join(agentsDir, 'genesis.yaml'), [
      'name: Genesis', 'model: opus',
      'collaboration:',
      '  can_delegate_to: [ceo]',
    ].join('\n'));
    writeFileSync(join(agentsDir, 'ceo.yaml'), [
      'name: CEO', 'model: opus',
      'collaboration:',
      '  can_delegate_to: [genesis]',
    ].join('\n'));

    const { edges } = buildOrgGraph(tmpRoot);
    for (const e of edges) {
      expect(e.from).not.toBe('genesis');
      expect(e.to).not.toBe('genesis');
    }
  });
});

// ── Real-project smoke test ────────────────────────────────────────────────

describe('buildOrgGraph — real project data', () => {
  it('returns non-empty nodes and edges from the live .agentforge directory', () => {
    // Exercises the real agent YAMLs in the checked-in .agentforge/agents/
    // directory to confirm the SSR load path works end-to-end against
    // production data. The project root is two levels above packages/dashboard.
    const realRoot = join(import.meta.dirname, '../../../../');
    const result = buildOrgGraph(realRoot);

    // Real YAML files must be found
    expect(result.nodes.length).toBeGreaterThan(0);

    // CEO must be present
    const ids = new Set(result.nodes.map(n => n.id));
    expect(ids.has('ceo')).toBe(true);

    // Every node must have a non-empty label
    for (const node of result.nodes) {
      expect(node.label.length).toBeGreaterThan(0);
    }

    // Delegation hierarchy must produce real edges
    expect(result.edges.length).toBeGreaterThan(0);

    // No duplicate edges
    const edgeKeys = result.edges.map(e => `${e.from}\0${e.to}`);
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
  });
});
