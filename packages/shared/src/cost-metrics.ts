/**
 * Shared cost metrics and analysis utilities.
 *
 * Provides primitives for computing rolling cost statistics (p50, medians, etc.)
 * used across the autonomous scoring pipeline and telemetry adapters.
 *
 * Zero dependencies — tree-shakeable exports only.
 */

/**
 * Represents a single backlog item with its tags and metadata.
 * Used in cost computation to group items by their primary tag.
 */
export interface BacklogItemForCostMetrics {
  tags: string[];
  [key: string]: unknown;
}

/**
 * Represents a single cycle with cost and backlog items.
 * Used in rolling p50 computation.
 */
export interface CycleDataForCostMetrics {
  totalCostUsd: number;
  items: BacklogItemForCostMetrics[];
}

/**
 * Compute the rolling p50 (median) actual cost per sprint-item tag.
 *
 * Algorithm:
 *   1. For each cycle, compute average cost per item = totalCostUsd / items.length
 *   2. Group average costs by each item's primary tag (first element of tags array)
 *   3. For each tag, compute the median of all observed average costs
 *
 * This is used by the scoring pipeline fallback to provide tag-specific cost
 * estimates (e.g., "fix" items cost ~$1.10, "feature" items ~$1.65) rather than
 * a flat per-item default.
 *
 * Returns an object where keys are tag names and values are p50 costs in USD.
 * Empty cycles or cycles with no items are safely skipped. If a tag has no
 * observations, it is not included in the result.
 *
 * @param cycles - Array of cycle data with cost and item tags
 * @returns Record mapping tag names to p50 (median) cost in USD
 *
 * @example
 * ```ts
 * const p50CostByTag = computeRollingP50CostByTag([
 *   { totalCostUsd: 10, items: [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['feature'] }] },
 *   { totalCostUsd: 12, items: [{ tags: ['fix'] }, { tags: ['test'] }] },
 * ]);
 * // p50CostByTag => { 'fix': 3, 'feature': 3.33, 'test': 6 }
 * ```
 */
export function computeRollingP50CostByTag(
  cycles: CycleDataForCostMetrics[],
): Record<string, number> {
  const costsByTag = new Map<string, number[]>();

  // Process each cycle: compute average cost per item, then record under each tag
  for (const cycle of cycles) {
    if (!cycle.items || cycle.items.length === 0) continue;
    if (typeof cycle.totalCostUsd !== 'number' || cycle.totalCostUsd <= 0) continue;

    // Average cost per item for this cycle
    const avgItemCost = cycle.totalCostUsd / cycle.items.length;

    // Record the average cost observation under each item's primary tag
    for (const item of cycle.items) {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const primaryTag = typeof tags[0] === 'string' ? tags[0].trim() : '';
      if (!primaryTag) continue;

      const existing = costsByTag.get(primaryTag) ?? [];
      existing.push(avgItemCost);
      costsByTag.set(primaryTag, existing);
    }
  }

  // Compute p50 (median) per tag
  return Object.fromEntries(
    [...costsByTag.entries()].map(([tag, values]) => [
      tag,
      computeMedian([...values].sort((a, b) => a - b)),
    ]),
  );
}

/**
 * Compute the median (p50) of an array of numbers.
 *
 * Sorts the input and returns the middle value for odd-length arrays,
 * or the average of the two middle values for even-length arrays.
 *
 * Returns 0 for empty arrays.
 *
 * @param values - Array of numbers (will be sorted)
 * @returns The median value
 *
 * @example
 * ```ts
 * computeMedian([1, 2, 3]) // => 2
 * computeMedian([1, 2, 3, 4]) // => 2.5
 * computeMedian([]) // => 0
 * ```
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle] ?? 0;
  }

  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}
