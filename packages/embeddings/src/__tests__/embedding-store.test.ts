import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingStore } from '../embedding-store.js';

let tmpPath: string;
let store: EmbeddingStore;

beforeEach(() => {
  tmpPath = mkdtempSync(join(tmpdir(), 'agentforge-embed-store-'));
  store = new EmbeddingStore(join(tmpPath, 'embeddings.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpPath, { recursive: true, force: true });
});

describe('EmbeddingStore.search workspace filtering', () => {
  it('returns only entries from the requested workspace', async () => {
    await store.indexBatch([
      { id: 'a-1', content: 'embedding vector storage layer', workspaceId: 'ws-a' },
      { id: 'a-2', content: 'semantic retrieval graph', workspaceId: 'ws-a' },
      { id: 'b-1', content: 'deployment rollout summary', workspaceId: 'ws-b' },
    ]);

    const results = await store.search('embedding graph', {
      workspaceId: 'ws-a',
      minScore: 0,
      topK: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.id.startsWith('a-'))).toBe(true);
  });

  it('returns an empty array when the workspace has no indexed docs', async () => {
    await store.index({ id: 'a-1', content: 'embedding vector storage layer', workspaceId: 'ws-a' });

    const results = await store.search('embedding', {
      workspaceId: 'ws-missing',
      minScore: 0,
      topK: 10,
    });

    expect(results).toEqual([]);
  });
});
