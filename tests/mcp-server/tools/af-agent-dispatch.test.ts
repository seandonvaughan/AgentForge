/**
 * Tests for af_agent_dispatch tool.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afAgentDispatch } from '../../../packages/mcp-server/src/tools/af-agent-dispatch.js';

const TEMP_ROOT = join(tmpdir(), `af-agent-dispatch-test-${Date.now()}`);
const AGENTFORGE_DIR = join(TEMP_ROOT, '.agentforge');

const ROUTING_INDEX = {
  agents: [
    {
      id: 'db-workspace-engineer',
      capability_tags: ['sqlite', 'migrations', 'workspace-adapter'],
      owns_subsystems: ['packages/db/src'],
      tier: 'sonnet',
      priority: 30,
    },
    {
      id: 'forge-engine-architect',
      capability_tags: ['forge-pipeline', 'agent-driven-synthesis', 'domain-packs'],
      owns_subsystems: ['packages/core/src/team/engine'],
      tier: 'opus',
      priority: 34,
    },
    {
      id: 'yaml-doctor',
      capability_tags: ['yaml', 'agent-manifest', 'linting'],
      owns_subsystems: [],
      tier: 'haiku',
      priority: 5,
    },
  ],
};

beforeAll(() => {
  mkdirSync(AGENTFORGE_DIR, { recursive: true });
  writeFileSync(
    join(AGENTFORGE_DIR, 'routing-index.json'),
    JSON.stringify(ROUTING_INDEX),
    'utf-8',
  );
});

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe('afAgentDispatch', () => {
  it('returns the best matching agent for a single tag', () => {
    const result = afAgentDispatch({ capability_tags: ['sqlite'] }, TEMP_ROOT);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.data?.agentId).toBe('db-workspace-engineer');
    expect(result.data?.recommendedModel).toBe('sonnet');
  });

  it('returns the best matching agent when multiple agents share a tag', () => {
    const result = afAgentDispatch({ capability_tags: ['forge-pipeline', 'domain-packs'] }, TEMP_ROOT);
    expect(result.ok).toBe(true);
    expect(result.data?.agentId).toBe('forge-engine-architect');
    expect(result.data?.recommendedModel).toBe('opus');
  });

  it('returns haiku model for haiku-tier agents', () => {
    const result = afAgentDispatch({ capability_tags: ['yaml'] }, TEMP_ROOT);
    expect(result.ok).toBe(true);
    expect(result.data?.recommendedModel).toBe('haiku');
  });

  it('returns NOT_FOUND error when no tags match', () => {
    const result = afAgentDispatch({ capability_tags: ['nonexistent-tag-xyz'] }, TEMP_ROOT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_MATCH');
    expect(result.data).toBeNull();
  });

  it('rejects invalid tag characters', () => {
    const result = afAgentDispatch({ capability_tags: ['../../etc/passwd'] }, TEMP_ROOT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_TAG');
  });

  it('returns NO_ROUTING_INDEX error when file is missing', () => {
    const result = afAgentDispatch({ capability_tags: ['sqlite'] }, '/nonexistent/path');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_ROUTING_INDEX');
  });

  it('includes ownsSubsystems in the result', () => {
    const result = afAgentDispatch({ capability_tags: ['sqlite'] }, TEMP_ROOT);
    expect(result.ok).toBe(true);
    expect(result.data?.ownsSubsystems).toContain('packages/db/src');
  });

  it('includes capabilityTags in the result', () => {
    const result = afAgentDispatch({ capability_tags: ['yaml'] }, TEMP_ROOT);
    expect(result.ok).toBe(true);
    expect(result.data?.capabilityTags).toContain('yaml');
  });
});
