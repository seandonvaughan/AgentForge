// packages/core/src/autonomous/preview-objective.ts
//
// Objective dry-run (spec 2026-05-30 §13 m3): run the epic planner + the full
// deterministic validation pipeline and report the DAG, waves, file overlaps,
// cost-by-wave, and budget band WITHOUT executing a cycle. A ~$5 rehearsal
// instead of a $300 blind launch — the planner exploration is the only LLM
// spend, and the only write is the preview artifact directory.
//
// Artifacts go under `.agentforge/previews/objective-<ts>/`, NOT under
// `.agentforge/cycles/`: `cycle list` treats every directory there as a cycle
// and a preview would surface as a phantom plan-stage cycle.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  decomposeObjective,
  DecomposeError,
  type DecomposeRuntime,
} from './decompose/decompose-objective.js';
import type { EpicObjective, EpicPlan, ValidationReport } from './decompose/types.js';
import { groupItemsByWave } from './decompose/wave-order.js';
import { summarizeWavePlan, type WavePlanSummary } from './decompose/wave-summary.js';
import { criticalPathLength } from './decompose/critical-path.js';

export interface PreviewObjectiveOptions {
  projectRoot: string;
  /** Raw operator objective text. */
  objective: string;
  /** Enables band validation + the budget prompt block when present. */
  budgetUsd?: number;
  /**
   * Artifact directory override. Default: a fresh
   * `.agentforge/previews/objective-<ts>/` under projectRoot. `null` disables
   * persistence entirely (unit tests).
   */
  artifactDir?: string | null;
}

export interface PreviewWave {
  wave: number;
  childIds: string[];
  estCostUsd: number;
}

export interface PreviewObjectiveResult {
  status: 'ok' | 'invalid';
  objective: EpicObjective;
  /** Layered children — present when status === 'ok'. */
  plan?: EpicPlan;
  /** Present on success AND on most validation failures (band/cycle detail). */
  report?: ValidationReport;
  waves: PreviewWave[];
  summary?: WavePlanSummary;
  criticalPathLength?: number;
  fileOverlaps: ValidationReport['syntheticFileEdges'];
  warnings: string[];
  /** LLM cost of the preview itself (planner + any repair retry). */
  plannerCostUsd: number;
  repaired: boolean;
  durationMs: number;
  artifactDir: string | null;
  error?: { reason: string; message: string };
}

/** Atomic JSON write (.tmp + rename), mirroring the plan-phase artifact pattern. */
function atomicWriteJson(finalPath: string, value: unknown): void {
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmpPath, finalPath);
}

/** Build the EpicObjective exactly like the plan phase does for `cycle run`. */
function buildObjective(objectiveText: string, budgetUsd?: number): EpicObjective {
  const ts = Date.now().toString(36).slice(-8);
  return {
    id: `epic-preview-${ts}`,
    title: (objectiveText.split('\n')[0] ?? objectiveText).slice(0, 120),
    description: objectiveText,
    createdAt: new Date().toISOString(),
    ...(typeof budgetUsd === 'number' && budgetUsd > 0 ? { budgetUsd } : {}),
  };
}

function defaultArtifactDir(projectRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(projectRoot, '.agentforge', 'previews', `objective-${stamp}`);
}

/**
 * Decompose `options.objective` through the SAME pipeline `cycle run
 * --objective` uses (planner exploration tools, observed-cost calibration via
 * projectRoot, validation + wave layering + budget band) and return a
 * render-ready report. Read-only besides the artifact write — no git, no
 * worktrees, no execution.
 */
export async function previewObjective(
  options: PreviewObjectiveOptions,
  runtime: DecomposeRuntime,
): Promise<PreviewObjectiveResult> {
  const startedAt = Date.now();
  const objective = buildObjective(options.objective, options.budgetUsd);
  const artifactDir =
    options.artifactDir === null
      ? null
      : (options.artifactDir ?? defaultArtifactDir(options.projectRoot));

  let result: PreviewObjectiveResult;
  try {
    const decomposed = await decomposeObjective(objective, runtime, {
      projectRoot: options.projectRoot,
    });
    const { plan, report, costUsd, repaired } = decomposed;

    const waves: PreviewWave[] = groupItemsByWave(plan.children).map((waveChildren) => ({
      wave: typeof waveChildren[0]?.wave === 'number' ? waveChildren[0].wave : 0,
      childIds: waveChildren.map((c) => c.id),
      estCostUsd: waveChildren.reduce((sum, c) => sum + c.estimatedCostUsd, 0),
    }));

    const warnings: string[] = [];
    for (const edge of report.syntheticFileEdges) {
      warnings.push(
        `file overlap: ${edge.to} forced after ${edge.from} (shared: ${edge.sharedFiles.join(', ')})`,
      );
    }
    if (repaired) {
      warnings.push('planner needed one repair retry — the first decomposition was invalid');
    }
    if (report.budget) {
      const pct = report.budget.spendableUsd > 0
        ? Math.round((report.budget.sumUsd / report.budget.spendableUsd) * 100)
        : 0;
      warnings.push(
        `budget utilisation: $${report.budget.sumUsd.toFixed(2)} of $${report.budget.spendableUsd.toFixed(2)} spendable (${pct}%)`,
      );
    }

    result = {
      status: 'ok',
      objective,
      plan,
      report,
      waves,
      summary: summarizeWavePlan(plan),
      criticalPathLength: criticalPathLength(plan),
      fileOverlaps: report.syntheticFileEdges,
      warnings,
      plannerCostUsd: costUsd,
      repaired,
      durationMs: Date.now() - startedAt,
      artifactDir,
    };
  } catch (err) {
    if (!(err instanceof DecomposeError)) throw err;
    result = {
      status: 'invalid',
      objective,
      ...(err.report ? { report: err.report } : {}),
      waves: [],
      fileOverlaps: err.report?.syntheticFileEdges ?? [],
      warnings: [],
      plannerCostUsd: err.costUsd ?? 0,
      repaired: false,
      durationMs: Date.now() - startedAt,
      artifactDir,
      error: { reason: err.reason, message: err.message },
    };
  }

  if (artifactDir !== null) {
    // Best-effort persistence — a write failure must never mask the result.
    try {
      atomicWriteJson(join(artifactDir, 'objective.json'), objective);
      if (result.plan) {
        atomicWriteJson(join(artifactDir, 'decomposition.json'), {
          ...result.plan,
          validationReport: result.report,
        });
      }
      atomicWriteJson(join(artifactDir, 'preview.json'), result);
    } catch {
      result = { ...result, artifactDir: null };
    }
  }

  return result;
}
