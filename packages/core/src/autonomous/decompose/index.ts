// packages/core/src/autonomous/decompose/index.ts
export * from './types.js';
export { detectCycle } from './detect-cycle.js';
export type { CycleResult } from './detect-cycle.js';
export { augmentFileOverlapEdges } from './file-overlap.js';
export { layerWaves } from './wave-layering.js';
export { validateAndLayerEpicPlan } from './validate-and-layer.js';
export type { ValidateResult } from './validate-and-layer.js';
