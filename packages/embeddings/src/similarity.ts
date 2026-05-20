type ScoredResult = { id: string; score: number; content: string; metadata?: Record<string, unknown> };
type VectorDoc = { id: string; vec: Float32Array; content: string; metadata?: Record<string, unknown> };

const NON_BLOCKING_SWEEP_THRESHOLD = 10_000;
const SWEEP_BATCH_SIZE = 512;

/** Cosine similarity with zero-norm safety (result is clamped to 0–1). */
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

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom === 0) return 0;

  const value = dot / denom;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toScored(query: Float32Array, doc: VectorDoc): ScoredResult {
  return {
    id: doc.id,
    score: cosine(query, doc.vec),
    content: doc.content,
    ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
  };
}

/** Find top-K most similar vectors from a pool. O(n·d), sync path. */
export function topK(
  query: Float32Array,
  pool: VectorDoc[],
  k: number,
  minScore: number,
): ScoredResult[] {
  if (k <= 0 || pool.length === 0) return [];
  const scores = pool
    .map(doc => toScored(query, doc))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function insertIntoTopK(top: ScoredResult[], candidate: ScoredResult, k: number): void {
  if (top.length < k) {
    top.push(candidate);
    top.sort((a, b) => b.score - a.score);
    return;
  }

  const last = top[top.length - 1];
  if (!last || candidate.score <= last.score) return;
  top[top.length - 1] = candidate;
  top.sort((a, b) => b.score - a.score);
}

/**
 * Non-blocking top-K retrieval.
 * For pools larger than 10k rows, this yields to the event loop every batch.
 */
export async function topKAsync(
  query: Float32Array,
  pool: VectorDoc[],
  k: number,
  minScore: number,
): Promise<ScoredResult[]> {
  if (k <= 0 || pool.length === 0) return [];
  if (pool.length <= NON_BLOCKING_SWEEP_THRESHOLD) {
    return topK(query, pool, k, minScore);
  }

  const top: ScoredResult[] = [];

  for (let i = 0; i < pool.length; i += SWEEP_BATCH_SIZE) {
    const end = Math.min(i + SWEEP_BATCH_SIZE, pool.length);
    for (let j = i; j < end; j++) {
      const doc = pool[j];
      if (!doc) continue;
      const scored = toScored(query, doc);
      if (scored.score < minScore) continue;
      insertIntoTopK(top, scored, k);
    }
    await yieldToEventLoop();
  }

  return top;
}
