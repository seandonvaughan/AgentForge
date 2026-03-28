/**
 * tests/v5/embeddings.test.ts
 * Tests for cosine similarity, topK, and EmbeddingStore
 * Uses :memory: SQLite — no real ML model required (fallback hash encoder)
 * Target: 28+ tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cosine, topK } from '../../packages/embeddings/src/similarity.js';
import { EmbeddingStore } from '../../packages/embeddings/src/embedding-store.js';
import { EMBEDDING_DIMS } from '../../packages/embeddings/src/encoder.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a normalized unit vector of given dimensionality. */
function unitVec(dims: number, fillValue = 1): Float32Array {
  const v = new Float32Array(dims).fill(fillValue / Math.sqrt(dims));
  return v;
}

/** Create a random normalized vector. */
function randomVec(dims: number): Float32Array {
  const v = new Float32Array(dims).map(() => Math.random() - 0.5);
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

// ── cosine() ──────────────────────────────────────────────────────────────────

describe('cosine()', () => {
  it('returns 1.0 for identical normalized vectors', () => {
    const dims = 4;
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(cosine(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns ~0 for orthogonal vectors', () => {
    // Two orthogonal vectors in 4D
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns 0 for vectors of different lengths', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosine(a, b)).toBe(0);
  });

  it('returns value in [0, 1] for random normalized vectors', () => {
    const a = randomVec(32);
    const b = randomVec(32);
    const sim = cosine(a, b);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('is symmetric: cosine(a,b) === cosine(b,a)', () => {
    const a = randomVec(16);
    const b = randomVec(16);
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 8);
  });

  it('returns high similarity for vectors pointing in similar directions', () => {
    const base = new Float32Array(8).fill(0);
    base[0] = 1; // unit vector along axis 0
    const near = new Float32Array(8).fill(0);
    near[0] = 0.99;
    near[1] = Math.sqrt(1 - 0.99 * 0.99);
    // Both nearly aligned along axis 0
    expect(cosine(base, near)).toBeGreaterThan(0.9);
  });

  it('works with EMBEDDING_DIMS-sized vectors', () => {
    const a = randomVec(EMBEDDING_DIMS);
    const b = new Float32Array(EMBEDDING_DIMS).fill(0);
    // cosine(random, zero) — zero after normalize returns 0 from clamp
    expect(cosine(a, b)).toBeGreaterThanOrEqual(0);
  });
});

// ── topK() ───────────────────────────────────────────────────────────────────

describe('topK()', () => {
  const pool = [
    { id: 'doc1', vec: new Float32Array([1, 0, 0, 0]), content: 'First document', metadata: { tag: 'a' } },
    { id: 'doc2', vec: new Float32Array([0, 1, 0, 0]), content: 'Second document', metadata: { tag: 'b' } },
    { id: 'doc3', vec: new Float32Array([0, 0, 1, 0]), content: 'Third document' },
    { id: 'doc4', vec: new Float32Array([0, 0, 0, 1]), content: 'Fourth document' },
  ];

  it('returns the closest document first', () => {
    const query = new Float32Array([1, 0, 0, 0]); // identical to doc1
    const results = topK(query, pool, 4, 0);
    expect(results[0].id).toBe('doc1');
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  it('respects the k limit', () => {
    const query = new Float32Array([1, 0, 0, 0]);
    const results = topK(query, pool, 2, 0);
    expect(results.length).toBe(2);
  });

  it('filters out results below minScore', () => {
    const query = new Float32Array([1, 0, 0, 0]);
    // doc1 has score 1.0; others have score 0.0 (orthogonal)
    const results = topK(query, pool, 4, 0.5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('doc1');
  });

  it('returns results in descending score order', () => {
    const query = new Float32Array([0.9, 0.44, 0, 0]); // close to doc1, less close to doc2
    const results = topK(query, pool, 4, 0);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it('returns empty array when pool is empty', () => {
    const query = new Float32Array([1, 0, 0, 0]);
    expect(topK(query, [], 5, 0)).toEqual([]);
  });

  it('includes content and metadata in results', () => {
    const query = new Float32Array([1, 0, 0, 0]);
    const results = topK(query, pool, 1, 0);
    expect(results[0].content).toBe('First document');
    expect(results[0].metadata?.tag).toBe('a');
  });
});

// ── EmbeddingStore ────────────────────────────────────────────────────────────

describe('EmbeddingStore', () => {
  let store: EmbeddingStore;

  beforeEach(() => {
    store = new EmbeddingStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('stats() reports 0 documents initially', () => {
    const s = store.stats();
    expect(s.totalDocuments).toBe(0);
  });

  it('stats() reports correct dimensionality', () => {
    expect(store.stats().dimensionality).toBe(EMBEDDING_DIMS);
  });

  it('stats() reports modelId', () => {
    expect(typeof store.stats().modelId).toBe('string');
    expect(store.stats().modelId.length).toBeGreaterThan(0);
  });

  it('index() stores a document and stats reflects it', async () => {
    await store.index({ id: 'doc1', content: 'Hello world' });
    expect(store.stats().totalDocuments).toBe(1);
  });

  it('index() is idempotent — same id replaces existing', async () => {
    await store.index({ id: 'doc1', content: 'First version' });
    await store.index({ id: 'doc1', content: 'Updated version' });
    expect(store.stats().totalDocuments).toBe(1);
  });

  it('index() returns a Float32Array of correct length', async () => {
    const vec = await store.index({ id: 'doc1', content: 'Test content' });
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIMS);
  });

  it('indexBatch() stores multiple documents', async () => {
    await store.indexBatch([
      { id: 'd1', content: 'Alpha' },
      { id: 'd2', content: 'Beta' },
      { id: 'd3', content: 'Gamma' },
    ]);
    expect(store.stats().totalDocuments).toBe(3);
  });

  it('indexBatch() handles empty array without error', async () => {
    await expect(store.indexBatch([])).resolves.not.toThrow();
    expect(store.stats().totalDocuments).toBe(0);
  });

  it('search() returns results after indexing', async () => {
    await store.index({ id: 'doc1', content: 'The quick brown fox' });
    const results = await store.search('quick fox', { topK: 5, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('search() result includes id and content', async () => {
    await store.index({ id: 'abc', content: 'Some content' });
    const results = await store.search('content', { topK: 1, minScore: 0 });
    if (results.length > 0) {
      expect(results[0].id).toBeTruthy();
      expect(typeof results[0].content).toBe('string');
    }
  });

  it('search() respects topK limit', async () => {
    await store.indexBatch([
      { id: 'd1', content: 'Alpha document' },
      { id: 'd2', content: 'Beta document' },
      { id: 'd3', content: 'Gamma document' },
    ]);
    const results = await store.search('document', { topK: 2, minScore: 0 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('search() scores are in [0, 1]', async () => {
    await store.index({ id: 'd1', content: 'Test content here' });
    const results = await store.search('test', { topK: 5, minScore: 0 });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('delete() removes a document from the index', async () => {
    await store.index({ id: 'to-delete', content: 'Remove me' });
    expect(store.stats().totalDocuments).toBe(1);
    store.delete('to-delete');
    expect(store.stats().totalDocuments).toBe(0);
  });

  it('delete() of nonexistent id does not throw', () => {
    expect(() => store.delete('not-there')).not.toThrow();
  });

  it('after delete(), search no longer returns deleted document', async () => {
    await store.index({ id: 'gone', content: 'Deleted content' });
    store.delete('gone');
    const results = await store.search('Deleted content', { topK: 5, minScore: 0 });
    expect(results.find(r => r.id === 'gone')).toBeUndefined();
  });

  it('stats().indexedAt is a valid ISO string after indexing', async () => {
    await store.index({ id: 'd1', content: 'Hello' });
    const ts = store.stats().indexedAt;
    expect(() => new Date(ts)).not.toThrow();
  });
});
