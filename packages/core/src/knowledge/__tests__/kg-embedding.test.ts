/**
 * Tests for KnowledgeGraph ↔ EntityEmbeddingIndex wiring.
 *
 * Uses a lightweight in-memory mock for EntityEmbeddingIndex so these tests
 * run synchronously without any SQLite or ML dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../knowledge-graph.js';
import type { EntityEmbeddingIndex } from '../types.js';

// ---------------------------------------------------------------------------
// Mock EntityEmbeddingIndex
// ---------------------------------------------------------------------------

function makeMockIndex() {
  // All references inside methods must go through `mock` so that test code
  // can replace `mock.searchResult` and have searchEntities() see the update.
  const mock = {
    indexed: [] as Array<{ id: string; name: string; type: string; description?: string }>,
    searchResult: [] as Array<{ id: string; score: number }>,

    async indexEntity(entity: { id: string; name: string; type: string; description?: string }) {
      mock.indexed.push(entity);
    },

    async indexEntities(entities: Array<{ id: string; name: string; type: string; description?: string }>) {
      mock.indexed.push(...entities);
    },

    async searchEntities(_query: string, _opts?: { topK?: number; minScore?: number }) {
      // Return the current value of mock.searchResult so tests can control it.
      return mock.searchResult;
    },
  };
  return mock;
}

// ---------------------------------------------------------------------------
// addEntity — fires embedding indexing
// ---------------------------------------------------------------------------

describe('KnowledgeGraph.addEntity with embeddingIndex', () => {
  it('calls indexEntity with the new entity after addEntity', async () => {
    const mockIndex = makeMockIndex();
    const indexEntitySpy = vi.spyOn(mockIndex, 'indexEntity');

    const graph = new KnowledgeGraph(undefined, mockIndex);
    const entity = graph.addEntity({ name: 'EmbeddingStore', type: 'module' });

    // Allow the fire-and-forget Promise to resolve.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(indexEntitySpy).toHaveBeenCalledOnce();
    expect(indexEntitySpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: entity.id, name: 'EmbeddingStore', type: 'module' }),
    );
  });

  it('returns the entity synchronously even when embedding index is provided', () => {
    const mockIndex = makeMockIndex();
    const graph = new KnowledgeGraph(undefined, mockIndex);
    const entity = graph.addEntity({ name: 'AuditPhase', type: 'task' });
    // Must be immediately available without awaiting.
    expect(entity.name).toBe('AuditPhase');
    expect(entity.id).toBeTruthy();
  });

  it('swallows indexEntity errors — addEntity must not throw', async () => {
    const mockIndex = makeMockIndex();
    vi.spyOn(mockIndex, 'indexEntity').mockRejectedValue(new Error('embedding write failed'));

    const graph = new KnowledgeGraph(undefined, mockIndex);
    // Should not throw even though the embedding write fails.
    expect(() => graph.addEntity({ name: 'ReviewPhase', type: 'task' })).not.toThrow();
    // Allow the rejected promise to settle — should not cause unhandled rejection.
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('still works when no embeddingIndex is provided', () => {
    const graph = new KnowledgeGraph();
    const entity = graph.addEntity({ name: 'SprintPlanner', type: 'agent' });
    expect(entity.name).toBe('SprintPlanner');
  });
});

// ---------------------------------------------------------------------------
// semanticQuery — uses embedding index when available
// ---------------------------------------------------------------------------

describe('KnowledgeGraph.semanticQuery', () => {
  let graph: KnowledgeGraph;
  let mockIndex: ReturnType<typeof makeMockIndex>;
  let entityId: string;

  beforeEach(() => {
    mockIndex = makeMockIndex();
    graph = new KnowledgeGraph(undefined, mockIndex);

    const entity = graph.addEntity({ name: 'EmbeddingStore', type: 'module', description: 'vector store' });
    entityId = entity.id;
    graph.addEntity({ name: 'KnowledgeGraph', type: 'module' });
  });

  it('calls searchEntities on the embedding index', async () => {
    const searchSpy = vi.spyOn(mockIndex, 'searchEntities');
    mockIndex.searchResult = [];

    await graph.semanticQuery({ query: 'embedding vector', maxEntities: 5, minRelevance: 0.1 });

    expect(searchSpy).toHaveBeenCalledWith(
      'embedding vector',
      expect.objectContaining({ topK: expect.any(Number), minScore: 0.1 }),
    );
  });

  it('returns entities matching the embedding search results', async () => {
    mockIndex.searchResult = [{ id: entityId, score: 0.9 }];

    const result = await graph.semanticQuery({ query: 'vector store', maxEntities: 10, minRelevance: 0.1 });

    expect(result.entities.some(e => e.id === entityId)).toBe(true);
    expect(result.relevanceScores[entityId]).toBeCloseTo(0.9);
  });

  it('filters by entityType when requested', async () => {
    // Add an agent entity; the mock returns both — type filter should drop it.
    const agentEntity = graph.addEntity({ name: 'ReviewAgent', type: 'agent' });
    mockIndex.searchResult = [
      { id: entityId, score: 0.9 },        // module
      { id: agentEntity.id, score: 0.8 },  // agent — should be excluded
    ];

    const result = await graph.semanticQuery({
      query: 'module',
      entityTypes: ['module'],
      maxEntities: 10,
      minRelevance: 0,
    });

    const types = result.entities.map(e => e.type);
    expect(types.every(t => t === 'module')).toBe(true);
    expect(result.entities.some(e => e.id === agentEntity.id)).toBe(false);
  });

  it('falls back to keyword query when no embedding index is wired', async () => {
    const graphNoEmbed = new KnowledgeGraph();
    graphNoEmbed.addEntity({ name: 'EmbeddingStore', type: 'module' });

    const result = await graphNoEmbed.semanticQuery({ query: 'EmbeddingStore', maxEntities: 5, minRelevance: 0 });

    // Should return results via keyword fallback.
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0]!.name).toBe('EmbeddingStore');
  });

  it('unknown entity ids from the embedding index are silently ignored', async () => {
    mockIndex.searchResult = [
      { id: 'non-existent-id-xxxx', score: 0.95 },
      { id: entityId, score: 0.7 },
    ];

    const result = await graph.semanticQuery({ query: 'anything', maxEntities: 10, minRelevance: 0 });

    // Only the known entity should appear.
    expect(result.entities.every(e => e.id !== 'non-existent-id-xxxx')).toBe(true);
    expect(result.entities.some(e => e.id === entityId)).toBe(true);
  });

  it('returns queryTime in result', async () => {
    mockIndex.searchResult = [];
    const result = await graph.semanticQuery({ query: 'test', maxEntities: 5, minRelevance: 0 });
    expect(typeof result.queryTime).toBe('number');
    expect(result.queryTime).toBeGreaterThanOrEqual(0);
  });
});
