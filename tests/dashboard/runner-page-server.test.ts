/**
 * Unit tests for packages/dashboard/src/routes/runner/+page.server.ts
 *
 * Tests the _loadRunnerAgents(root) helper in isolation using a temporary
 * directory. No SvelteKit runtime is needed — the helper is pure filesystem IO.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _loadRunnerAgents } from '../../packages/dashboard/src/routes/runner/+page.server.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'runner-server-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAgent(agentsDir: string, filename: string, content: string) {
  writeFileSync(join(agentsDir, filename), content, 'utf-8');
}

describe('_loadRunnerAgents', () => {
  it('returns empty array when .agentforge/agents/ does not exist', () => {
    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents).toEqual([]);
  });

  it('returns empty array when agents directory is empty', () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'agents'), { recursive: true });
    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents).toEqual([]);
  });

  it('extracts agentId, name, and model from a valid YAML file', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'coder.yaml', 'name: coder\nmodel: sonnet\n');

    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agentId: 'coder', name: 'coder', model: 'sonnet' });
  });

  it('normalizes unknown model values to "sonnet"', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'bot.yaml', 'name: bot\nmodel: gpt-4\n');

    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents[0]?.model).toBe('sonnet');
  });

  it('recognises "opus" and "haiku" model values', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'strategist.yaml', 'name: strategist\nmodel: opus\n');
    writeAgent(agentsDir, 'helper.yaml', 'name: helper\nmodel: haiku\n');

    const agents = _loadRunnerAgents(tmpRoot);
    const opus  = agents.find(a => a.agentId === 'strategist');
    const haiku = agents.find(a => a.agentId === 'helper');
    expect(opus?.model).toBe('opus');
    expect(haiku?.model).toBe('haiku');
  });

  it('falls back to agentId when name field is missing', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'nameless.yaml', 'model: sonnet\n');

    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents[0]).toMatchObject({ agentId: 'nameless', name: 'nameless', model: 'sonnet' });
  });

  it('sorts agents opus → sonnet → haiku then alphabetically within tier', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'zebra.yaml',   'name: zebra\nmodel: sonnet\n');
    writeAgent(agentsDir, 'alpha.yaml',   'name: alpha\nmodel: sonnet\n');
    writeAgent(agentsDir, 'big.yaml',     'name: big\nmodel: opus\n');
    writeAgent(agentsDir, 'tiny.yaml',    'name: tiny\nmodel: haiku\n');

    const agents = _loadRunnerAgents(tmpRoot);
    const ids = agents.map(a => a.agentId);
    // 'big' (opus) first, then sonnet alphabetically ('alpha', 'zebra'), then haiku
    expect(ids).toEqual(['big', 'alpha', 'zebra', 'tiny']);
  });

  it('silently skips malformed YAML files', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'valid.yaml',   'name: valid\nmodel: sonnet\n');
    writeAgent(agentsDir, 'bad.yaml',     'this: [is: not valid yaml: at all\n');

    // Should not throw; valid agent is returned
    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents.some(a => a.agentId === 'valid')).toBe(true);
  });

  it('ignores non-YAML files in the agents directory', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'readme.md',  '# Agents\n');
    writeAgent(agentsDir, 'coder.yaml', 'name: coder\nmodel: sonnet\n');

    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe('coder');
  });

  it('strips agentId derived from .yaml extension correctly', () => {
    const agentsDir = join(tmpRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(agentsDir, 'my-agent.yaml', 'name: My Agent\nmodel: sonnet\n');

    const agents = _loadRunnerAgents(tmpRoot);
    expect(agents[0]?.agentId).toBe('my-agent');
    expect(agents[0]?.name).toBe('My Agent');
  });
});
