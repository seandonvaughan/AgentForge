import { createAutonomousTelemetryAdapters } from './workspace-telemetry-adapters.js';
import { loadCycleConfig } from './config-loader.js';
import { ProposalToBacklog } from './proposal-to-backlog.js';
import { ScoringPipeline } from './scoring-pipeline.js';
import { RuntimeAdapter } from './runtime-adapter.js';
import type { CycleConfig } from './types.js';
import type { CycleLogger } from './cycle-logger.js';

export interface PreviewCycleOptions {
  projectRoot: string;
  budgetUsd?: number;
  maxItems?: number;
}

export interface PreviewCycleResult {
  candidateCount: number;
  rankedItems: Array<{
    itemId: string;
    title: string;
    rank: number;
    score: number;
    confidence: number;
    estimatedCostUsd: number;
    estimatedDurationMinutes: number;
    rationale: string;
    dependencies: string[];
    suggestedAssignee: string;
    suggestedTags: string[];
    withinBudget: boolean;
  }>;
  totalEstimatedCostUsd: number;
  budgetOverflowUsd: number;
  withinBudget: number;
  requiresApproval: number;
  summary: string;
  warnings: string[];
  durationMs: number;
  scoringCostUsd: number;
  fallback: 'static' | null;
}

export async function previewCycle(
  options: PreviewCycleOptions,
): Promise<PreviewCycleResult> {
  const startedAt = Date.now();
  const config = applyPreviewOverrides(
    loadCycleConfig(options.projectRoot),
    options,
  );
  const telemetry = createAutonomousTelemetryAdapters(options.projectRoot);

  try {
    const backlog = await new ProposalToBacklog(
      telemetry.proposalAdapter,
      options.projectRoot,
      config,
    ).build();

    if (backlog.length === 0) {
      return {
        candidateCount: 0,
        rankedItems: [],
        totalEstimatedCostUsd: 0,
        budgetOverflowUsd: 0,
        withinBudget: 0,
        requiresApproval: 0,
        summary: 'No backlog items found — nothing to score.',
        warnings: ['Empty backlog: no proposals or TODO(autonomous) markers detected.'],
        durationMs: Date.now() - startedAt,
        scoringCostUsd: 0,
        fallback: null,
      };
    }

    const pipeline = new ScoringPipeline(
      new RuntimeAdapter({ cwd: options.projectRoot }),
      telemetry.scoringAdapter,
      config,
      createNoopCycleLogger(),
    );

    const scored = await pipeline.scoreWithFallback(backlog);
    const rankedItems = [...scored.withinBudget, ...scored.requiresApproval];

    return {
      candidateCount: backlog.length,
      rankedItems,
      totalEstimatedCostUsd: Number(scored.totalEstimatedCostUsd ?? 0),
      budgetOverflowUsd: Number(scored.budgetOverflowUsd ?? 0),
      withinBudget: scored.withinBudget.length,
      requiresApproval: scored.requiresApproval.length,
      summary: String(scored.summary ?? ''),
      warnings: Array.isArray(scored.warnings) ? scored.warnings : [],
      durationMs: Date.now() - startedAt,
      scoringCostUsd: 0,
      fallback: scored.fallback ?? null,
    };
  } finally {
    telemetry.close();
  }
}

function applyPreviewOverrides(
  config: CycleConfig,
  options: PreviewCycleOptions,
): CycleConfig {
  const next = JSON.parse(JSON.stringify(config)) as CycleConfig;

  if (typeof options.budgetUsd === 'number') {
    next.budget.perCycleUsd = options.budgetUsd;
  }

  if (typeof options.maxItems === 'number') {
    next.limits.maxItemsPerSprint = options.maxItems;
  }

  return next;
}

function createNoopCycleLogger(): CycleLogger {
  return {
    logScoring: (_result: unknown, _grounding: unknown) => {},
    logScoringFallback: (_strike: number, _reason: string) => {},
    logKillSwitch: (_trip: unknown) => {},
    logCycleResult: (_result: unknown) => {},
    logGitEvent: (_event: unknown) => {},
    logTestRun: (_result: unknown) => {},
    logPREvent: (_event: unknown) => {},
  } as CycleLogger;
}
