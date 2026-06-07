/**
 * Status label for a child item in an epic decomposition wave.
 *
 * The cycle pipeline currently emits values such as `planned`, `completed`,
 * `failed`, and `blocked`; consumers should render unknown future values
 * without rejecting the decomposition payload.
 */
export type EpicDecompositionChildStatus = string;

/**
 * Child work item displayed inside an epic decomposition wave.
 */
export interface EpicDecompositionChild {
  /** Stable child item identifier. */
  id: string;
  /** Human-readable child item title. */
  title: string;
  /** Repository files expected to be touched by the child item. */
  files: string[];
  /** Estimated implementation cost for the child item in USD. */
  estimatedCostUsd: number;
  /** Current child execution status. */
  status: EpicDecompositionChildStatus;
}

/**
 * Execution wave in an epic decomposition.
 */
export interface EpicDecompositionWave {
  /** Zero-based wave index. */
  wave: number;
  /** Child work items scheduled in this wave. */
  children: EpicDecompositionChild[];
}

/**
 * Shared read model for `.agentforge/cycles/<cycleId>/decomposition.json`.
 */
export interface EpicDecomposition {
  /** Waves in dependency order, where all children in a wave can run together. */
  waves: EpicDecompositionWave[];
}
