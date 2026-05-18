/**
 * Pareto front filter for quality-aware routing.
 *
 * An option `a` strictly dominates option `b` iff `a` is no worse than `b`
 * on every objective and strictly better on at least one. We minimise
 *   - cost
 *   - 1 - quality   (i.e. maximise quality)
 *   - latency
 *
 * The returned set contains every option that is not strictly dominated.
 */

export interface ParetoPoint {
  cost: number;
  quality: number;
  latency: number;
}

/**
 * Returns true iff `a` strictly dominates `b` on (cost, 1-quality, latency).
 */
export function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  const aWorse =
    a.cost > b.cost || a.quality < b.quality || a.latency > b.latency;
  if (aWorse) return false;
  const aStrictlyBetter =
    a.cost < b.cost || a.quality > b.quality || a.latency < b.latency;
  return aStrictlyBetter;
}

/**
 * Filter `options` to the Pareto front. Stable; preserves input order
 * for surviving options.
 */
export function paretoFront<T extends ParetoPoint>(options: T[]): T[] {
  const front: T[] = [];
  for (let i = 0; i < options.length; i++) {
    const candidate = options[i]!;
    let dominated = false;
    for (let j = 0; j < options.length; j++) {
      if (i === j) continue;
      if (dominates(options[j]!, candidate)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) front.push(candidate);
  }
  return front;
}
