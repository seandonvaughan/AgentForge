import { setImmediate as nextTurn } from 'node:timers/promises';

type SimilarityDoc = {
  id: string;
  vec: Float32Array;
  content: string;
  metadata?: Record<string, unknown>;
};

type SimilarityResult = {
  id: string;
  score: number;
  content: string;
  metadata?: Record<string, unknown>;
};

/** Cosine similarity between vectors (result is clamped to 0–1). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  // Degenerate vectors produce undefined cosine; return 0 instead of NaN.
  if (normA === 0 || normB === 0) return 0;

  const score = dot / Math.sqrt(normA * normB);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

/** Find top-K most similar vectors from a pool. O(n·d) — fast for n≤50K. */
export function topK(
  query: Float32Array,
  pool: SimilarityDoc[],
  k: number,
  minScore: number,
): SimilarityResult[] {
  const scores = pool
    .map(doc => ({
      id: doc.id,
      score: cosine(query, doc.vec),
      content: doc.content,
      ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
    }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

/**
 * Non-blocking top-K search for large pools.
 * Batches work and yields to the event loop between chunks.
 */
export async function topKAsync(
  query: Float32Array,
  pool: SimilarityDoc[],
  k: number,
  minScore: number,
  batchSize = 2048,
): Promise<SimilarityResult[]> {
  const scores: SimilarityResult[] = [];

  for (let i = 0; i < pool.length; i += batchSize) {
    const end = Math.min(i + batchSize, pool.length);
    for (let j = i; j < end; j++) {
      const doc = pool[j];
      if (!doc) continue;
      const score = cosine(query, doc.vec);
      if (score < minScore) continue;
      scores.push({
        id: doc.id,
        score,
        content: doc.content,
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
      });
    }

    if (end < pool.length) {
      await nextTurn();
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}
