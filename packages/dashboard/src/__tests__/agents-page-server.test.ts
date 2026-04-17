/**
 * Unit tests for the SSR-side agents data loading in
 * packages/dashboard/src/routes/agents/+page.server.ts.
 *
 * Verifies that _loadAgents(root) correctly reads *.yaml files from
 * <root>/.agentforge/agents/, parses YAML fields (including block scalars),
 * normalises model values, and returns a sorted AgentListItem[].
 *
 * All tests except the real-project smoke test are hermetic — they write
 * to isolated tmp dirs so they never touch the checked-in agent files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _loadAgents } from '../routes/agents/+page.server.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-agents-ssr-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeAgentsDir(): string {
  const dir = join(tmpRoot, '.agentforge', 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Empty / missing ───────────────────────────────────────────────────────────

describe('_loadAgents — empty and missing states', () => {
  it('returns [] when .agentforge/agents/ does not exist', () => {
    // tmpRoot has no .agentforge directory at all
    expect(_loadAgents(tmpRoot)).toEqual([]);
  });

  it('returns [] when agents directory exists but is empty', () => {
    makeAgentsDir();
    expect(_loadAgents(tmpRoot)).toEqual([]);
  });

  it('returns [] when agents directory contains no .yaml files', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'README.md'), '# Agents');
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(_loadAgents(tmpRoot)).toEqual([]);
  });
});

// ── Field parsing ─────────────────────────────────────────────────────────────

describe('_loadAgents — field parsing', () => {
  it('returns agent with name, model, and null role/description/team/effort when minimal YAML', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'simple.yaml'), 'name: Simple Agent\nmodel: haiku\n');

    const result = _loadAgents(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentId: 'simple',
      name: 'Simple Agent',
      model: 'haiku',
      description: null,
      role: null,
      team: null,
      effort: null,
    });
  });

  it('uses the filename stem as agentId', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'lead-architect.yaml'), 'name: Lead Architect\nmodel: opus\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.agentId).toBe('lead-architect');
  });

  it('falls back agentId as name when name field is missing', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'unnamed.yaml'), 'model: sonnet\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.name).toBe('unnamed');
  });

  it('parses inline description correctly', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: Agent\ndescription: Does cool things.\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.description).toBe('Does cool things.');
  });

  it('parses folded block scalar description (>) by joining indented lines with spaces', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), [
      'name: Architect',
      'model: opus',
      'description: >',
      '  Designs the system architecture.',
      '  Owns integration patterns.',
    ].join('\n'));

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.description).toBe('Designs the system architecture. Owns integration patterns.');
  });

  it('parses literal block scalar description (|) by joining indented lines with newlines', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), [
      'name: Writer',
      'model: sonnet',
      'description: |',
      '  Line one.',
      '  Line two.',
    ].join('\n'));

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.description).toBe('Line one.\nLine two.');
  });

  it('trims leading/trailing whitespace from description', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: A\ndescription:   spaced  \n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.description).toBe('spaced');
  });

  it('parses role field', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: Lead\nmodel: opus\nrole: technical-lead\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.role).toBe('technical-lead');
  });

  it('parses team field', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: A\nmodel: sonnet\nteam: runtime\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.team).toBe('runtime');
  });

  it('parses effort field', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: A\nmodel: opus\neffort: high\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.effort).toBe('high');
  });

  it('returns null team and effort when fields are absent', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: A\nmodel: sonnet\n');

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.team).toBeNull();
    expect(result[0]!.effort).toBeNull();
  });
});

// ── Model normalisation ───────────────────────────────────────────────────────

describe('_loadAgents — model normalisation', () => {
  it('preserves "opus" model', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'a.yaml'), 'name: A\nmodel: opus\n');
    expect(_loadAgents(tmpRoot)[0]!.model).toBe('opus');
  });

  it('preserves "haiku" model', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'a.yaml'), 'name: A\nmodel: haiku\n');
    expect(_loadAgents(tmpRoot)[0]!.model).toBe('haiku');
  });

  it('preserves "sonnet" model', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'a.yaml'), 'name: A\nmodel: sonnet\n');
    expect(_loadAgents(tmpRoot)[0]!.model).toBe('sonnet');
  });

  it('defaults unknown model string to "sonnet"', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'a.yaml'), 'name: A\nmodel: gpt-4o\n');
    expect(_loadAgents(tmpRoot)[0]!.model).toBe('sonnet');
  });

  it('defaults missing model field to "sonnet"', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'a.yaml'), 'name: A\n');
    expect(_loadAgents(tmpRoot)[0]!.model).toBe('sonnet');
  });
});

// ── Ordering and resilience ───────────────────────────────────────────────────

describe('_loadAgents — ordering and resilience', () => {
  it('returns agents sorted alphabetically by agentId', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'zeta.yaml'), 'name: Zeta\nmodel: haiku\n');
    writeFileSync(join(dir, 'alpha.yaml'), 'name: Alpha\nmodel: opus\n');
    writeFileSync(join(dir, 'beta.yaml'), 'name: Beta\nmodel: sonnet\n');

    const result = _loadAgents(tmpRoot);
    expect(result.map(a => a.agentId)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('skips malformed YAML files without crashing', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'good.yaml'), 'name: Good\nmodel: sonnet\n');
    writeFileSync(join(dir, 'bad.yaml'), '{ invalid: yaml: [[[');

    const result = _loadAgents(tmpRoot);
    // Good file still appears even with a bad sibling
    expect(result.some(a => a.agentId === 'good')).toBe(true);
  });

  it('handles multiple agents correctly — count and fields', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'architect.yaml'), [
      'name: Architect',
      'model: opus',
      'description: Designs the system.',
      'role: lead',
    ].join('\n'));
    writeFileSync(join(dir, 'coder.yaml'), [
      'name: Coder',
      'model: sonnet',
      'description: Writes the code.',
    ].join('\n'));

    const result = _loadAgents(tmpRoot);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ agentId: 'architect', name: 'Architect', model: 'opus', role: 'lead' });
    expect(result[1]).toMatchObject({ agentId: 'coder', name: 'Coder', model: 'sonnet', role: null });
  });

  it('ignores non-.yaml files in the agents directory', () => {
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'agent.yaml'), 'name: Real\nmodel: sonnet\n');
    writeFileSync(join(dir, 'notes.txt'), 'not a yaml file');
    writeFileSync(join(dir, 'config.json'), '{"model":"opus"}');

    const result = _loadAgents(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0]!.agentId).toBe('agent');
  });
});

// ── Block scalar edge cases ────────────────────────────────────────────────────

describe('_loadAgents — block scalar with trailing content', () => {
  it('stops block scalar collection at blank line, then continues parsing', () => {
    // Mirrors lead-architect.yaml: description block ends at blank line,
    // followed by system_prompt which must not bleed into description.
    const dir = makeAgentsDir();
    writeFileSync(join(dir, 'complex.yaml'), [
      'name: Complex',
      'model: opus',
      'description: >',
      '  First line of description.',
      '  Second line of description.',
      '',              // blank line ends the block scalar
      'system_prompt: |',
      '  You are an AI.',
    ].join('\n'));

    const result = _loadAgents(tmpRoot);
    expect(result[0]!.description).toBe('First line of description. Second line of description.');
  });
});

// ── Real-project smoke test ────────────────────────────────────────────────────

describe('_loadAgents — real project data', () => {
  it('returns non-empty agent list from the live .agentforge/agents/ directory', () => {
    // The real project root is 4 levels up from packages/dashboard/src/__tests__
    const realRoot = join(import.meta.dirname, '../../../../');
    const result = _loadAgents(realRoot);

    // 100+ YAML files exist — must find at least one
    expect(result.length).toBeGreaterThan(0);

    // Every item must have non-empty agentId and name
    for (const agent of result) {
      expect(agent.agentId.length).toBeGreaterThan(0);
      expect(agent.name.length).toBeGreaterThan(0);
      expect(['opus', 'sonnet', 'haiku']).toContain(agent.model);
    }

    // Lead Architect must be present with correct model tier and team
    const leadArchitect = result.find(a => a.agentId === 'lead-architect');
    expect(leadArchitect).toBeDefined();
    expect(leadArchitect!.name).toBe('Lead Architect');
    expect(leadArchitect!.model).toBe('opus');
    expect(leadArchitect!.team).toBe('strategic');

    // At least some agents must have non-null team fields (60+ YAML files have team:)
    const agentsWithTeam = result.filter(a => a.team !== null);
    expect(agentsWithTeam.length).toBeGreaterThan(0);

    // Effort fields must be parsed (60 YAML files have effort:)
    const agentsWithEffort = result.filter(a => a.effort !== null);
    expect(agentsWithEffort.length).toBeGreaterThan(0);

    // Result must be sorted alphabetically by agentId
    const ids = result.map(a => a.agentId);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });
});
