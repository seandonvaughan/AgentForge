import { setImmediate as yieldNow } from 'node:timers/promises';

const ASYNC_TOPK_THRESHOLD = 10_000;
const ASYNC_CHUNK_SIZE = 1_000;

/** Cosine similarity between vectors (result is clamped to 0–1). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
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
  if (normA <= 0 || normB <= 0) return 0;
  const denom = Math.sqrt(normA * normB);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const score = dot / denom;
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

/** Find top-K most similar vectors from a pool. O(n·d) — fast for n≤50K. */
export function topK(
  query: Float32Array,
  pool: Array<{ id: string; vec: Float32Array; content: string; metadata?: Record<string, unknown> }>,
  k: number,
  minScore: number,
): Array<{ id: string; score: number; content: string; metadata?: Record<string, unknown> }> {
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

/** Top-K search that yields between chunks for large pools to keep the event loop responsive. */
export async function topKAsync(
  query: Float32Array,
  pool: Array<{ id: string; vec: Float32Array; content: string; metadata?: Record<string, unknown> }>,
  k: number,
  minScore: number,
): Promise<Array<{ id: string; score: number; content: string; metadata?: Record<string, unknown> }>> {
  if (pool.length <= ASYNC_TOPK_THRESHOLD) {
    return topK(query, pool, k, minScore);
  }

  const scores: Array<{ id: string; score: number; content: string; metadata?: Record<string, unknown> }> = [];
  for (let i = 0; i < pool.length; i += ASYNC_CHUNK_SIZE) {
    const end = Math.min(i + ASYNC_CHUNK_SIZE, pool.length);
    for (let j = i; j < end; j++) {
      const doc = pool[j];
      if (!doc) continue;
      const score = cosine(query, doc.vec);
      if (score >= minScore) {
        scores.push({
          id: doc.id,
          score,
          content: doc.content,
          ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
        });
      }
    }
    await yieldNow();
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}
