/**
 * Quality-aware utility scoring (T0 shared contract — inlined here until central
 * shared module merges). Wraps `computeUtility` with the canonical weights and
 * normalisation used by the AdaptiveRouter.
 *
 * Weights: quality 0.6, cost 0.3, latency 0.1.
 * Cost normalised against a $0.50 hard reference cap.
 * Latency normalised against a 120s hard reference cap.
 */

export const ROUTING_UTILITY_WEIGHTS = {
  quality: 0.6,
  cost: 0.3,
  latency: 0.1,
} as const;

export const COST_REFERENCE_USD = 0.5;
export const LATENCY_REFERENCE_MS = 120_000;

export interface UtilitySample {
  quality: number; // 0..1
  cost_usd: number; // >= 0
  latency_ms: number; // >= 0
}

/**
 * Compute scalar utility from a (quality, cost, latency) sample.
 * Higher is better. All component scores are clamped to [0, 1].
 */
export function computeUtility(s: UtilitySample): number {
  const quality = Math.max(0, Math.min(1, s.quality));
  const costNorm = Math.max(0, 1 - s.cost_usd / COST_REFERENCE_USD);
  const latencyNorm = Math.max(0, 1 - s.latency_ms / LATENCY_REFERENCE_MS);
  return (
    ROUTING_UTILITY_WEIGHTS.quality * quality +
    ROUTING_UTILITY_WEIGHTS.cost * costNorm +
    ROUTING_UTILITY_WEIGHTS.latency * latencyNorm
  );
}
