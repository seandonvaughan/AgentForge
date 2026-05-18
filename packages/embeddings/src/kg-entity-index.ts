/**
 * KGEntityIndex — wires the EmbeddingStore to Knowledge Graph entities.
 *
 * Responsibilities:
 *   - Encode an entity's searchable text (name + type + description) and store
 *     it under the key `kg-entity:<id>` in the backing EmbeddingStore.
 *   - Search for entities by semantic similarity via `searchEntities()`.
 *
 * Iron laws (enforced here):
 *   - Lazy model loading: no encode() calls until indexEntity/indexEntities is
 *     called — construction is always synchronous and free of ML side-effects.
 *   - Zero-norm guard: delegated to EmbeddingStore / cosine() which already
 *     returns 0 for degenerate vectors.
 *   - No PII: entity names / types / descriptions from the KG are
 *     code-level identifiers, not user-facing personal data.
 */

import { EmbeddingStore } from './embedding-store.js';

/** Prefix used for all KG entity documents in the embedding store. */
export const KG_ENTITY_PREFIX = 'kg-entity:';

/** Builds the searchable text blob for a KG entity. */
function entityContent(entity: {
  name: string;
  type: string;
  description?: string;
}): string {
  const parts = [`name: ${entity.name}`, `type: ${entity.type}`];
  if (entity.description) parts.push(`description: ${entity.description}`);
  return parts.join('\n');
}

export interface KGEntitySearchResult {
  /** KG entity id (the original UUID, without the `kg-entity:` prefix). */
  id: string;
  /** Cosine similarity score in [0, 1]. */
  score: number;
}

export class KGEntityIndex {
  private readonly store: EmbeddingStore;

  /**
   * @param dbPath  Absolute path to the SQLite file used for this index.
   *                The directory is created on construction if absent.
   *                Recommended: `<projectRoot>/.agentforge/knowledge/embeddings.db`
   */
  constructor(dbPath: string) {
    this.store = new EmbeddingStore(dbPath);
  }

  /**
   * Encode a single KG entity and upsert it into the embedding store.
   * Idempotent: re-indexing an existing id replaces the previous vector.
   */
  async indexEntity(entity: {
    id: string;
    name: string;
    type: string;
    description?: string;
  }): Promise<void> {
    await this.store.index({
      id: `${KG_ENTITY_PREFIX}${entity.id}`,
      content: entityContent(entity),
      metadata: {
        entityId: entity.id,
        entityType: entity.type,
        entityName: entity.name,
      },
    });
  }

  /**
   * Batch-encode multiple KG entities in a single transaction.
   * No-op if the array is empty.
   */
  async indexEntities(
    entities: Array<{
      id: string;
      name: string;
      type: string;
      description?: string;
    }>,
  ): Promise<void> {
    if (entities.length === 0) return;
    await this.store.indexBatch(
      entities.map(e => ({
        id: `${KG_ENTITY_PREFIX}${e.id}`,
        content: entityContent(e),
        metadata: {
          entityId: e.id,
          entityType: e.type,
          entityName: e.name,
        },
      })),
    );
  }

  /**
   * Return entity IDs ranked by semantic similarity to `query`.
   *
   * Only results whose document id starts with `kg-entity:` are returned, so
   * session documents indexed alongside the KG are automatically excluded.
   *
   * @param query    Free-text query (e.g. a sprint item description).
   * @param opts.topK     Maximum results to return (default 10).
   * @param opts.minScore Minimum cosine similarity threshold (default 0.3).
   *                      Lower than the EmbeddingStore default so KG searches
   *                      are more permissive — a caller can tighten this via opts.
   */
  async searchEntities(
    query: string,
    opts: { topK?: number; minScore?: number } = {},
  ): Promise<KGEntitySearchResult[]> {
    const { topK = 10, minScore = 0.3 } = opts;
    const results = await this.store.search(query, { topK: topK * 2, minScore });
    return results
      .filter(r => r.id.startsWith(KG_ENTITY_PREFIX))
      .slice(0, topK)
      .map(r => ({
        id: r.id.slice(KG_ENTITY_PREFIX.length),
        score: r.score,
      }));
  }

  /** Embedding-store statistics (document count, model id, dimensionality). */
  stats() {
    return this.store.stats();
  }

  /** Close the underlying SQLite connection. */
  close(): void {
    this.store.close();
  }
}
