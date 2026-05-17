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

// ---------------------------------------------------------------------------
// v22.1 audit: agent-id-token tie-break tests
// ---------------------------------------------------------------------------

describe('pickAgent — agent-id-token tie-break (v22.1 audit)', () => {
  /**
   * Two agents with IDENTICAL capability_tags but different ids.
   * Item text mentions a token unique to one agent's id → that agent wins.
   */
  it('prefers the agent whose id tokens appear in item text when tag scores tie', () => {
    const tieIndex: RoutingIndex = {
      team_name: 'tie-test',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        {
          id: 'alpha-database-engineer',
          capability_tags: ['workspace-adapter', 'sqlite', 'migration'],
          owns_subsystems: ['packages/db/src'],
          tier: 'sonnet',
          priority: 10,
        },
        {
          id: 'beta-routing-engineer',
          capability_tags: ['workspace-adapter', 'sqlite', 'migration'],
          owns_subsystems: ['packages/server/src/routes'],
          tier: 'sonnet',
          priority: 10,
        },
      ],
    };

    // Both agents score equal on tags (sqlite matches).
    // "database" appears in alpha's id tokens but not beta's → alpha gets +0.5 boost.
    const result = pickAgent(
      {
        title: 'Fix sqlite migration in database storage',
        description: 'The database migration is failing with a constraint error',
        tags: [],
      },
      tieIndex,
    );

    expect(result.agentId).toBe('alpha-database-engineer');
    expect(result.reason).toBe('tag');
  });

  /**
   * v22.1 audit case: item "WorkspaceAdapter losing session rows"
   * Candidates: fastify-v5-engineer vs db-workspace-engineer
   * Both share the workspace-adapter tag.
   * db-workspace-engineer id contains "workspace" which appears in item text → it wins.
   */
  it('v22.1-audit: routes WorkspaceAdapter item to db-workspace-engineer, not fastify-v5-engineer', () => {
    const auditIndex: RoutingIndex = {
      team_name: 'v22.1-audit',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        {
          id: 'fastify-v5-engineer',
          capability_tags: ['workspace-adapter', 'fastify', 'rest', 'v5-api', 'endpoint'],
          owns_subsystems: ['packages/server/src/routes/v5'],
          tier: 'sonnet',
          priority: 14,
        },
        {
          id: 'db-workspace-engineer',
          capability_tags: ['workspace-adapter', 'sqlite', 'migration', 'session', 'db'],
          owns_subsystems: ['packages/db/src'],
          tier: 'sonnet',
          priority: 14,
        },
      ],
    };

    const result = pickAgent(
      {
        title: 'WorkspaceAdapter losing session rows',
        description: 'The workspace adapter is dropping session rows on concurrent writes',
        tags: [],
      },
      auditIndex,
    );

    expect(result.agentId).toBe('db-workspace-engineer');
    expect(result.reason).toBe('tag');
  });

  /**
   * Regression: when one agent has a clearly higher tag score (no tie),
   * the id-token bonus must NOT flip the result to the lower-scoring agent.
   */
  it('regression: id-token bonus cannot override a clear tag-score advantage', () => {
    const clearWinnerIndex: RoutingIndex = {
      team_name: 'regression-clear-winner',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        {
          id: 'svelte-ui-engineer',
          capability_tags: ['svelte', 'runes', 'dashboard', 'frontend', 'ui', 'component'],
          owns_subsystems: ['packages/dashboard/src'],
          tier: 'sonnet',
          priority: 16,
        },
        {
          id: 'db-workspace-engineer',
          capability_tags: ['sqlite', 'db'],
          owns_subsystems: ['packages/db/src'],
          tier: 'sonnet',
          priority: 6,
        },
      ],
    };

    // Item is all about svelte/UI — svelte-ui-engineer has far more tag hits.
    // Even though "engineer" and "db" appear in item, it must NOT flip result.
    const result = pickAgent(
      {
        title: 'Rebuild the svelte dashboard UI with runes and new frontend components',
        description: 'Migrate all svelte UI components to use runes pattern',
        tags: [],
      },
      clearWinnerIndex,
    );

    expect(result.agentId).toBe('svelte-ui-engineer');
    expect(result.reason).toBe('tag');
  });

  /**
   * Regression: existing priority-based tie-break still works when
   * neither agent's id tokens appear in the item text.
   */
  it('regression: priority tie-break still fires when no id tokens match item', () => {
    const priorityTieIndex: RoutingIndex = {
      team_name: 'priority-tie',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        {
          id: 'alpha-xyz-specialist',
          capability_tags: ['migration', 'schema'],
          owns_subsystems: [],
          tier: 'sonnet',
          priority: 8, // higher priority
        },
        {
          id: 'beta-xyz-specialist',
          capability_tags: ['migration', 'schema'],
          owns_subsystems: [],
          tier: 'sonnet',
          priority: 4, // lower priority
        },
      ],
    };

    // Item text contains neither "alpha" nor "beta" nor any other id tokens
    const result = pickAgent(
      {
        title: 'Run migration and update schema',
        description: 'Apply the pending schema migration to the production database',
        tags: [],
      },
      priorityTieIndex,
    );

    // alpha has higher priority so it should win when id-token scores are equal
    expect(result.agentId).toBe('alpha-xyz-specialist');
    expect(result.reason).toBe('tag');
  });

  /**
   * Agent-id token "workspace" in db-workspace-engineer also boosts when
   * item mentions "workspace" as part of a compound word (camelCase split).
   * Verifies the 0.5-weight id-token score is additive and stable.
   */
  it('id-token score is additive: multiple id-token hits accumulate correctly', () => {
    const multiTokenIndex: RoutingIndex = {
      team_name: 'multi-token',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        {
          id: 'workspace-session-engineer',
          capability_tags: ['sqlite', 'adapter'],
          owns_subsystems: [],
          tier: 'sonnet',
          priority: 6,
        },
        {
          id: 'route-handler-engineer',
          capability_tags: ['sqlite', 'adapter'],
          owns_subsystems: [],
          tier: 'sonnet',
          priority: 6,
        },
      ],
    };

    // "workspace" and "session" both appear in item AND in first agent's id
    // → first agent gains +0.5 +0.5 = +1.0 over second agent
    const result = pickAgent(
      {
        title: 'Fix workspace session persistence',
        description: 'Workspace session rows are not being committed',
        tags: [],
      },
      multiTokenIndex,
    );

    expect(result.agentId).toBe('workspace-session-engineer');
    expect(result.reason).toBe('tag');
  });
});
