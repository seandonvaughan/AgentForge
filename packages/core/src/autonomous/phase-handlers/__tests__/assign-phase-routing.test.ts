// packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-routing.test.ts
//
// End-to-end test: fixture sprint plan + routing-index.json;
// runs runAssignPhase and verifies specialized routing (not all to coder).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAssignPhase, clearRoutingIndexCache, applyJobRouting } from '../assign-phase.js';
import type { PhaseContext } from '../../phase-scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'assign-phase-routing-'));
  clearRoutingIndexCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  clearRoutingIndexCache();
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => events.push({ topic, payload }),
    subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
    events,
  };
}

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext & { bus: ReturnType<typeof makeBus> } {
  const bus = makeBus();
  return {
    sprintId: 'sprint-routing-test',
    sprintVersion: 'routing-test',
    projectRoot: tmpRoot,
    adapter: {},
    bus,
    runtime: {},
    cycleId: 'cycle-routing-001',
    ...overrides,
  } as PhaseContext & { bus: ReturnType<typeof makeBus> };
}

function writePlan(cycleId: string, items: unknown[]) {
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify({ items }, null, 2), 'utf8');
}

function writeRoutingIndex(index: unknown) {
  const agentforgeDir = join(tmpRoot, '.agentforge');
  mkdirSync(agentforgeDir, { recursive: true });
  writeFileSync(join(agentforgeDir, 'routing-index.json'), JSON.stringify(index, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAssignPhase with routing index', () => {
  it('uses routing index to assign specialized agents', async () => {
    const routingIndex = {
      team_name: 'test-team',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        {
          id: 'fastify-route-engineer',
          capability_tags: ['fastify', 'rest', 'route', 'endpoint'],
          owns_subsystems: ['packages/server/src/routes/v5'],
          tier: 'sonnet',
          priority: 18,
        },
        {
          id: 'svelte-runes-engineer',
          capability_tags: ['svelte', 'runes', 'ui', 'dashboard'],
          owns_subsystems: ['packages/dashboard/src'],
          tier: 'sonnet',
          priority: 16,
        },
        {
          id: 'vitest-author',
          capability_tags: ['test', 'vitest', 'unit-test'],
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
      ],
    };

    writeRoutingIndex(routingIndex);

    const cycleId = 'cycle-routing-001';
    writePlan(cycleId, [
      {
        id: 'item-1',
        title: 'Fix endpoint in packages/server/src/routes/v5/cycles.ts',
        tags: [],
      },
      {
        id: 'item-2',
        title: 'Fix svelte ui runes layout in dashboard',
        tags: ['svelte', 'ui'],
      },
      {
        id: 'item-3',
        title: 'Add vitest unit test coverage for routing module',
        tags: ['test', 'vitest'],
      },
      {
        id: 'item-4',
        title: 'Update some random config thing',
        tags: [],
      },
    ]);

    const ctx = makeCtx({ cycleId });
    const result = await runAssignPhase(ctx);

    expect(result.status).toBe('completed');

    // Read back the plan to check assignments
    const { readFileSync } = await import('node:fs');
    const plan = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', cycleId, 'plan.json'), 'utf8'),
    ) as { items: Array<{ id: string; assignee?: string }> };

    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i.assignee]));

    expect(byId['item-1']).toBe('fastify-route-engineer');
    expect(byId['item-2']).toBe('svelte-runes-engineer');
    expect(byId['item-3']).toBe('vitest-author');
    // item-4 has no signals → coder fallback
    expect(byId['item-4']).toBe('coder');
  });

  it('falls back to keyword logic when no routing-index.json exists', async () => {
    const cycleId = 'cycle-fallback-001';
    writePlan(cycleId, [
      { id: 'i1', title: 'Write some docs', tags: ['docs'] },
      { id: 'i2', title: 'Fix a bug', tags: ['bug'] },
      { id: 'i3', title: 'Write tests', tags: ['test'] },
    ]);

    const ctx = makeCtx({ cycleId });
    const result = await runAssignPhase(ctx);

    expect(result.status).toBe('completed');

    const { readFileSync } = await import('node:fs');
    const plan = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', cycleId, 'plan.json'), 'utf8'),
    ) as { items: Array<{ id: string; assignee?: string }> };

    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i.assignee]));

    expect(byId['i1']).toBe('backend-tech-writer');
    expect(byId['i2']).toBe('coder');
    expect(byId['i3']).toBe('backend-qa');
  });

  it('does not overwrite pre-assigned items', async () => {
    writeRoutingIndex({
      team_name: 'test',
      generated_at: '2026-05-17T00:00:00.000Z',
      agents: [
        { id: 'fastify-route-engineer', capability_tags: ['fastify', 'route'], owns_subsystems: [], tier: 'sonnet', priority: 8 },
        { id: 'coder', capability_tags: [], owns_subsystems: [], tier: 'sonnet', priority: 0 },
      ],
    });

    const cycleId = 'cycle-preassign-001';
    writePlan(cycleId, [
      { id: 'i1', title: 'Pre-assigned item', tags: ['fastify', 'route'], assignee: 'architect' },
    ]);

    const ctx = makeCtx({ cycleId });
    await runAssignPhase(ctx);

    const { readFileSync } = await import('node:fs');
    const plan = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', cycleId, 'plan.json'), 'utf8'),
    ) as { items: Array<{ id: string; assignee?: string }> };

    // Pre-assigned value must be preserved
    expect(plan.items[0]!.assignee).toBe('architect');
  });
});

// ---------------------------------------------------------------------------
// applyJobRouting — unit tests for per-item provider routing + forced mode
// ---------------------------------------------------------------------------

describe('applyJobRouting', () => {
  it('REGRESSION GUARD: default path (no forcedMode) routes low-complexity item to codex-cli', () => {
    const item: {
      id: string;
      title: string;
      estimatedComplexity: 'low';
      preferredProvider?: string;
      runtimeMode?: string;
      tier?: string;
      effort?: string;
      providerPreference?: string[];
    } = {
      id: 'reg-1',
      title: 'update README links',
      estimatedComplexity: 'low',
    };
    // Call with no forcedMode at all (undefined)
    applyJobRouting(item as Parameters<typeof applyJobRouting>[0]);
    expect(item.preferredProvider).toBe('codex-cli');
    expect(item.tier).toBeDefined();
  });

  it('REGRESSION GUARD: explicit undefined forcedMode routes low-complexity item to codex-cli', () => {
    const item: {
      id: string;
      title: string;
      estimatedComplexity: 'low';
      preferredProvider?: string;
      runtimeMode?: string;
      tier?: string;
      effort?: string;
      providerPreference?: string[];
    } = {
      id: 'reg-2',
      title: 'update README links',
      estimatedComplexity: 'low',
    };
    applyJobRouting(item as Parameters<typeof applyJobRouting>[0], undefined, undefined);
    expect(item.preferredProvider).toBe('codex-cli');
    expect(item.tier).toBeDefined();
  });

  it('forced claude-code-compat: low-complexity item gets a Claude-family preferredProvider', () => {
    const item: {
      id: string;
      title: string;
      estimatedComplexity: 'low';
      preferredProvider?: string;
      runtimeMode?: string;
      tier?: string;
      effort?: string;
      providerPreference?: string[];
    } = {
      id: 'forced-1',
      title: 'update README links',
      estimatedComplexity: 'low',
    };
    applyJobRouting(item as Parameters<typeof applyJobRouting>[0], undefined, 'claude-code-compat');
    expect(item.preferredProvider).not.toBe('codex-cli');
    expect(['anthropic-sdk', 'claude-code-compat'] as const).toContain(item.preferredProvider as string);
    expect(item.providerPreference?.[0]).not.toBe('codex-cli');
    expect(item.tier).toBeDefined();
  });
});
