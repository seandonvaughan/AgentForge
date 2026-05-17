// packages/core/src/autonomous/routing/__tests__/routing-index.test.ts
//
// Unit tests for buildRoutingIndex() — reads fixture agent YAMLs and verifies
// the shape and contents of the generated routing index.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRoutingIndex } from '../routing-index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'routing-index-test-'));
  mkdirSync(join(tmpDir, 'agents'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAgent(name: string, yaml: string): void {
  writeFileSync(join(tmpDir, 'agents', `${name}.yaml`), yaml, 'utf8');
}

describe('buildRoutingIndex', () => {
  it('returns empty agents array when agentsDir does not exist', () => {
    const result = buildRoutingIndex({
      agentsDir: join(tmpDir, 'nonexistent'),
    });
    expect(result.agents).toHaveLength(0);
    expect(result.team_name).toBe('default');
    expect(result.generated_at).toBeTruthy();
  });

  it('indexes an agent with inline capability_tags', () => {
    writeAgent(
      'fastify-route-engineer',
      `name: Fastify Route Engineer
model: sonnet
capability_tags: [fastify, rest, route, v5-api]
owns_subsystems:
  - packages/server/src/routes/v5
`,
    );

    const result = buildRoutingIndex({ agentsDir: join(tmpDir, 'agents') });

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0]!;
    expect(agent.id).toBe('fastify-route-engineer');
    expect(agent.capability_tags).toEqual(['fastify', 'rest', 'route', 'v5-api']);
    expect(agent.owns_subsystems).toEqual(['packages/server/src/routes/v5']);
    expect(agent.tier).toBe('sonnet');
    expect(agent.priority).toBeGreaterThan(0);
  });

  it('indexes an agent with block-list capability_tags', () => {
    writeAgent(
      'svelte-runes-engineer',
      `name: Svelte Runes Engineer
model: sonnet
capability_tags:
  - svelte
  - runes
  - ui
  - dashboard
owns_subsystems:
  - packages/dashboard/src
`,
    );

    const result = buildRoutingIndex({ agentsDir: join(tmpDir, 'agents') });

    const agent = result.agents[0]!;
    expect(agent.capability_tags).toContain('svelte');
    expect(agent.capability_tags).toContain('runes');
    expect(agent.owns_subsystems).toContain('packages/dashboard/src');
  });

  it('indexes legacy agents (no capability_tags or owns_subsystems) with empty arrays', () => {
    writeAgent(
      'coder',
      `name: Coder
model: sonnet
description: Generic coder agent
system_prompt: You are the Coder.
`,
    );

    const result = buildRoutingIndex({ agentsDir: join(tmpDir, 'agents') });

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0]!;
    expect(agent.id).toBe('coder');
    expect(agent.capability_tags).toEqual([]);
    expect(agent.owns_subsystems).toEqual([]);
    expect(agent.priority).toBe(0);
  });

  it('correctly identifies opus and haiku tiers', () => {
    writeAgent('opus-agent', `name: Opus Agent\nmodel: opus\ncapability_tags: [strategy]\n`);
    writeAgent('haiku-agent', `name: Haiku Agent\nmodel: haiku\ncapability_tags: [scan]\n`);
    writeAgent('sonnet-agent', `name: Sonnet Agent\nmodel: sonnet\ncapability_tags: [code]\n`);

    const result = buildRoutingIndex({ agentsDir: join(tmpDir, 'agents') });

    const opus = result.agents.find((a) => a.id === 'opus-agent')!;
    const haiku = result.agents.find((a) => a.id === 'haiku-agent')!;
    const sonnet = result.agents.find((a) => a.id === 'sonnet-agent')!;

    expect(opus.tier).toBe('opus');
    expect(haiku.tier).toBe('haiku');
    expect(sonnet.tier).toBe('sonnet');
  });

  it('reads team_name from team.yaml', () => {
    const teamPath = join(tmpDir, 'team.yaml');
    writeFileSync(teamPath, `name: AgentForge v18\nagents: []\n`, 'utf8');

    const result = buildRoutingIndex({
      agentsDir: join(tmpDir, 'agents'),
      teamPath,
    });

    expect(result.team_name).toBe('AgentForge v18');
  });

  it('writes routing-index.json to outputPath', () => {
    writeAgent('vitest-author', `name: Vitest Author\nmodel: sonnet\ncapability_tags: [test, vitest]\n`);

    const outputPath = join(tmpDir, 'routing-index.json');
    buildRoutingIndex({ agentsDir: join(tmpDir, 'agents'), outputPath });

    const written = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(written.agents).toHaveLength(1);
    expect(written.agents[0].id).toBe('vitest-author');
  });

  it('sorts agents by priority descending (more specific first)', () => {
    writeAgent('generic', `name: Generic\nmodel: sonnet\ncapability_tags: [code]\n`);
    writeAgent(
      'specialist',
      `name: Specialist\nmodel: sonnet\ncapability_tags: [fastify, rest, route, v5-api]\nows_subsystems:\n  - packages/server/src/routes/v5\n`,
    );

    const result = buildRoutingIndex({ agentsDir: join(tmpDir, 'agents') });

    // Specialist has more tags so higher priority
    expect(result.agents[0]!.id).toBe('specialist');
  });

  it('handles multiple agents across a directory', () => {
    writeAgent('agent-a', `name: Agent A\nmodel: sonnet\ncapability_tags: [typescript, build]\n`);
    writeAgent('agent-b', `name: Agent B\nmodel: haiku\ncapability_tags: [ci, github-actions]\n`);
    writeAgent('agent-c', `name: Agent C\nmodel: opus\ncapability_tags: []\n`);

    const result = buildRoutingIndex({ agentsDir: join(tmpDir, 'agents') });

    expect(result.agents).toHaveLength(3);
    const ids = result.agents.map((a) => a.id).sort();
    expect(ids).toEqual(['agent-a', 'agent-b', 'agent-c']);
  });
});
