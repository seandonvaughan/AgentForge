/** Cosine similarity between two normalized unit vectors (result is 0–1). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Vectors are pre-normalized, so dot product = cosine similarity
  return Math.max(0, Math.min(1, dot));
}

/** Find top-K most similar vectors from a pool. O(n·d) — fast for n≤50K. */
export function topK(
  query: Float32Array,
  pool: Array<{ id: string; vec: Float32Array; content: string; metadata?: Record<string, unknown> }>,
  k: number,
  minScore: number,
): Array<{ id: string; score: number; content: string; metadata?: Record<string, unknown> }> {
  const scores = pool
    .map(doc => ({ id: doc.id, score: cosine(query, doc.vec), content: doc.content, metadata: doc.metadata }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}
