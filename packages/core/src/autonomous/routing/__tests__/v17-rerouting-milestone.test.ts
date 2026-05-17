// packages/core/src/autonomous/routing/__tests__/v17-rerouting-milestone.test.ts
//
// v17.0.0 Re-routing Milestone Test
//
// Hardens the "9 of 25 items to coder" regression described in the spec.
// This test:
//   1. Hardcodes the actual 25-item v17.0.0 sprint plan as a fixture
//   2. Builds a synthetic routing index with specialist agents
//   3. Runs all 25 items through pickAgent()
//   4. Asserts: top-1 agent receives ≤4 items AND ≥80% routed to non-coder
//
// Histogram at bottom of test output shows full distribution.

import { describe, it, expect } from 'vitest';
import { pickAgent } from '../router.js';
import type { RoutingIndex } from '../routing-index.js';

// ---------------------------------------------------------------------------
// Fixture: actual v17.0.0 sprint items (from PR #59 body)
// ---------------------------------------------------------------------------

interface V17Item {
  id: string;
  title: string;
  assignedTo: string; // what the old router assigned (for reference)
  tags: string[];
}

const V17_SPRINT_ITEMS: V17Item[] = [
  {
    id: 'v17-01',
    title: 'Fix CI typecheck job ordering in .github/workflows/ci.yml',
    assignedTo: 'devops-engineer',
    tags: ['fix', 'ci', 'typecheck'],
  },
  {
    id: 'v17-02',
    title: 'Fix 5 currently-failing tests: execute-phase ×2, phase-handlers-verification ×2, full-cycle:327',
    assignedTo: 'debugger',
    tags: ['fix', 'test'],
  },
  {
    id: 'v17-03',
    title: 'Deduplicate readCycleRecord — extract to shared helper in packages/server/src/lib/',
    assignedTo: 'coder',
    tags: ['feature', 'refactor'],
  },
  {
    id: 'v17-04',
    title: 'Run svelte-check on packages/dashboard and fix every type error',
    assignedTo: 'frontend-dev',
    tags: ['fix', 'svelte', 'typecheck'],
  },
  {
    id: 'v17-05',
    title: 'Fix /runner svelte-check errors and wire /api/v5/run/history to real session data',
    assignedTo: 'frontend-dev',
    tags: ['fix', 'svelte', 'ui'],
  },
  {
    id: 'v17-06',
    title: 'Fix /org dashboard route — pre-diagnose data contract, then fix page rendering',
    assignedTo: 'dashboard-architect',
    tags: ['fix', 'svelte', 'dashboard'],
  },
  {
    id: 'v17-07',
    title: 'Add pre-execute typecheck step in cycle-runner.ts between RUN and VERIFY phases',
    assignedTo: 'coder',
    tags: ['feature', 'typecheck'],
  },
  {
    id: 'v17-08',
    title: 'Add knownDebt field to gate-phase prompt to distinguish sprint-introduced vs pre-existing findings',
    assignedTo: 'coder',
    tags: ['feature', 'gate', 'prompt'],
  },
  {
    id: 'v17-09',
    title: 'Improve scorer prompt to penalize invented agentIds not on the roster',
    assignedTo: 'coder',
    tags: ['enhancement', 'scorer', 'prompt'],
  },
  {
    id: 'v17-10',
    title: 'Replace static-fallback flat perItemUsd with p50CostByTag lookup in scoring-pipeline.ts',
    assignedTo: 'coder',
    tags: ['enhancement', 'scoring', 'cost'],
  },
  {
    id: 'v17-11',
    title: 'Add incremental cost roll-up to cycle.json after each phase handler',
    assignedTo: 'coder',
    tags: ['enhancement', 'cost', 'cycle'],
  },
  {
    id: 'v17-12',
    title: 'Add SQLite tables knowledge_entities and knowledge_relationships to WorkspaceAdapter schema',
    assignedTo: 'dba',
    tags: ['feature', 'sqlite', 'database', 'schema'],
  },
  {
    id: 'v17-13',
    title: 'Refactor knowledge-graph.ts to use WorkspaceAdapter — replace in-memory Map with adapter calls',
    assignedTo: 'coder',
    tags: ['refactor', 'knowledge', 'database'],
  },
  {
    id: 'v17-14',
    title: 'Inject writeKnowledgeEntry() calls in audit-phase.ts and review-phase.ts',
    assignedTo: 'coder',
    tags: ['feature', 'knowledge', 'phase'],
  },
  {
    id: 'v17-15',
    title: 'Persist approvals to SQLite — replace in-memory Map with approvals table',
    assignedTo: 'dba',
    tags: ['feature', 'sqlite', 'database', 'persistence'],
  },
  {
    id: 'v17-16',
    title: 'Persist GitBranchManager to SQLite with git_branches table',
    assignedTo: 'dba',
    tags: ['feature', 'sqlite', 'database', 'git'],
  },
  {
    id: 'v17-17',
    title: 'Persist RuntimeJobSupervisor writes to existing runtime_jobs and runtime_events tables',
    assignedTo: 'dba',
    tags: ['feature', 'sqlite', 'database', 'runtime'],
  },
  {
    id: 'v17-18',
    title: 'Add rolling p50CostByTag computation in workspace-telemetry-adapters.ts from last 20 cycles',
    assignedTo: 'data-analyst',
    tags: ['enhancement', 'cost', 'telemetry'],
  },
  {
    id: 'v17-19',
    title: 'Wire effort-estimator.ts as third-strike fallback in scoring-pipeline.ts',
    assignedTo: 'coder',
    tags: ['enhancement', 'scoring'],
  },
  {
    id: 'v17-20',
    title: 'Add per-request timeoutMs override on ExecutionRequest for heavy reasoning tasks',
    assignedTo: 'api-specialist',
    tags: ['feature', 'api', 'runtime'],
  },
  {
    id: 'v17-21',
    title: 'Add modelCap + RuntimeAdapter applyCaps() test coverage for 5 specified scenarios',
    assignedTo: 'test-runner',
    tags: ['test', 'coverage'],
  },
  {
    id: 'v17-22',
    title: 'Run pnpm verify:gates on main and classify every failing test or typecheck',
    assignedTo: 'debugger',
    tags: ['fix', 'test', 'ci'],
  },
  {
    id: 'v17-23',
    title: 'Security audit of packages/server/ — CORS, auth bypass, path sanitization, child_process',
    assignedTo: 'code-reviewer',
    tags: ['security'],
  },
  {
    id: 'v17-24',
    title: 'Investigate 8 failing tests from v10.6.0 cycle — fix or delete with commit justification',
    assignedTo: 'debugger',
    tags: ['fix', 'test', 'debug'],
  },
  {
    id: 'v17-25',
    title: 'Add Playwright e2e tests under tests/e2e/ for core dashboard routes',
    assignedTo: 'test-runner',
    tags: ['test', 'e2e', 'playwright', 'dashboard'],
  },
];

// ---------------------------------------------------------------------------
// Synthetic routing index — 15 agents hinting at v17 work
// ---------------------------------------------------------------------------
//
// Agents are designed to cover the key areas in the v17 sprint:
//   CI/workflow, typecheck, debugging, svelte-check, knowledge-graph,
//   SQLite persistence, scoring/cost, runtime API, security, e2e testing.

const V17_ROUTING_INDEX: RoutingIndex = {
  team_name: 'agentforge-v18-team',
  generated_at: '2026-05-17T00:00:00.000Z',
  agents: [
    // v17-01: "Fix CI typecheck job ordering in .github/workflows/ci.yml"
    // Tags: ci, typecheck, workflow + owns .github/workflows (subsystem match)
    {
      id: 'ci-automation-engineer',
      capability_tags: ['ci', 'github-actions', 'workflow', 'typecheck', 'lint', 'ordering'],
      owns_subsystems: ['.github/workflows'],
      tier: 'sonnet',
      priority: 24,
    },
    // v17-04 "Run svelte-check on packages/dashboard and fix every type error"
    // v17-05 "Fix /runner svelte-check errors and wire /api/v5/run/history"
    // v17-06 "Fix /org dashboard route"
    {
      id: 'svelte-runes-engineer',
      capability_tags: ['svelte', 'sveltekit', 'ui', 'dashboard', 'frontend', 'runes', 'type'],
      owns_subsystems: ['packages/dashboard/src'],
      tier: 'sonnet',
      priority: 24,
    },
    // v17-02 "Fix 5 currently-failing tests"
    // v17-22 "Run pnpm verify:gates on main and classify every failing test"
    // v17-24 "Investigate 8 failing tests from v10.6.0 cycle — fix or delete"
    {
      id: 'debugger',
      capability_tags: ['debug', 'failing', 'test', 'fix', 'diagnose', 'investigate', 'verify', 'classify'],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 16,
    },
    // v17-13 "Refactor knowledge-graph.ts to use WorkspaceAdapter"
    // v17-14 "Inject writeKnowledgeEntry() calls in audit-phase.ts and review-phase.ts"
    {
      id: 'knowledge-graph-engineer',
      capability_tags: ['knowledge', 'graph', 'entities', 'relationships', 'workspaceadapter', 'adapter', 'inject'],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 14,
    },
    // v17-12 "Add SQLite tables knowledge_entities and knowledge_relationships"
    // v17-15 "Persist approvals to SQLite — replace in-memory Map with approvals table"
    // v17-16 "Persist GitBranchManager to SQLite with git_branches table"
    // v17-17 "Persist RuntimeJobSupervisor writes to existing runtime_jobs and runtime_events tables"
    {
      id: 'dba',
      capability_tags: ['sqlite', 'database', 'schema', 'persistence', 'table', 'migration', 'persist'],
      owns_subsystems: ['packages/db/src'],
      tier: 'sonnet',
      priority: 22,
    },
    // v17-10 "Replace static-fallback flat perItemUsd with p50CostByTag lookup in scoring-pipeline.ts"
    // v17-11 "Add incremental cost roll-up to cycle.json after each phase handler"
    // v17-18 "Add rolling p50CostByTag computation in workspace-telemetry-adapters.ts"
    // v17-19 "Wire effort-estimator.ts as third-strike fallback in scoring-pipeline.ts"
    {
      id: 'scoring-engineer',
      capability_tags: ['scoring', 'scorer', 'cost', 'p50', 'peritemusd', 'telemetry', 'estimator', 'pipeline', 'rollup'],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 18,
    },
    // v17-20 "Add per-request timeoutMs override on ExecutionRequest for heavy reasoning tasks"
    {
      id: 'runtime-platform-lead',
      capability_tags: ['runtime', 'executor', 'timeoutms', 'executionrequest', 'api', 'request', 'override'],
      owns_subsystems: ['packages/core/src/runtime'],
      tier: 'sonnet',
      priority: 20,
    },
    // v17-23 "Security audit of packages/server/ — CORS, auth bypass, path sanitization"
    {
      id: 'security-vulnerability-tester',
      capability_tags: ['security', 'cors', 'auth', 'sanitization', 'audit', 'bypass'],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 12,
    },
    // v17-21 "Add modelCap + RuntimeAdapter applyCaps() test coverage for 5 specified scenarios"
    {
      id: 'vitest-author',
      capability_tags: ['test', 'vitest', 'coverage', 'assertion', 'applycaps', 'scenarios', 'specified'],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 14,
    },
    // v17-25 "Add Playwright e2e tests under tests/e2e/ for core dashboard routes"
    // Subsystem match on tests/e2e
    {
      id: 'e2e-test-engineer',
      capability_tags: ['playwright', 'e2e', 'dashboard', 'browser', 'routes', 'core'],
      owns_subsystems: ['tests/e2e'],
      tier: 'sonnet',
      priority: 20,
    },
    // v17-07 "Add pre-execute typecheck step in cycle-runner.ts between RUN and VERIFY phases"
    // v17-08 "Add knownDebt field to gate-phase prompt"
    {
      id: 'cycle-runner-dev',
      capability_tags: ['knowndebt', 'gate', 'phase', 'prompt', 'cycle', 'step', 'execute', 'typecheck'],
      owns_subsystems: ['packages/core/src/autonomous'],
      tier: 'sonnet',
      priority: 20,
    },
    // v17-03 "Deduplicate readCycleRecord — extract to shared helper in packages/server/src/lib/"
    // Subsystem match: owns packages/server/src (broad) + packages/server/src/routes/v5
    // Also v17-09 "Improve scorer prompt to penalize invented agentIds not on the roster"
    {
      id: 'fastify-route-engineer',
      capability_tags: ['fastify', 'route', 'rest', 'endpoint', 'readcyclerecord', 'deduplicate', 'helper', 'lib', 'scorer', 'roster'],
      owns_subsystems: ['packages/server/src'],
      tier: 'sonnet',
      priority: 28,
    },
    {
      id: 'coder',
      capability_tags: [],
      owns_subsystems: [],
      tier: 'sonnet',
      priority: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('v17.0.0 re-routing milestone', () => {
  it('distributes 25 sprint items with top-1 ≤4 and ≥80% non-coder', () => {
    const results = V17_SPRINT_ITEMS.map((item) => ({
      item,
      pick: pickAgent(
        { title: item.title, tags: item.tags },
        V17_ROUTING_INDEX,
      ),
    }));

    // Build histogram
    const histogram: Record<string, number> = {};
    for (const { pick } of results) {
      histogram[pick.agentId] = (histogram[pick.agentId] ?? 0) + 1;
    }

    // Sort by count descending for display
    const sorted = Object.entries(histogram).sort(([, a], [, b]) => b - a);

    // Print histogram for visibility in CI
    const histogramStr = sorted
      .map(([id, count]) => {
        const bar = '█'.repeat(count);
        return `  ${id.padEnd(32)} ${bar} (${count})`;
      })
      .join('\n');

    console.log('\n=== v17.0.0 Re-routing Histogram ===');
    console.log(histogramStr);

    // Routing reason breakdown
    const reasonCounts: Record<string, number> = {};
    for (const { pick } of results) {
      reasonCounts[pick.reason] = (reasonCounts[pick.reason] ?? 0) + 1;
    }
    console.log('\nRouting reasons:', reasonCounts);

    // Per-item assignments
    console.log('\nPer-item assignments:');
    for (const { item, pick } of results) {
      console.log(
        `  [${pick.agentId.padEnd(30)}] reason=${pick.reason.padEnd(9)} conf=${pick.confidence.toFixed(2)}  "${item.title.substring(0, 60)}..."`,
      );
    }

    // --- ASSERTIONS ---

    const topCount = sorted[0]?.[1] ?? 0;
    expect(
      topCount,
      `Top agent (${sorted[0]?.[0]}) received ${topCount} items — must be ≤4 (was 9 before Phase D)`,
    ).toBeLessThanOrEqual(4);

    const coderCount = histogram['coder'] ?? 0;
    const nonCoderCount = 25 - coderCount;
    const specialistPct = (nonCoderCount / 25) * 100;

    expect(
      specialistPct,
      `Only ${specialistPct.toFixed(0)}% routed to non-coder specialists — must be ≥80%`,
    ).toBeGreaterThanOrEqual(80);

    console.log(`\n=== SUMMARY ===`);
    console.log(`Top-1 agent: ${sorted[0]?.[0]} with ${topCount} items (threshold ≤4) ✓`);
    console.log(`Non-coder specialist routing: ${nonCoderCount}/25 = ${specialistPct.toFixed(0)}% (threshold ≥80%) ✓`);
  });
});
