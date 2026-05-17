// packages/core/src/autonomous/routing/__tests__/router.test.ts
//
// Unit tests for pickAgent() — the capability-tag-aware agent picker.

import { describe, it, expect } from 'vitest';
import { pickAgent } from '../router.js';
import type { RoutingIndex } from '../routing-index.js';

// ---------------------------------------------------------------------------
// Fixture routing index — 5 agents
// ---------------------------------------------------------------------------

const FIXTURE_INDEX: RoutingIndex = {
  team_name: 'test-team',
  generated_at: '2026-05-17T00:00:00.000Z',
  agents: [
    {
      id: 'fastify-route-engineer',
      capability_tags: ['fastify', 'rest', 'route', 'v5-api', 'endpoint'],
      owns_subsystems: ['packages/server/src/routes/v5'],
      tier: 'sonnet',
      priority: 18,
    },
    {
      id: 'svelte-runes-engineer',
      capability_tags: ['svelte', 'runes', 'ui', 'dashboard', 'frontend', 'sveltekit'],
      owns_subsystems: ['packages/dashboard/src'],
      tier: 'sonnet',
      priority: 16,
    },
    {
      id: 'vitest-author',
      capability_tags: ['test', 'vitest', 'unit-test', 'coverage', 'assertion'],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 10,
    },
    {
      id: 'coder',
      capability_tags: [],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 0,
    },
    {
      id: 'docs-writer',
      capability_tags: ['docs', 'documentation', 'markdown', 'readme'],
      owns_subsystems: [],
      tier: 'haiku',
      priority: 8,
    },
  ],
};

const EMPTY_INDEX: RoutingIndex = {
  team_name: 'empty',
  generated_at: '2026-05-17T00:00:00.000Z',
  agents: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pickAgent — subsystem routing (priority 1)', () => {
  it('routes item mentioning a v5 route file to fastify-route-engineer', () => {
    const result = pickAgent(
      {
        title: 'Fix cycles endpoint returning 404',
        description: 'The file packages/server/src/routes/v5/cycles.ts has a broken handler',
        tags: [],
      },
      FIXTURE_INDEX,
    );

    expect(result.agentId).toBe('fastify-route-engineer');
    expect(result.reason).toBe('subsystem');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('picks the most-specific subsystem owner when multiple agents overlap', () => {
    const indexWithNested: RoutingIndex = {
      ...FIXTURE_INDEX,
      agents: [
        {
          id: 'server-broad',
          capability_tags: [],
          owns_subsystems: ['packages/server/src'],
          tier: 'sonnet',
          priority: 5,
        },
        {
          id: 'routes-narrow',
          capability_tags: [],
          owns_subsystems: ['packages/server/src/routes/v5'],
          tier: 'sonnet',
          priority: 10,
        },
      ],
    };

    const result = pickAgent(
      {
        title: 'Add route handler',
        description: 'Edit packages/server/src/routes/v5/agents.ts to add a new endpoint',
        tags: [],
      },
      indexWithNested,
    );

    expect(result.agentId).toBe('routes-narrow');
    expect(result.reason).toBe('subsystem');
  });
});

describe('pickAgent — tag routing (priority 2)', () => {
  it('routes item with svelte + ui tags to svelte-runes-engineer', () => {
    const result = pickAgent(
      {
        title: 'Fix svelte component layout issue in the ui',
        description: 'The dashboard page has broken svelte runes',
        tags: ['svelte', 'ui'],
      },
      FIXTURE_INDEX,
    );

    expect(result.agentId).toBe('svelte-runes-engineer');
    expect(result.reason).toBe('tag');
  });

  it('routes item with test tag to vitest-author', () => {
    const result = pickAgent(
      {
        title: 'Add vitest coverage for the routing module test suite',
        description: 'Write unit test cases for router.ts',
        tags: ['test', 'vitest'],
      },
      FIXTURE_INDEX,
    );

    expect(result.agentId).toBe('vitest-author');
    expect(result.reason).toBe('tag');
  });

  it('does not pick a tag match below threshold of 2', () => {
    // Only 1 matching tag — below threshold
    const result = pickAgent(
      {
        title: 'Do something with fastify',
        description: 'A vague task',
        tags: [],
      },
      FIXTURE_INDEX,
    );

    // Falls through to legacy or fallback — NOT tag
    expect(result.reason).not.toBe('subsystem');
  });
});

describe('pickAgent — fallback routing (priority 4)', () => {
  it('returns coder for item with no signals', () => {
    const result = pickAgent(
      {
        title: 'Some unrelated task',
        description: 'No file paths, no matching tags',
        tags: [],
      },
      FIXTURE_INDEX,
    );

    expect(result.agentId).toBe('coder');
    expect(result.reason).toBe('fallback');
  });

  it('returns coder literal for empty index', () => {
    const result = pickAgent(
      {
        title: 'Any task',
        tags: [],
      },
      EMPTY_INDEX,
    );

    expect(result.agentId).toBe('coder');
    expect(result.reason).toBe('fallback');
    expect(result.confidence).toBe(0);
  });
});

describe('pickAgent — legacy fallback (priority 3)', () => {
  it('routes items with doc/architecture tags via legacy path when no tag match', () => {
    // Legacy fallback only fires when the candidate agent actually exists
    // in the index — otherwise the executor would receive an agentId it
    // can't resolve. So include the legacy targets in the fixture.
    const indexNoSpecialists: RoutingIndex = {
      ...FIXTURE_INDEX,
      agents: [
        { id: 'coder', capability_tags: [], owns_subsystems: [], tier: 'sonnet', priority: 0 },
        { id: 'architect', capability_tags: [], owns_subsystems: [], tier: 'opus', priority: 0 },
        { id: 'backend-tech-writer', capability_tags: [], owns_subsystems: [], tier: 'haiku', priority: 0 },
        { id: 'backend-qa', capability_tags: [], owns_subsystems: [], tier: 'sonnet', priority: 0 },
      ],
    };

    const archResult = pickAgent(
      { title: 'Design the new architecture', tags: ['architecture'] },
      indexNoSpecialists,
    );
    expect(archResult.reason).toBe('legacy');
    expect(archResult.agentId).toBe('architect');

    const docsResult = pickAgent(
      { title: 'Update documentation', tags: ['docs'] },
      indexNoSpecialists,
    );
    expect(docsResult.reason).toBe('legacy');
    expect(docsResult.agentId).toBe('backend-tech-writer');
  });
});

describe('pickAgent — confidence values', () => {
  it('subsystem match has higher confidence than tag match', () => {
    const subsystemResult = pickAgent(
      {
        title: 'Fix packages/server/src/routes/v5/cycles.ts',
        tags: [],
      },
      FIXTURE_INDEX,
    );

    const tagResult = pickAgent(
      {
        title: 'Fix svelte runes in the ui frontend',
        tags: ['svelte', 'ui'],
      },
      FIXTURE_INDEX,
    );

    expect(subsystemResult.confidence).toBeGreaterThan(tagResult.confidence);
  });
});
