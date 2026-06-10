// packages/core/src/autonomous/__tests__/preview-objective.test.ts
//
// Unit tests for the objective dry-run (spec 2026-05-30 §13 m3). All planner
// calls are mocked — no LLM, no git. Mirrors the fixture style of
// decompose/__tests__/decompose-objective.test.ts.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewObjective } from '../preview-objective.js';

function planJson(epicIdPrefix: string, children: unknown): string {
  // previewObjective generates its own epic id; the schema does not require
  // the planner's epicId to match, so a fixed string is fine.
  return JSON.stringify({ epicId: `${epicIdPrefix}`, rationale: 'r', children });
}

// c2 shares shared.ts with c1 but declares no predecessor — the validator's
// file-overlap pass must synthesize the c1 -> c2 edge and push c2 to wave 1.
const overlappingChildren = [
  { id: 'c1', title: 'types', description: 'd', files: ['shared.ts'], capabilityTags: ['types'],
    suggestedAssignee: 'eng', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [] },
  { id: 'c2', title: 'api', description: 'd', files: ['shared.ts', 'api.ts'], capabilityTags: ['route'],
    suggestedAssignee: 'eng', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: [] },
];

const cyclicChildren = [
  { id: 'c1', title: 'a', description: 'd', files: ['a.ts'], capabilityTags: ['x'],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: ['c2'] },
  { id: 'c2', title: 'b', description: 'd', files: ['b.ts'], capabilityTags: ['y'],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: ['c1'] },
];

function mockRuntime(outputs: string[]) {
  let i = 0;
  const prompts: string[] = [];
  return {
    prompts,
    run: async (_agentId: string, task: string) => {
      prompts.push(task);
      return { output: outputs[i++]!, costUsd: 0.5, model: 'fable' };
    },
  };
}

describe('previewObjective — ok path', () => {
  it('returns waves, per-wave costs, file overlaps, and the budget band', async () => {
    const runtime = mockRuntime([planJson('e1', overlappingChildren)]);
    // spendable = (12 − 6) / 1.2 = 5.0; sum = 5.0 → within [3.5, 5.0]
    const result = await previewObjective(
      { projectRoot: '/nonexistent-root', objective: 'Build the thing\nDetails here', budgetUsd: 12, artifactDir: null },
      runtime,
    );

    expect(result.status).toBe('ok');
    expect(result.objective.title).toBe('Build the thing');
    expect(result.plan!.children).toHaveLength(2);

    // File overlap forced c2 after c1 → two waves.
    expect(result.fileOverlaps).toEqual([
      { from: 'c1', to: 'c2', sharedFiles: ['shared.ts'] },
    ]);
    expect(result.waves).toEqual([
      { wave: 0, childIds: ['c1'], estCostUsd: 2 },
      { wave: 1, childIds: ['c2'], estCostUsd: 3 },
    ]);
    expect(result.summary?.waveCount).toBe(2);
    expect(result.summary?.maxWaveWidth).toBe(1);
    expect(result.criticalPathLength).toBe(2);

    expect(result.report?.budget).toMatchObject({
      budgetUsd: 12,
      spendableUsd: 5,
      sumUsd: 5,
      withinBand: true,
    });
    expect(result.plannerCostUsd).toBeCloseTo(0.5);
    expect(result.repaired).toBe(false);
    expect(result.warnings.some((w) => w.includes('file overlap'))).toBe(true);
    expect(result.artifactDir).toBeNull();
  });

  it('marks the repair path and sums both planner calls', async () => {
    const runtime = mockRuntime([planJson('e1', cyclicChildren), planJson('e1', overlappingChildren)]);
    const result = await previewObjective(
      { projectRoot: '/nonexistent-root', objective: 'obj', budgetUsd: 12, artifactDir: null },
      runtime,
    );
    expect(result.status).toBe('ok');
    expect(result.repaired).toBe(true);
    expect(result.plannerCostUsd).toBeCloseTo(1.0);
    expect(result.warnings.some((w) => w.includes('repair retry'))).toBe(true);
  });
});

describe('previewObjective — invalid path', () => {
  it('surfaces a budget-band failure with the band numbers and incurred cost', async () => {
    // budget 50 → spendable ≈ 36.67, band [25.67, 36.67]; sum 5 → under-band twice.
    const runtime = mockRuntime([
      planJson('e1', overlappingChildren),
      planJson('e1', overlappingChildren),
    ]);
    const result = await previewObjective(
      { projectRoot: '/nonexistent-root', objective: 'obj', budgetUsd: 50, artifactDir: null },
      runtime,
    );
    expect(result.status).toBe('invalid');
    expect(result.error?.reason).toBe('budget');
    expect(result.report?.budget?.withinBand).toBe(false);
    expect(result.report?.budget?.sumUsd).toBe(5);
    // Both failed planner calls were still paid for.
    expect(result.plannerCostUsd).toBeCloseTo(1.0);
  });
});

describe('previewObjective — persistence', () => {
  it('writes objective.json, decomposition.json, and preview.json to the artifact dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-preview-'));
    try {
      const artifactDir = join(root, '.agentforge', 'previews', 'objective-test');
      const runtime = mockRuntime([planJson('e1', overlappingChildren)]);
      const result = await previewObjective(
        { projectRoot: root, objective: 'obj', budgetUsd: 12, artifactDir },
        runtime,
      );
      expect(result.artifactDir).toBe(artifactDir);
      const objectiveJson = JSON.parse(readFileSync(join(artifactDir, 'objective.json'), 'utf8'));
      expect(objectiveJson.id).toMatch(/^epic-preview-/);
      const decomposition = JSON.parse(readFileSync(join(artifactDir, 'decomposition.json'), 'utf8'));
      expect(decomposition.children).toHaveLength(2);
      expect(decomposition.validationReport.waveCount).toBe(2);
      const preview = JSON.parse(readFileSync(join(artifactDir, 'preview.json'), 'utf8'));
      expect(preview.status).toBe('ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults to .agentforge/previews/ (never .agentforge/cycles/) and skips writes when artifactDir is null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-preview-default-'));
    try {
      const runtime = mockRuntime([planJson('e1', overlappingChildren)]);
      const withDefault = await previewObjective(
        { projectRoot: root, objective: 'obj', budgetUsd: 12 },
        runtime,
      );
      // A preview dir under cycles/ would surface as a phantom cycle in
      // `cycle list` — the default home is .agentforge/previews/.
      expect(withDefault.artifactDir).toContain(join('.agentforge', 'previews', 'objective-'));
      expect(existsSync(join(root, '.agentforge', 'cycles'))).toBe(false);

      const runtime2 = mockRuntime([planJson('e1', overlappingChildren)]);
      const noPersist = await previewObjective(
        { projectRoot: root, objective: 'obj', budgetUsd: 12, artifactDir: null },
        runtime2,
      );
      expect(noPersist.artifactDir).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('previewObjective — observed-cost calibration threading', () => {
  it('surfaces prior spend-report actuals to the planner prompt via projectRoot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-preview-calib-'));
    try {
      const dir = join(root, '.agentforge', 'cycles', 'c1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'spend-report.json'),
        JSON.stringify({ perItem: [{ itemId: 'a', status: 'completed', actualUsd: 2.5 }] }),
      );
      const runtime = mockRuntime([planJson('e1', overlappingChildren)]);
      await previewObjective(
        { projectRoot: root, objective: 'obj', budgetUsd: 12, artifactDir: null },
        runtime,
      );
      expect(runtime.prompts[0]).toContain('OBSERVED in this repository (1 completed child item(s)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
