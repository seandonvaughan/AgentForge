import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('../encoder.js', () => {
  const EMBEDDING_DIMS = 4;

  function tokenAwareVector(text: string): Float32Array {
    const lower = text.toLowerCase();
    const vec = new Float32Array([
      lower.includes('alpha') ? 2 : 0,
      lower.includes('beta') ? 2 : 0,
      lower.length % 3,
      1,
    ]);

    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      const value = vec[i] ?? 0;
      norm += value * value;
    }
    const safeNorm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) {
      vec[i] = (vec[i] ?? 0) / safeNorm;
    }
    return vec;
  }

  return {
    EMBEDDING_DIMS,
    encode: async (text: string) => tokenAwareVector(text),
    encodeBatch: async (texts: string[]) => texts.map(tokenAwareVector),
  };
});

import { EmbeddingStore } from '../embedding-store.js';

describe('EmbeddingStore', () => {
  let tempDir: string;
  let dbPath: string;
  let store: EmbeddingStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentforge-embedding-store-'));
    dbPath = join(tempDir, 'embeddings.db');
    store = new EmbeddingStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores vectors as sqlite blob columns', async () => {
    await store.index({ id: 'doc-1', content: 'alpha content' });

    const db = new Database(dbPath);
    const row = db
      .prepare('SELECT typeof(vector) as vectorType, length(vector) as byteLength FROM embeddings WHERE id = ?')
      .get('doc-1') as { vectorType: string; byteLength: number };
    db.close();

    expect(row.vectorType).toBe('blob');
    expect(row.byteLength).toBe(4 * 4);
  });

  it('applies workspaceId filtering during search', async () => {
    await store.indexBatch([
      { id: 'ws-a-1', content: 'alpha component', workspaceId: 'workspace-a' },
      { id: 'ws-b-1', content: 'alpha component', workspaceId: 'workspace-b' },
    ]);

    const resultsA = await store.search('alpha component', { topK: 10, minScore: 0, workspaceId: 'workspace-a' });
    const resultsB = await store.search('alpha component', { topK: 10, minScore: 0, workspaceId: 'workspace-b' });

    expect(resultsA.map(r => r.id)).toEqual(['ws-a-1']);
    expect(resultsB.map(r => r.id)).toEqual(['ws-b-1']);
  });
});
