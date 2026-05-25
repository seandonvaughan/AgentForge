import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmbeddingStore } from '../embedding-store.js';

let tmpDir: string;
let store: EmbeddingStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-embed-store-'));
  store = new EmbeddingStore(join(tmpDir, 'embeddings.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('EmbeddingStore.search workspace filters', () => {
  it('returns only documents from the requested workspace', async () => {
    await store.index({
      id: 'doc-workspace-a',
      content: 'shared semantic memory text',
      workspaceId: 'workspace-a',
    });
    await store.index({
      id: 'doc-workspace-b',
      content: 'shared semantic memory text',
      workspaceId: 'workspace-b',
    });

    const results = await store.search('shared semantic memory text', {
      workspaceId: 'workspace-a',
      topK: 10,
      minScore: 0,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.id === 'doc-workspace-a')).toBe(true);
    expect(results.some(r => r.id === 'doc-workspace-b')).toBe(false);
  });
});
