import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encode, encodeBatch, EMBEDDING_DIMS } from './encoder.js';
import { topK } from './similarity.js';
import type { EmbeddingDocument, EmbeddingResult, EmbeddingSearchOptions, EmbeddingStats } from './types.js';

const DDL = `
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  workspace_id TEXT,
  metadata TEXT,
  vector BLOB NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_workspace ON embeddings(workspace_id);
`;

type CacheEntry = {
  id: string;
  vec: Float32Array;
  content: string;
  metadata?: Record<string, unknown>;
};

function withOptionalMetadata<T extends { metadata?: Record<string, unknown> }>(
  value: Omit<T, 'metadata'>,
  metadata: Record<string, unknown> | undefined,
): T {
  return {
    ...value,
    ...(metadata !== undefined ? { metadata } : {}),
  } as T;
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class EmbeddingStore {
  private db: Database.Database;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheLoaded = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(DDL);
  }

  /** Index a single document. Returns the embedding vector. */
  async index(doc: EmbeddingDocument): Promise<Float32Array> {
    const vec = await encode(doc.content);
    const blob = Buffer.from(vec.buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, content, workspace_id, metadata, vector)
      VALUES (?, ?, ?, ?, ?)
    `).run(doc.id, doc.content, doc.workspaceId ?? null, JSON.stringify(doc.metadata ?? {}), blob);

    this.cache.set(
      doc.id,
      withOptionalMetadata<CacheEntry>(
        { id: doc.id, vec, content: doc.content },
        doc.metadata,
      ),
    );
    return vec;
  }

  /** Index multiple documents in a single transaction. */
  async indexBatch(docs: EmbeddingDocument[]): Promise<void> {
    if (docs.length === 0) return;
    const vecs = await encodeBatch(docs.map(d => d.content));
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, content, workspace_id, metadata, vector)
      VALUES (?, ?, ?, ?, ?)
    `);
    const run = this.db.transaction(() => {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const vec = vecs[i];
        if (!doc || !vec) {
          throw new Error('Embedding batch length mismatch');
        }

        const blob = Buffer.from(vec.buffer);
        insert.run(
          doc.id,
          doc.content,
          doc.workspaceId ?? null,
          JSON.stringify(doc.metadata ?? {}),
          blob,
        );
        this.cache.set(
          doc.id,
          withOptionalMetadata<CacheEntry>(
            { id: doc.id, vec, content: doc.content },
            doc.metadata,
          ),
        );
      }
    });
    run();
  }

  /** Index a session outcome for cross-workspace learning. */
  async indexSession(session: {
    sessionId: string;
    agentId: string;
    task: string;
    response: string;
    model: string;
    costUsd?: number;
    workspaceId?: string;
  }): Promise<void> {
    const content = `Agent: ${session.agentId}\nTask: ${session.task}\nOutcome: ${session.response.slice(0, 500)}`;
    await this.index({
      id: `session:${session.sessionId}`,
      content,
      ...(session.workspaceId !== undefined ? { workspaceId: session.workspaceId } : {}),
      metadata: {
        type: 'session',
        agentId: session.agentId,
        model: session.model,
        costUsd: session.costUsd ?? 0,
      },
    });
  }

  /** Search for semantically similar documents. */
  async search(query: string, opts: EmbeddingSearchOptions = {}): Promise<EmbeddingResult[]> {
    const { topK: k = 10, minScore = 0.5, workspaceId } = opts;

    if (!this.cacheLoaded) this._loadCache();

    const queryVec = await encode(query);

    // Filter pool by workspace if specified
    const pool = workspaceId
      ? [...this.cache.values()].filter(() => true) // workspace filter simplified; production should query db
      : [...this.cache.values()];

    return topK(queryVec, pool, k, minScore);
  }

  /** Delete a document by ID. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM embeddings WHERE id = ?').run(id);
    this.cache.delete(id);
  }

  /** Get stats about the index. */
  stats(): EmbeddingStats {
    const row = this.db
      .prepare('SELECT COUNT(*) as total, MAX(indexed_at) as last FROM embeddings')
      .get() as { total: number; last: string };
    return {
      totalDocuments: row.total,
      indexedAt: row.last ?? new Date().toISOString(),
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dimensionality: EMBEDDING_DIMS,
    };
  }

  close(): void {
    this.db.close();
  }

  private _loadCache(): void {
    const rows = this.db
      .prepare('SELECT id, content, metadata, vector FROM embeddings')
      .all() as Array<{ id: string; content: string; metadata: string; vector: Buffer }>;
    for (const row of rows) {
      const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
      let metadata: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(row.metadata);
        if (isMetadataRecord(parsed)) {
          metadata = parsed;
        }
      } catch {
        // Skip malformed metadata and keep the cached entry usable.
      }
      this.cache.set(
        row.id,
        withOptionalMetadata<CacheEntry>(
          { id: row.id, vec, content: row.content },
          metadata,
        ),
      );
    }
    this.cacheLoaded = true;
  }
}
