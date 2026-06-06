// packages/core/src/autonomous/decompose/validate-and-layer.ts
//
// Pure orchestrator: validate predecessors -> detect cycle -> augment
// file-overlap edges -> re-check (defensive) -> layer waves. Returns a
// discriminated result the DECOMPOSE phase (PR-2b) turns into a repair retry
// or a layered plan. (spec 2026-05-30 §6.3)

import type { EpicPlan, ValidationReport } from './types.js';
import { detectCycle } from './detect-cycle.js';
import { augmentFileOverlapEdges } from './file-overlap.js';
import { layerWaves } from './wave-layering.js';
import { computeSpendableUsd } from './decompose-objective.js';

export type ValidateResult =
  | { ok: true; plan: EpicPlan; report: ValidationReport }
  | {
      ok: false;
      reason: 'cycle' | 'missing-predecessors' | 'budget';
      report: ValidationReport;
      /** Human-readable failure detail; populated for budget violations. */
      message?: string;
    };

/**
 * Validate + wave-layer an EpicPlan. When `budgetUsd` is provided (P0.3), the
 * children's `estimatedCostUsd` sum must land within [0.7, 1.0] × spendable,
 * where spendable = (budgetUsd − 6) / 1.2. When omitted, behavior is
 * byte-identical to the pre-budget implementation (no cost logic at all).
 */
export function validateAndLayerEpicPlan(plan: EpicPlan, budgetUsd?: number): ValidateResult {
  // 1. Cycle + missing-predecessor check on the LLM-provided graph.
  const initial = detectCycle(plan.children);
  if (initial.missingPredecessors.length > 0) {
    return {
      ok: false,
      reason: 'missing-predecessors',
      report: {
        acyclic: initial.acyclic,
        ...(initial.cycle ? { cycle: initial.cycle } : {}),
        missingPredecessors: initial.missingPredecessors,
        syntheticFileEdges: [],
        waveCount: 0,
      },
    };
  }
  if (!initial.acyclic) {
    return {
      ok: false,
      reason: 'cycle',
      report: {
        acyclic: false,
        ...(initial.cycle ? { cycle: initial.cycle } : {}),
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 0,
      },
    };
  }

  // 2. File-overlap augmentation (only between currently-unordered pairs, so
  //    it cannot create a cycle — re-check defensively anyway).
  const { children: augmented, syntheticFileEdges } = augmentFileOverlapEdges(plan.children);
  const recheck = detectCycle(augmented);
  if (!recheck.acyclic) {
    return {
      ok: false,
      reason: 'cycle',
      report: {
        acyclic: false,
        ...(recheck.cycle ? { cycle: recheck.cycle } : {}),
        missingPredecessors: [],
        syntheticFileEdges,
        waveCount: 0,
      },
    };
  }

  // 3. Layer waves.
  const layered = layerWaves(augmented);
  const waveCount = layered.reduce((m, c) => Math.max(m, (c.wave ?? 0) + 1), 0);

  // 4. Budget sizing (only when a budget was supplied). The plan must spend
  //    between 70% and 100% of the spendable amount; an undersized plan wastes
  //    the cycle, an oversized plan blows the cap.
  if (budgetUsd !== undefined) {
    const spendableUsd = computeSpendableUsd(budgetUsd);
    const sumUsd = layered.reduce((acc, c) => acc + c.estimatedCostUsd, 0);
    const lowerUsd = 0.7 * spendableUsd;
    const upperUsd = 1.0 * spendableUsd;
    const withinBand = sumUsd >= lowerUsd && sumUsd <= upperUsd;
    const budgetReport: NonNullable<ValidationReport['budget']> = {
      budgetUsd,
      spendableUsd,
      sumUsd,
      lowerUsd,
      upperUsd,
      withinBand,
    };
    if (!withinBand) {
      return {
        ok: false,
        reason: 'budget',
        message:
          `Plan cost Σ(children.estimatedCostUsd) = $${sumUsd.toFixed(2)} is outside the ` +
          `required band [$${lowerUsd.toFixed(2)}, $${upperUsd.toFixed(2)}] ` +
          `(0.7–1.0 × spendable $${spendableUsd.toFixed(2)}, from budget $${budgetUsd.toFixed(2)}). ` +
          (sumUsd < lowerUsd
            ? `The plan is UNDERSIZED — add or enlarge children to fill the budget.`
            : `The plan is OVERSIZED — remove or shrink children to fit the budget.`),
        report: {
          acyclic: true,
          missingPredecessors: [],
          syntheticFileEdges,
          waveCount,
          budget: budgetReport,
        },
      };
    }
    return {
      ok: true,
      plan: { ...plan, children: layered },
      report: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges,
        waveCount,
        budget: budgetReport,
      },
    };
  }

  return {
    ok: true,
    plan: { ...plan, children: layered },
    report: { acyclic: true, missingPredecessors: [], syntheticFileEdges, waveCount },
  };
}
