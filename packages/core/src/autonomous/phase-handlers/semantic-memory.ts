/**
 * Semantic reranking of in-cycle memory entries (Gem #2).
 *
 * Reranks a tag-filtered MemoryEntry array by embedding cosine similarity to
 * an item's text.  The semantic path is ONLY engaged when the REAL
 * @xenova/transformers model is available.  When the package is absent (CI,
 * fresh worktrees) the encoder falls back to a deterministic hash pseudo-
 * embedding that has no semantic meaning — using it for reranking would
 * DEGRADE recall below the deterministic tag-match order.  In that case (and
 * on any error) the input array is returned unchanged (byte-identical order).
 *
 * The `encode` and `isRealAvailable` options exist for deterministic testing
 * without network access or the real ML model.
 */

import type { ParsedMemoryEntry } from '../../memory/types.js';
import {
  encode as defaultEncode,
  isRealEncoderAvailable as defaultIsRealAvailable,
} from '@agentforge/embeddings';
import { cosine } from '@agentforge/embeddings';

export type EncodeFunction = (text: string) => Promise<Float32Array>;
export type IsRealAvailableFunction = () => Promise<boolean>;

export interface RankMemoriesBySemanticOptions {
  /** Override the encode function — used in tests to inject deterministic vectors. */
  encode?: EncodeFunction;
  /** Override the availability detector — used in tests to control gating. */
  isRealAvailable?: IsRealAvailableFunction;
}

/**
 * Returns a copy of `entries` sorted by cosine similarity (descending) to
 * `itemText`, but only when the real ML encoder is confirmed available.
 * Otherwise returns `entries` unchanged (preserves tag-match order as the
 * floor).  Never throws — all errors fall through to unchanged order.
 */
export async function rankMemoriesBySemantic(
  itemText: string,
  entries: ParsedMemoryEntry[],
  opts?: RankMemoriesBySemanticOptions,
): Promise<ParsedMemoryEntry[]> {
  if (entries.length === 0) return entries;

  const isRealAvailable = opts?.isRealAvailable ?? defaultIsRealAvailable;
  const encode = opts?.encode ?? defaultEncode;

  try {
    const available = await isRealAvailable();
    if (!available) {
      // Hash fallback is active — semantic reranking would degrade recall.
      return entries;
    }

    // Embed the item and all entries in parallel.
    const entryTexts = entries.map((e) => {
      const text = typeof e.value === 'string' && e.value.length > 0
        ? e.value
        : (e.key ?? e.id ?? e.type);
      return text;
    });

    const [itemVec, ...entryVecs] = await Promise.all([
      encode(itemText),
      ...entryTexts.map((t) => encode(t)),
    ]);

    // Score each entry and sort descending.
    const scored = entries.map((entry, i) => ({
      entry,
      score: cosine(itemVec, entryVecs[i]!),
    }));
    scored.sort((a, b) => b.score - a.score);

    return scored.map((s) => s.entry);
  } catch {
    // Any error (network, model load, etc.) → return original order unchanged.
    return entries;
  }
}
