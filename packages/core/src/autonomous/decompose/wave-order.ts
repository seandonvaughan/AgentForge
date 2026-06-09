// packages/core/src/autonomous/decompose/wave-order.ts
//
// Group execute-phase items into ordered dependency waves. Items with no `wave`
// (signal cycles) collapse into a single wave, exactly reproducing the pre-wave
// flat dispatch order — so the wave-aware execute loop is a no-op for non-epic
// cycles. (spec 2026-05-30 §8.1)

export interface WaveOrderable {
  id: string;
  // `| undefined` keeps zod-inferred optionals (e.g. EpicChild.wave)
  // assignable under exactOptionalPropertyTypes.
  wave?: number | undefined;
  predecessors?: string[] | undefined;
}

/**
 * Returns waves in ascending `wave` order; within a wave, original relative
 * order is preserved. If NO item declares a wave, returns a single wave
 * containing all items in their original order (flat behavior). Empty input
 * returns [].
 */
export function groupItemsByWave<T extends WaveOrderable>(items: T[]): T[][] {
  if (items.length === 0) return [];
  const anyWave = items.some((it) => typeof it.wave === 'number');
  if (!anyWave) return [items];

  const byWave = new Map<number, T[]>();
  for (const it of items) {
    const w = typeof it.wave === 'number' ? it.wave : 0;
    const bucket = byWave.get(w);
    if (bucket) bucket.push(it);
    else byWave.set(w, [it]);
  }
  return [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w)!);
}
