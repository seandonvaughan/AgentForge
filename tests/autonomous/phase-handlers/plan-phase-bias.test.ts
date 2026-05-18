// tests/autonomous/phase-handlers/plan-phase-bias.test.ts
//
// Tests for the quality-bias pre-hook in plan-phase.ts.
// Covers:
//   - Empty history → no hints emitted (regression test for pre-Wave-4 behaviour)
//   - 100 records biased toward agent-X → hint emitted with agent-X as top suggestion
//   - --no-quality-bias / AGENTFORGE_NO_QUALITY_BIAS=1 → hook disabled
//   - Hints written back to plan.json

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  preAssignByQualityHistory,
} from '../../../packages/core/src/autonomous/phase-handlers/plan-phase.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'plan-phase-bias-'));
  delete process.env['AGENTFORGE_NO_QUALITY_BIAS'];
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env['AGENTFORGE_NO_QUALITY_BIAS'];
});

function writeScores(lines: object[]) {
  const memDir = join(tmpRoot, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'step-scores.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

function makeItem(overrides: Partial<{
  id: string;
  title: string;
  tags: string[];
  kind: string;
  capabilityTags: string[];
}> = {}) {
  return {
    id: overrides.id ?? 'item-1',
    title: overrides.title ?? 'Test item',
    tags: overrides.tags ?? ['feature'],
    ...(overrides.kind ? { kind: overrides.kind } : {}),
    ...(overrides.capabilityTags ? { capabilityTags: overrides.capabilityTags } : {}),
  };
}

// ---------------------------------------------------------------------------
// Regression test: empty history → behaviour identical to pre-Wave-4
// ---------------------------------------------------------------------------

describe('empty history — regression', () => {
  it('does not add assignment_hint when no step-scores.jsonl exists', () => {
    const items = [makeItem()];
    preAssignByQualityHistory(items, tmpRoot);
    expect(items[0]!.assignment_hint).toBeUndefined();
  });

  it('does not add assignment_hint when history has no matching records', () => {
    writeScores([
      { agent_id: 'agent-A', item_kind: 'fix', capability_tag: 'bar', utility: 0.9, count: 10 },
    ]);
    const items = [makeItem({ tags: ['feature'], kind: 'feature', capabilityTags: ['foo'] })];
    preAssignByQualityHistory(items, tmpRoot);
    expect(items[0]!.assignment_hint).toBeUndefined();
  });

  it('does not add assignment_hint when matching records exist but below min-observations gate', () => {
    const records = Array.from({ length: 4 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.9,
    }));
    writeScores(records);
    const items = [makeItem({ kind: 'feature', capabilityTags: ['foo'] })];
    preAssignByQualityHistory(items, tmpRoot);
    expect(items[0]!.assignment_hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 100-record bias toward agent-X for capability 'foo'
// ---------------------------------------------------------------------------

describe('100-record bias — agent-X for capability foo', () => {
  it('emits agent-X as top suggestion for items with capability foo', () => {
    const biasedRecords = Array.from({ length: 100 }, () => ({
      agent_id: 'agent-X',
      model: 'sonnet',
      skill_ids: ['skill-alpha'],
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.95,
    }));
    writeScores(biasedRecords);

    const items = [makeItem({ kind: 'feature', capabilityTags: ['foo'] })];
    preAssignByQualityHistory(items, tmpRoot);

    expect(items[0]!.assignment_hint).toBeDefined();
    expect(items[0]!.assignment_hint!.agent_id).toBe('agent-X');
    expect(items[0]!.assignment_hint!.model).toBe('sonnet');
    expect(items[0]!.assignment_hint!.skill_ids).toEqual(['skill-alpha']);
    expect(items[0]!.assignment_hint!.confidence).toBeGreaterThan(0);
  });

  it('does not emit hints for items with unrelated capability tags', () => {
    const biasedRecords = Array.from({ length: 100 }, () => ({
      agent_id: 'agent-X',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.95,
    }));
    writeScores(biasedRecords);

    const items = [makeItem({ kind: 'feature', capabilityTags: ['bar'] })];
    preAssignByQualityHistory(items, tmpRoot);

    expect(items[0]!.assignment_hint).toBeUndefined();
  });

  it('processes multiple items independently', () => {
    const fooRecords = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-X',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.95,
    }));
    const barRecords = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-Y',
      item_kind: 'fix',
      capability_tag: 'bar',
      utility: 0.8,
    }));
    writeScores([...fooRecords, ...barRecords]);

    const items = [
      makeItem({ id: 'item-1', kind: 'feature', capabilityTags: ['foo'] }),
      makeItem({ id: 'item-2', kind: 'fix', capabilityTags: ['bar'] }),
      makeItem({ id: 'item-3', kind: 'docs', capabilityTags: ['unrelated'] }),
    ];
    preAssignByQualityHistory(items, tmpRoot);

    expect(items[0]!.assignment_hint!.agent_id).toBe('agent-X');
    expect(items[1]!.assignment_hint!.agent_id).toBe('agent-Y');
    expect(items[2]!.assignment_hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// --no-quality-bias / AGENTFORGE_NO_QUALITY_BIAS=1
// ---------------------------------------------------------------------------

describe('quality bias disabled', () => {
  it('does not emit hints when options.noQualityBias=true', () => {
    const records = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-X',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.9,
    }));
    writeScores(records);

    const items = [makeItem({ kind: 'feature', capabilityTags: ['foo'] })];
    preAssignByQualityHistory(items, tmpRoot, { noQualityBias: true });

    expect(items[0]!.assignment_hint).toBeUndefined();
  });

  it('does not emit hints when AGENTFORGE_NO_QUALITY_BIAS=1', () => {
    process.env['AGENTFORGE_NO_QUALITY_BIAS'] = '1';
    const records = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-X',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.9,
    }));
    writeScores(records);

    const items = [makeItem({ kind: 'feature', capabilityTags: ['foo'] })];
    preAssignByQualityHistory(items, tmpRoot);

    expect(items[0]!.assignment_hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tag-based kind derivation (when item.kind is absent)
// ---------------------------------------------------------------------------

describe('kind derivation from tags', () => {
  it('derives kind=fix from bug tag', () => {
    const records = Array.from({ length: 5 }, () => ({
      agent_id: 'agent-bug-fixer',
      item_kind: 'fix',
      capability_tag: 'bugfix',
      utility: 0.9,
    }));
    writeScores(records);

    const items = [makeItem({ tags: ['bug', 'bugfix'] })]; // no explicit kind
    preAssignByQualityHistory(items, tmpRoot);

    // item kind should be derived as 'fix' and match the records
    expect(items[0]!.assignment_hint).toBeDefined();
    expect(items[0]!.assignment_hint!.agent_id).toBe('agent-bug-fixer');
  });
});

// ---------------------------------------------------------------------------
// Hint written back to plan.json via runPlanPhase integration
// (lighter integration test — verifies the file-write path without LLM call)
// ---------------------------------------------------------------------------

describe('plan.json write-back', () => {
  it('plan.json items contain assignment_hint after preAssignByQualityHistory', () => {
    const cycleId = 'test-cycle-001';
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });

    const records = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-X',
      model: 'opus',
      skill_ids: ['skill-plan'],
      item_kind: 'feature',
      capability_tag: 'planning',
      utility: 0.9,
    }));
    writeScores(records);

    const planJson = {
      items: [
        {
          id: 'T1',
          title: 'Add planning subsystem',
          kind: 'feature',
          capabilityTags: ['planning'],
          tags: ['feature'],
        },
      ],
    };
    writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(planJson, null, 2), 'utf8');

    // Simulate what runPlanPhase does: read plan.json, run hook, write back
    const rawPlan = JSON.parse(readFileSync(join(cycleDir, 'plan.json'), 'utf8'));
    const items = rawPlan.items;
    preAssignByQualityHistory(items, tmpRoot);
    rawPlan.items = items;
    writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(rawPlan, null, 2), 'utf8');

    const written = JSON.parse(readFileSync(join(cycleDir, 'plan.json'), 'utf8'));
    expect(written.items[0].assignment_hint).toBeDefined();
    expect(written.items[0].assignment_hint.agent_id).toBe('agent-X');
  });
});
