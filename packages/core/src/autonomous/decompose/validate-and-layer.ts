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

export type ValidateResult =
  | { ok: true; plan: EpicPlan; report: ValidationReport }
  | { ok: false; reason: 'cycle' | 'missing-predecessors'; report: ValidationReport };

export function validateAndLayerEpicPlan(plan: EpicPlan): ValidateResult {
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

  return {
    ok: true,
    plan: { ...plan, children: layered },
    report: { acyclic: true, missingPredecessors: [], syntheticFileEdges, waveCount },
  };
}
