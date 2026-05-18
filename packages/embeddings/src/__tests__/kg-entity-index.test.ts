/**
 * Tests for KGEntityIndex — the bridge between the EmbeddingStore and
 * KnowledgeGraph entities.
 *
 * These tests rely on the hash-based fallback encoder (no ML download needed)
 * so they run fast in CI.  The fallback is automatically used whenever the
 * @xenova/transformers pipeline fails to load — which is guaranteed in the
 * isolated test environment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KGEntityIndex, KG_ENTITY_PREFIX } from '../kg-entity-index.js';

let tmpDir: string;
let index: KGEntityIndex;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-kg-embed-'));
  index = new KGEntityIndex(join(tmpDir, 'test-embeddings.db'));
});

afterEach(() => {
  index.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// KG_ENTITY_PREFIX constant
// ---------------------------------------------------------------------------

describe('KG_ENTITY_PREFIX', () => {
  it('is the expected string', () => {
    expect(KG_ENTITY_PREFIX).toBe('kg-entity:');
  });
});

// ---------------------------------------------------------------------------
// indexEntity — single entity
// ---------------------------------------------------------------------------

describe('indexEntity', () => {
  it('indexes a single entity without throwing', async () => {
    await expect(
      index.indexEntity({ id: 'ent-001', name: 'EmbeddingStore', type: 'module' }),
    ).resolves.toBeUndefined();
  });

  it('indexes entity with description without throwing', async () => {
    await expect(
      index.indexEntity({
        id: 'ent-002',
        name: 'KnowledgeGraph',
        type: 'module',
        description: 'Semantic memory graph',
      }),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — re-indexing the same entity does not throw', async () => {
    const entity = { id: 'ent-003', name: 'AuditPhase', type: 'task' };
    await index.indexEntity(entity);
    await expect(index.indexEntity(entity)).resolves.toBeUndefined();
  });

  it('stats() shows the indexed entity', async () => {
    await index.indexEntity({ id: 'ent-004', name: 'ReviewPhase', type: 'task' });
    const s = index.stats();
    expect(s.totalDocuments).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// indexEntities — batch
// ---------------------------------------------------------------------------

describe('indexEntities', () => {
  it('is a no-op for an empty array', async () => {
    await expect(index.indexEntities([])).resolves.toBeUndefined();
  });

  it('indexes multiple entities in one call', async () => {
    await index.indexEntities([
      { id: 'ent-010', name: 'EntityExtractor', type: 'module' },
      { id: 'ent-011', name: 'RelationshipMapper', type: 'module' },
      { id: 'ent-012', name: 'SprintPlanner', type: 'agent' },
    ]);
    const s = index.stats();
    expect(s.totalDocuments).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// searchEntities
// ---------------------------------------------------------------------------

describe('searchEntities', () => {
  beforeEach(async () => {
    await index.indexEntities([
      { id: 'ent-100', name: 'EmbeddingStore', type: 'module', description: 'vector persistence layer' },
      { id: 'ent-101', name: 'KnowledgeGraph', type: 'module', description: 'semantic memory graph' },
      { id: 'ent-102', name: 'AuditPhase', type: 'task', description: 'audit phase handler' },
      { id: 'ent-103', name: 'ReviewAgent', type: 'agent', description: 'code review agent' },
    ]);
  });

  it('returns results that are all within [0, 1] score range', async () => {
    const results = await index.searchEntities('embedding vector store');
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('strips the kg-entity: prefix from returned ids', async () => {
    const results = await index.searchEntities('knowledge graph memory');
    for (const r of results) {
      expect(r.id).not.toContain(KG_ENTITY_PREFIX);
    }
  });

  it('returns only entity IDs (not session: prefixed docs)', async () => {
    // Session docs have their own prefix and must not leak into KG results.
    const results = await index.searchEntities('audit phase');
    for (const r of results) {
      // All returned IDs must be raw entity UUIDs (no prefix remnant).
      expect(r.id).not.toMatch(/^kg-entity:/);
      expect(r.id).not.toMatch(/^session:/);
    }
  });

  it('respects the topK limit', async () => {
    const results = await index.searchEntities('phase agent module', { topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty array for a very high minScore', async () => {
    // With the hash-fallback encoder, real cosine distances won't hit 0.99.
    const results = await index.searchEntities('anything', { minScore: 0.99 });
    expect(results).toEqual([]);
  });

  it('results are sorted descending by score', async () => {
    const results = await index.searchEntities('embedding vector', { minScore: 0 });
    const scores = results.map(r => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('does not throw when called once', () => {
    expect(() => index.close()).not.toThrow();
  });
});
