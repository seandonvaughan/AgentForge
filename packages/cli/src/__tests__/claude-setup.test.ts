// W7 — `agentforge claude setup`: .mcp.json merge + .claude/agents re-emission.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeSetup, resolveMcpServerPath } from '../commands/claude-setup.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-claude-setup-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAgentYaml(id: string, model: string): void {
  const dir = join(root, '.agentforge', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    `name: ${id}\nmodel: ${model}\nversion: '1.0'\ndescription: test agent ${id}\nsystem_prompt: |\n  You are ${id}. Do the thing carefully and report.\n`,
  );
}

describe('runClaudeSetup', () => {
  it('writes .mcp.json with the agentforge server and emits missing agent mirrors', async () => {
    writeAgentYaml('coder', 'sonnet');
    writeAgentYaml('epic-planner', 'fable');

    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');

    const result = await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer });

    expect(result.mcpUpdated).toBe(true);
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.agentforge).toEqual({
      command: 'node',
      args: [fakeServer],
      env: { AGENTFORGE_PROJECT_ROOT: root },
    });

    expect(result.agentsEmitted).toHaveLength(2);
    const planner = readFileSync(join(root, '.claude', 'agents', 'epic-planner.md'), 'utf8');
    // fable tier maps to the full model id — Claude Code has no 'fable' alias.
    expect(planner).toContain('claude-fable-5');
    const coder = readFileSync(join(root, '.claude', 'agents', 'coder.md'), 'utf8');
    expect(coder).toContain('sonnet');
  });

  it('is idempotent and preserves other MCP servers', async () => {
    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'foo' } } }),
    );

    const first = await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer });
    expect(first.mcpUpdated).toBe(true);
    const second = await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer });
    expect(second.mcpUpdated).toBe(false);

    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.other).toEqual({ command: 'foo' });
    expect(mcp.mcpServers.agentforge).toBeDefined();
  });

  it('skips existing mirrors and tolerates a project with no agents', async () => {
    writeAgentYaml('coder', 'sonnet');
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'coder.md'), 'existing — do not clobber');

    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');
    const result = await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer });

    expect(result.agentsEmitted).toHaveLength(0);
    expect(readFileSync(join(root, '.claude', 'agents', 'coder.md'), 'utf8')).toBe('existing — do not clobber');

    // No agents dir at all → no throw.
    const empty = mkdtempSync(join(tmpdir(), 'af-claude-empty-'));
    try {
      const r = await runClaudeSetup({ projectRoot: empty, mcpServerPath: fakeServer });
      expect(r.agentsEmitted).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refresh: true re-emits ALL mirrors, overwriting existing ones', async () => {
    writeAgentYaml('coder', 'sonnet');
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'coder.md'), 'stale mirror');

    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');
    const result = await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer, refresh: true });

    // agentsEmitted carries absolute paths of every mirror written
    expect(result.agentsEmitted.some((p) => p.endsWith('coder.md'))).toBe(true);
    const md = readFileSync(join(root, '.claude', 'agents', 'coder.md'), 'utf8');
    expect(md).not.toBe('stale mirror');
    expect(md).toContain('You are coder.');
  });

  it('passes effort and tools from the YAML into the .md frontmatter', async () => {
    const dir = join(root, '.agentforge', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'epic-planner.yaml'),
      [
        'name: epic-planner',
        'model: fable',
        "version: '1.0'",
        'description: epic decomposition authority',
        'effort: xhigh',
        'tools:',
        '  - Read',
        '  - Grep',
        'system_prompt: |',
        '  You decompose epics into PR-sized children.',
        '',
      ].join('\n'),
    );

    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');
    await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer });

    const md = readFileSync(join(root, '.claude', 'agents', 'epic-planner.md'), 'utf8');
    expect(md).toContain('effort: xhigh');
    expect(md).toContain('Read');
    expect(md).toContain('Grep');
    expect(md).toContain('claude-fable-5');
  });

  it('omits effort from the frontmatter when the YAML has none', async () => {
    writeAgentYaml('coder', 'sonnet');
    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');
    await runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer });

    const md = readFileSync(join(root, '.claude', 'agents', 'coder.md'), 'utf8');
    expect(md).not.toContain('effort:');
  });

  it('rejects a corrupt .mcp.json instead of clobbering it', async () => {
    const fakeServer = join(root, 'fake-mcp.js');
    writeFileSync(fakeServer, '// stub');
    writeFileSync(join(root, '.mcp.json'), 'not-json{');
    await expect(runClaudeSetup({ projectRoot: root, mcpServerPath: fakeServer })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe('not-json{');
  });
});

describe('resolveMcpServerPath', () => {
  it('finds the monorepo dist when walking up, and a project-local build as fallback', () => {
    // In this repo the real build exists — walking up from the CLI module finds it.
    const found = resolveMcpServerPath(root);
    expect(found === null || found.endsWith(join('packages', 'mcp-server', 'dist', 'index.js'))).toBe(true);

    // Project-local fallback.
    const local = join(root, 'packages', 'mcp-server', 'dist');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'index.js'), '// stub');
    expect(resolveMcpServerPath(root, join(root, 'nowhere', 'deep'))).toBe(join(local, 'index.js'));
  });
});
