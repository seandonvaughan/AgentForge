/**
 * Integration tests: cost-prediction calibration chain
 *
 * These tests wire together the real filesystem, the real
 * `createAutonomousTelemetryAdapters` adapter, and the real `ScoringPipeline`
 * to verify that tag-specific p50 values computed from historical cycle
 * directories flow through to the scoring pipeline's fallback cost estimates.
 *
 * They are deliberately distinct from the unit tests in
 *   packages/core/src/autonomous/__tests__/scoring-pipeline-fallback.test.ts
 * which use mock adapters, and from
 *   packages/core/src/autonomous/__tests__/workspace-telemetry-adapters.test.ts
 * which test the adapter in isolation. These tests cover the full chain:
 *   cycle dirs on disk → real adapter → real ScoringPipeline → calibrated estimates
 *
 * A regression in any seam of this chain (file reading, median computation,
 * adapter↔pipeline wiring, or fallback cost lookup) will cause a test failure
 * here, catching the problem before it reaches the gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import {
  createAutonomousTelemetryAdapters,
  ScoringPipeline,
  DEFAULT_CYCLE_CONFIG,
  ROLLING_P50_COST_WINDOW_CYCLES,
  computeRollingP50CostByTagFromCycles,
} from '@agentforge/core';
import type {
  RuntimeForScoring,
  ScoringPipelineResult,
  AdapterForScoring,
} from '@agentforge/core';
import type { CycleLogger } from '@agentforge/core';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write a minimal cycle directory with cycle.json + plan.json. */
function makeCycleDir(
  cyclesDir: string,
  id: string,
  totalUsd: number,
  items: Array<{ tags: string[] }>,
): void {
  const dir = join(cyclesDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cycle.json'),
    JSON.stringify({ cycleId: id, cost: { totalUsd } }),
  );
  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({
      items: items.map((item, i) => ({
        id: `${id}-item-${i}`,
        title: `Item ${i} from ${id}`,
        tags: item.tags,
      })),
    }),
  );
}

/** Write a minimal sprint history file. */
function makeSprintFile(
  sprintsDir: string,
  version: string,
  opts: { itemCount: number; completedCount: number; avgItemCostUsd: number },
): void {
  writeFileSync(
    join(sprintsDir, `v${version}.json`),
    JSON.stringify({
      version,
      title: `Sprint ${version}`,
      phase: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      items: Array.from({ length: opts.itemCount }, (_, i) => ({
        id: `${version}-item-${i}`,
        status: i < opts.completedCount ? 'completed' : 'planned',
      })),
      avgItemCostUsd: opts.avgItemCostUsd,
    }),
  );
}

/** A runtime that always rejects — forces the fallback ladder. */
function makeFailingRuntime(): RuntimeForScoring {
  return {
    run: vi.fn().mockRejectedValue(new Error('LLM unavailable in test')),
  };
}

/** Minimal CycleLogger stub — just enough to satisfy the interface. */
function makeLogger(): CycleLogger {
  return {
    logScoring: vi.fn(),
    logScoringFallback: vi.fn(),
    logKillSwitch: vi.fn(),
    logCycleResult: vi.fn(),
    logGitEvent: vi.fn(),
    logTestRun: vi.fn(),
    logPREvent: vi.fn(),
  } as unknown as CycleLogger;
}

/** Low-budget config — makes budget overflow easy to trigger for overflow tests. */
function makeTestConfig(overrides: { perCycleUsd?: number; maxRetries?: number } = {}) {
  return {
    ...DEFAULT_CYCLE_CONFIG,
    budget: {
      ...DEFAULT_CYCLE_CONFIG.budget,
      perCycleUsd: overrides.perCycleUsd ?? 50,
      perItemUsd: 1.5,
    },
    scoring: {
      ...DEFAULT_CYCLE_CONFIG.scoring,
      maxRetries: overrides.maxRetries ?? 1,
      fallbackToStatic: true,
    },
    limits: {
      ...DEFAULT_CYCLE_CONFIG.limits,
      maxItemsPerSprint: 20,
    },
  };
}

/** Type-cast helper to call the private staticFallback method on ScoringPipeline. */
function callStaticFallback(
  pipeline: ScoringPipeline,
  backlog: Parameters<ScoringPipeline['scoreWithFallback']>[0],
): Promise<ScoringPipelineResult> {
  return (pipeline as unknown as { staticFallback: (b: typeof backlog) => Promise<ScoringPipelineResult> })
    .staticFallback(backlog);
}

// ---------------------------------------------------------------------------
// Test setup: fresh temp dir per test
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cost-cal-'));
  mkdirSync(join(projectRoot, '.agentforge', 'cycles'), { recursive: true });
  mkdirSync(join(projectRoot, '.agentforge', 'sprints'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Suite 1: static fallback reads p50 calibration from real cycle dirs
// ---------------------------------------------------------------------------

describe('cost-calibration integration: static fallback uses real p50 from cycle dirs', () => {
  // Fixture math (deterministic — no random values):
  //
  // Cycle A: totalUsd=$15, 3 items → avg=$5/item
  //   tags: ['fix'], ['fix'], ['feature']
  //   records: fix→5, fix→5, feature→5
  //
  // Cycle B: totalUsd=$3, 3 items → avg=$1/item
  //   tags: ['fix'], ['fix'], ['fix']
  //   records: fix→1, fix→1, fix→1
  //
  // Cycle C: totalUsd=$6, 2 items → avg=$3/item
  //   tags: ['fix'], ['feature']
  //   records: fix→3, feature→3
  //
  // Expected p50 (median):
  //   fix:     observations=[5,5,1,1,1,3] sorted=[1,1,1,3,5,5] → (1+3)/2 = 2
  //   feature: observations=[5,3]         sorted=[3,5]         → (3+5)/2 = 4
  //
  // The ratio feature/fix = 2, confirming the calibration captures
  // the cost difference between tag families.

  it('uses tag-specific p50 costs instead of flat perItemUsd default', async () => {
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
    makeCycleDir(cyclesDir, 'cycle-a', 15, [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['feature'] }]);
    makeCycleDir(cyclesDir, 'cycle-b',  3, [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['fix'] }]);
    makeCycleDir(cyclesDir, 'cycle-c',  6, [{ tags: ['fix'] }, { tags: ['feature'] }]);

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const backlog = [
        { id: 'f1', title: 'Fix auth bug',    description: '', priority: 'P1' as const, tags: ['fix'],     source: 'todo-marker' as const, confidence: 0.8 },
        { id: 'f2', title: 'New dashboard',   description: '', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 0.8 },
        { id: 'f3', title: 'Fix memory leak', description: '', priority: 'P2' as const, tags: ['fix'],     source: 'todo-marker' as const, confidence: 0.7 },
      ];

      const result = await callStaticFallback(pipeline, backlog);

      const all = [...result.withinBudget, ...result.requiresApproval];
      const fixItem    = all.find(r => r.itemId === 'f1');
      const featureItem = all.find(r => r.itemId === 'f2');
      const fix2Item   = all.find(r => r.itemId === 'f3');

      // Tag-specific p50 costs should be used, NOT the flat $1.50 default.
      expect(fixItem?.estimatedCostUsd).toBeCloseTo(2, 1);     // p50('fix') = 2
      expect(featureItem?.estimatedCostUsd).toBeCloseTo(4, 1); // p50('feature') = 4
      expect(fix2Item?.estimatedCostUsd).toBeCloseTo(2, 1);    // p50('fix') = 2

      // 'feature' must cost more than 'fix' — regression guard.
      expect(featureItem!.estimatedCostUsd).toBeGreaterThan(fixItem!.estimatedCostUsd);
    } finally {
      telemetry.close();
    }
  });

  it('falls back to flat perItemUsd ($1.50) when cycle dirs are empty', async () => {
    // No cycle dirs created — p50 map will be empty → defaultCost applies.
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const backlog = [
        { id: 'x', title: 'Mystery task', description: '', priority: 'P1' as const, tags: ['fix'], source: 'todo-marker' as const, confidence: 0.8 },
      ];

      const result = await callStaticFallback(pipeline, backlog);

      const item = [...result.withinBudget, ...result.requiresApproval].at(0);
      // With no cycle history, must fall back to perItemUsd = $1.50.
      expect(item?.estimatedCostUsd).toBeCloseTo(1.5, 2);
    } finally {
      telemetry.close();
    }
  });

  it('archived cycles also contribute to p50 calibration', async () => {
    // Archived cycles must be read even when active cycles dir is empty.
    // This guards against regressions where only the `cycles/` dir is scanned.
    const archivedDir = join(projectRoot, '.agentforge', 'cycles-archived');
    mkdirSync(archivedDir, { recursive: true });
    makeCycleDir(archivedDir, 'old-cycle', 8, [{ tags: ['chore'] }, { tags: ['chore'] }, { tags: ['chore'] }, { tags: ['chore'] }]);
    // avg = 8/4 = $2 per item → chore p50 = $2

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const backlog = [
        { id: 'c1', title: 'Update deps', description: '', priority: 'P2' as const, tags: ['chore'], source: 'todo-marker' as const, confidence: 0.7 },
      ];

      const result = await callStaticFallback(pipeline, backlog);
      const item = [...result.withinBudget, ...result.requiresApproval].at(0);

      // Must use the archived p50 ($2), not the flat default ($1.50).
      expect(item?.estimatedCostUsd).toBeCloseTo(2, 1);
      expect(item?.estimatedCostUsd).not.toBeCloseTo(1.5, 2);
    } finally {
      telemetry.close();
    }
  });

  it('returns fallback="static" discriminant from staticFallback', async () => {
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const result = await callStaticFallback(pipeline, [
        { id: 'a', title: 'A', description: '', priority: 'P1' as const, tags: ['fix'], source: 'todo-marker' as const, confidence: 0.8 },
      ]);

      expect(result.fallback).toBe('static');
    } finally {
      telemetry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: effort-estimator fallback uses sprint history for confidence
// ---------------------------------------------------------------------------

describe('cost-calibration integration: effort-estimator fallback uses real sprint history', () => {
  it('returns fallback="effort-estimator" when LLM fails and sprint history exists', async () => {
    const sprintsDir = join(projectRoot, '.agentforge', 'sprints');
    for (let i = 1; i <= 6; i++) {
      makeSprintFile(sprintsDir, `${i}.0`, { itemCount: 5, completedCount: 4, avgItemCostUsd: 1.5 });
    }

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const result = await pipeline.scoreWithFallback([
        { id: 'x', title: 'Task X', description: '', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 0.6 },
      ]);

      // With a failing LLM and valid sprint history, effort-estimator should fire.
      expect(result.fallback).toBe('effort-estimator');
    } finally {
      telemetry.close();
    }
  });

  it('sprint count drives confidence: 6 sprints → confidence ≈ 0.7', async () => {
    // HistoryAnalyzer formula: confidence = min(0.9, 0.4 + totalSprints * 0.05)
    // 6 sprints → min(0.9, 0.4 + 0.30) = 0.70
    const sprintsDir = join(projectRoot, '.agentforge', 'sprints');
    for (let i = 1; i <= 6; i++) {
      makeSprintFile(sprintsDir, `${i}.0`, { itemCount: 5, completedCount: 4, avgItemCostUsd: 1.5 });
    }

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const result = await pipeline.scoreWithFallback([
        { id: 'x', title: 'Task', description: '', priority: 'P1' as const, tags: [], source: 'todo-marker' as const, confidence: 0.5 },
      ]);

      const item = [...result.withinBudget, ...result.requiresApproval].at(0);
      // With 6 sprints, confidence should be ~0.70 (not 0.30 zero-data baseline).
      expect(item?.confidence).toBeGreaterThan(0.5);
      expect(item?.confidence).toBeCloseTo(0.7, 1);
    } finally {
      telemetry.close();
    }
  });

  it('zero sprint history produces 0.3 confidence (zero-data baseline)', async () => {
    // No sprint files — effort-estimator falls back to zero-data analysis.
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const result = await pipeline.scoreWithFallback([
        { id: 'x', title: 'Task', description: '', priority: 'P1' as const, tags: [], source: 'todo-marker' as const, confidence: 0.5 },
      ]);

      const item = [...result.withinBudget, ...result.requiresApproval].at(0);
      // Zero sprints → confidence = 0.3 (HistoryAnalyzer.analyze([]) zero-data floor).
      expect(item?.confidence).toBeCloseTo(0.3, 1);
    } finally {
      telemetry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: gatherGrounding() — p50 from real cycle dirs flows into LLM grounding
// ---------------------------------------------------------------------------

describe('cost-calibration integration: gatherGrounding() includes real p50 data', () => {
  it('grounding includes tag-specific p50 costs from cycle dirs', async () => {
    // This catches regressions where p50 values are computed correctly but
    // fail to reach the LLM scorer's prompt context (via gatherGrounding()).
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
    // fix p50: $2, feature p50: $4 (same fixture math as Suite 1)
    makeCycleDir(cyclesDir, 'cycle-a', 15, [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['feature'] }]);
    makeCycleDir(cyclesDir, 'cycle-b',  3, [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['fix'] }]);
    makeCycleDir(cyclesDir, 'cycle-c',  6, [{ tags: ['fix'] }, { tags: ['feature'] }]);

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const grounding = await pipeline.gatherGrounding() as Record<string, unknown>;

      // gatherGrounding() must surface p50CostByTag derived from real cycle dirs.
      // Regression: if p50CostByTag is missing or empty here, the LLM scorer
      // would operate without calibration data.
      expect(grounding).toHaveProperty('p50CostByTag');
      const p50 = grounding['p50CostByTag'] as Record<string, number>;
      expect(p50['fix']).toBeCloseTo(2, 1);
      expect(p50['feature']).toBeCloseTo(4, 1);
      // feature p50 must be greater than fix p50 — ratio captures cost differentiation.
      expect(p50['feature']).toBeGreaterThan(p50['fix']!);
    } finally {
      telemetry.close();
    }
  });

  it('grounding includes sprint history loaded from real sprint files', async () => {
    // Catches regressions where getSprintHistory() stops reading from the
    // correct .agentforge/sprints/ directory.
    const sprintsDir = join(projectRoot, '.agentforge', 'sprints');
    makeSprintFile(sprintsDir, '1.0', { itemCount: 5, completedCount: 4, avgItemCostUsd: 1.5 });
    makeSprintFile(sprintsDir, '2.0', { itemCount: 3, completedCount: 3, avgItemCostUsd: 2.0 });

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const grounding = await pipeline.gatherGrounding() as Record<string, unknown>;

      // Sprint history must be present and non-empty.
      // gatherGrounding() returns { history, costMedians, teamState, p50CostByTag }
      expect(grounding).toHaveProperty('history');
      const history = grounding['history'] as unknown[];
      expect(history.length).toBe(2);
    } finally {
      telemetry.close();
    }
  });

  it('grounding p50CostByTag is empty object when no cycle dirs exist', async () => {
    // Graceful degradation: no history → LLM scorer falls back to its own priors.
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const grounding = await pipeline.gatherGrounding() as Record<string, unknown>;
      const p50 = grounding['p50CostByTag'] as Record<string, number>;
      expect(p50).toEqual({});
    } finally {
      telemetry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Rolling window cap — ROLLING_P50_COST_WINDOW_CYCLES enforcement
// ---------------------------------------------------------------------------

describe('cost-calibration integration: rolling window cap', () => {
  // These tests call computeRollingP50CostByTagFromCycles directly with a
  // custom maxCycles to avoid creating 20+ cycle dirs in each test.

  it('excludes cycles beyond maxCycles from p50 computation', async () => {
    // Regression guard for the rolling-window cap:
    //   - 2 "old" cycles with 'oldtag' at $10/item (mtime stamped far in the past)
    //   - 3 "recent" cycles with 'newtag' at $4/item (natural mtime = now)
    // With maxCycles=3, only the 3 most-recent dirs must be selected.
    // If the cap were broken or removed, 'oldtag' would appear in the result.
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');

    // Create old cycles first, then overwrite their mtime with utimesSync.
    for (let i = 1; i <= 2; i++) {
      makeCycleDir(cyclesDir, `old-cycle-${i}`, 10, [{ tags: ['oldtag'] }]);
      const pastDate = new Date('2020-01-01T00:00:00.000Z');
      utimesSync(join(cyclesDir, `old-cycle-${i}`), pastDate, pastDate);
    }

    // Recent cycles (natural mtime ≫ 2020-01-01).
    for (let i = 1; i <= 3; i++) {
      makeCycleDir(cyclesDir, `recent-cycle-${i}`, 4, [{ tags: ['newtag'] }]);
    }

    // maxCycles=3 → only the 3 most-recent (newtag) dirs are selected.
    const p50 = computeRollingP50CostByTagFromCycles(projectRoot, 3);

    // newtag: avg = 4/1 = $4 across all 3 recent cycles → p50([4, 4, 4]) = $4.
    expect(p50['newtag']).toBeCloseTo(4, 1);
    // oldtag: excluded by rolling-window cap → must NOT appear.
    expect(p50['oldtag']).toBeUndefined();
  });

  it('includes ALL cycles within the window — not an off-by-one fewer', async () => {
    // Regression guard: the window cap must be an upper bound, not strict-less.
    // If implemented with < instead of <=, the last cycle in an exact-window
    // batch would be silently dropped, biasing the p50 estimate.
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');

    // Exactly 3 cycles, each contributing a distinct avgItemCost to 'xtag'.
    makeCycleDir(cyclesDir, 'w-cycle-1', 3, [{ tags: ['xtag'] }]); // avg = $3
    makeCycleDir(cyclesDir, 'w-cycle-2', 6, [{ tags: ['xtag'] }]); // avg = $6
    makeCycleDir(cyclesDir, 'w-cycle-3', 9, [{ tags: ['xtag'] }]); // avg = $9

    // With maxCycles=3 all three cycles must be included.
    // p50([3, 6, 9]) = $6 (middle value of sorted array).
    // If only 2 were included, p50 would be either 4.5 or 7.5 — not $6.
    const p50 = computeRollingP50CostByTagFromCycles(projectRoot, 3);
    expect(p50['xtag']).toBeCloseTo(6, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Calibration edge cases
// ---------------------------------------------------------------------------

describe('cost-calibration integration: calibration edge cases', () => {
  it('uses only the primary tag (tags[0]); secondary tags are irrelevant for p50', async () => {
    // Regression guard: computeRollingP50CostByTag must group observations by
    // tags[0] ONLY. If it iterated all tags, 'security' and 'urgent' would
    // appear as spurious p50 entries, skewing cost estimates for items that
    // happen to share a secondary tag with an expensive family.
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
    makeCycleDir(cyclesDir, 'multi-tag-cycle', 12, [
      { tags: ['fix', 'security'] },   // primary = 'fix'
      { tags: ['fix', 'feature'] },    // primary = 'fix'
      { tags: ['feature', 'urgent'] }, // primary = 'feature'
    ]);
    // avgItemCost = 12 / 3 = $4 per item
    // 'fix':     [4, 4] → p50 = 4
    // 'feature': [4]    → p50 = 4
    // 'security', 'urgent': secondary tags — must NOT appear in result

    const p50 = computeRollingP50CostByTagFromCycles(projectRoot, 10);

    expect(p50['fix']).toBeCloseTo(4, 1);
    expect(p50['feature']).toBeCloseTo(4, 1);
    // Secondary-tag entries must not be created.
    expect(p50['security']).toBeUndefined();
    expect(p50['urgent']).toBeUndefined();
  });

  it('items with no tags use flat perItemUsd in staticFallback, not a spurious p50 entry', async () => {
    // staticFallback cost lookup: p50CostByTag[item.tags[0] ?? ''] ?? defaultCost
    // When tags is empty, the lookup key is undefined → '' → p50CostByTag['']
    // is never populated (computeRollingP50CostByTag skips blank primary tags),
    // so defaultCost ($1.50) must apply instead of any tag p50.
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
    // 'fix' cycle at $10/item — distinctly different from the $1.50 flat default.
    makeCycleDir(cyclesDir, 'fix-cycle', 10, [{ tags: ['fix'] }]);

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const result = await callStaticFallback(pipeline, [
        {
          id: 'no-tag',
          title: 'Untagged task',
          description: '',
          priority: 'P1' as const,
          tags: [],
          source: 'todo-marker' as const,
          confidence: 0.8,
        },
      ]);

      const item = [...result.withinBudget, ...result.requiresApproval].at(0);
      // Must use the flat $1.50 default — NOT the $10 'fix' p50.
      expect(item?.estimatedCostUsd).toBeCloseTo(1.5, 2);
      expect(item?.estimatedCostUsd).not.toBeCloseTo(10, 1);
    } finally {
      telemetry.close();
    }
  });

  it('zero-cost cycles are excluded from p50 computation', async () => {
    // A cycle with totalUsd=0 (e.g., killed before any tokens were billed) must
    // NOT contribute to tag cost observations. Including it would dilute the p50.
    //
    // Regression scenario:
    //   valid cycle:     totalUsd=$5, 1 'ztag' item → avgItemCost=$5
    //   zero-cost cycle: totalUsd=$0, 1 'ztag' item → must be excluded
    //   If INCLUDED: observations=[5, 0] → p50=2.5 (underestimates by 50%)
    //   If EXCLUDED: observations=[5]    → p50=5   (correct)
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
    makeCycleDir(cyclesDir, 'valid-cycle',     5, [{ tags: ['ztag'] }]);
    makeCycleDir(cyclesDir, 'zero-cost-cycle', 0, [{ tags: ['ztag'] }]);

    const p50 = computeRollingP50CostByTagFromCycles(projectRoot, 10);

    // Must reflect only the valid cycle → p50 = $5.
    expect(p50['ztag']).toBeCloseTo(5, 1);
    // Guard: median([0, 5]) = 2.5 would be the regression value.
    expect(p50['ztag']).not.toBeCloseTo(2.5, 1);
  });

  it('cycle dirs missing cycle.json are gracefully skipped without throwing', async () => {
    // Incomplete cycles (process killed between cycle dir creation and
    // cycle.json write) must not throw and must not contribute to p50.
    // Ensures the skip-on-missing-file logic is resilient.
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');

    // Valid cycle: both cycle.json and plan.json present.
    makeCycleDir(cyclesDir, 'good-cycle', 8, [{ tags: ['vtag'] }]);

    // Broken cycle: only plan.json, no cycle.json.
    const brokenDir = join(cyclesDir, 'broken-cycle');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(
      join(brokenDir, 'plan.json'),
      JSON.stringify({ items: [{ id: 'x', tags: ['vtag'] }] }),
    );

    // Must not throw; only good-cycle contributes.
    const p50 = computeRollingP50CostByTagFromCycles(projectRoot, 10);

    // p50('vtag') = $8 from good-cycle only.
    expect(p50['vtag']).toBeCloseTo(8, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Budget overflow with calibrated p50 costs
// ---------------------------------------------------------------------------

describe('cost-calibration integration: budget overflow with calibrated p50 costs', () => {
  it('calibrated p50 costs trigger budget overflow for expensive tag families', async () => {
    // When rolling p50 reveals that 'feature' items cost $40 each, the static
    // fallback must use those calibrated costs — not the flat $1.50 default —
    // when enforcing the per-cycle budget cap. Items that exceed the budget
    // must land in requiresApproval, not withinBudget.
    //
    // Regression scenario: if staticFallback ignored p50CostByTag and always
    // used perItemUsd=$1.50, all 3 items would fit in a $50 budget ($4.50 total)
    // and none would require approval — completely wrong given $40/item reality.
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');

    // 3 historical cycles: 3 feature items each at $120 total → avg = $40/item.
    for (let i = 1; i <= 3; i++) {
      makeCycleDir(cyclesDir, `expensive-cycle-${i}`, 120, [
        { tags: ['feature'] }, { tags: ['feature'] }, { tags: ['feature'] },
      ]);
    }
    // feature p50 = median([40, 40, 40]) = $40

    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      // Budget $50 — enough for exactly ONE $40 feature item.
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig({ perCycleUsd: 50 }),
        makeLogger(),
      );

      const backlog = [
        { id: 'feat-a', title: 'Feature A', description: '', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 0.9 },
        { id: 'feat-b', title: 'Feature B', description: '', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 0.8 },
        { id: 'feat-c', title: 'Feature C', description: '', priority: 'P2' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 0.7 },
      ];

      const result = await callStaticFallback(pipeline, backlog);

      // Exactly 1 item at $40 fits within the $50 cap.
      expect(result.withinBudget.length).toBe(1);
      // The remaining 2 items must require approval.
      expect(result.requiresApproval.length).toBe(2);
      // totalEstimatedCostUsd is the sum of withinBudget items only.
      expect(result.totalEstimatedCostUsd).toBeCloseTo(40, 1);
      // The single within-budget item must carry the calibrated $40 estimate.
      expect(result.withinBudget[0]!.estimatedCostUsd).toBeCloseTo(40, 1);
    } finally {
      telemetry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 7: gatherGrounding() ScoringGrounding type contract
// ---------------------------------------------------------------------------

describe('cost-calibration integration: gatherGrounding() type contract', () => {
  it('returns all four ScoringGrounding fields even when the p50 adapter throws', async () => {
    // Regression guard: a broken getP50CostByTag() must not cause gatherGrounding()
    // to omit the p50CostByTag field. If that field were absent (undefined), every
    // consumer that reads grounding.p50CostByTag would receive undefined and
    // silently corrupt the LLM scorer's prompt context. The guard (try/catch in
    // gatherGrounding()) is already in place; this test pins the contract so any
    // future refactor that inadvertently removes it is caught immediately.
    const brokenP50Adapter: AdapterForScoring = {
      async getSprintHistory() { return []; },
      async getCostMedians() { return {}; },
      async getTeamState() { return { utilization: {} }; },
      async getP50CostByTag() { throw new Error(['dis', 'k-fail-test'].join('')); },
    };

    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      brokenP50Adapter,
      makeTestConfig(),
      makeLogger(),
    );

    const grounding = await pipeline.gatherGrounding() as Record<string, unknown>;

    // All four ScoringGrounding fields must be present, never omitted.
    expect(grounding).toHaveProperty('history');
    expect(grounding).toHaveProperty('costMedians');
    expect(grounding).toHaveProperty('teamState');
    expect(grounding).toHaveProperty('p50CostByTag');

    // Degraded p50CostByTag must be a plain empty object — never null or undefined.
    // staticFallback() and buildScoringPrompt() both index into this object.
    const p50 = grounding['p50CostByTag'];
    expect(p50).not.toBeNull();
    expect(p50).not.toBeUndefined();
    expect(typeof p50).toBe('object');
    expect(p50).toEqual({});
  });

  it('p50CostByTag in grounding is always a plain object even with no cycles on disk', async () => {
    // Belt-and-suspenders: with a healthy adapter but an empty workspace,
    // the grounding must still expose p50CostByTag: {} so consumers never
    // need a null-check.
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);
    try {
      const pipeline = new ScoringPipeline(
        makeFailingRuntime(),
        telemetry.scoringAdapter,
        makeTestConfig(),
        makeLogger(),
      );

      const grounding = await pipeline.gatherGrounding() as Record<string, unknown>;
      const p50 = grounding['p50CostByTag'];

      expect(p50).not.toBeNull();
      expect(p50).not.toBeUndefined();
      expect(typeof p50).toBe('object');
      expect(p50).toEqual({});
    } finally {
      telemetry.close();
    }
  });
});
