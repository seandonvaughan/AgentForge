// packages/core/src/autonomous/decompose/index.ts
export * from './types.js';
export { detectCycle } from './detect-cycle.js';
export type { CycleResult } from './detect-cycle.js';
export { augmentFileOverlapEdges } from './file-overlap.js';
export { layerWaves } from './wave-layering.js';
export { validateAndLayerEpicPlan } from './validate-and-layer.js';
export type { ValidateResult } from './validate-and-layer.js';
export {
  decomposeObjective,
  buildEpicPlannerPrompt,
  buildRepairPrompt,
  extractEpicPlanJson,
  DecomposeError,
  EPIC_PLANNER_AGENT_ID,
} from './decompose-objective.js';
export type { DecomposeRuntime, DecomposeResult } from './decompose-objective.js';
export { flattenEpicPlanToPlanItems } from './flatten.js';
export type { FlattenedPlanItem } from './flatten.js';
export { groupItemsByWave } from './wave-order.js';
export type { WaveOrderable } from './wave-order.js';
export { summarizeWavePlan } from './wave-summary.js';
export type { WavePlanSummary } from './wave-summary.js';
