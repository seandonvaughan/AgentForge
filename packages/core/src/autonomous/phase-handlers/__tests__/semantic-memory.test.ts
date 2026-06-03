/**
 * Tests for semantic-memory.ts — rankMemoriesBySemantic.
 *
 * All tests use injected encode/isRealAvailable opts so they run offline and
 * deterministically (no @xenova/transformers, no network).
 */

import { describe, it, expect } from 'vitest';
import { rankMemoriesBySemantic } from '../semantic-memory.js';
import type { ParsedMemoryEntry } from '../../../memory/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, value: string, tags: string[] = []): ParsedMemoryEntry {
  return { id, type: 'review-finding', value, tags };
}

/** An isRealAvailable that always returns true — simulates real model present. */
const realAvailable = async (): Promise<boolean> => true;

/** An isRealAvailable that always returns false — simulates hash fallback / no model. */
const hashFallback = async (): Promise<boolean> => false;

// ---------------------------------------------------------------------------
// Mock encode functions
// ---------------------------------------------------------------------------

/**
 * Encodes "item" as [1, 0] and "relevant" as [0.99, 0.14] (≈very similar),
 * and all other texts as [0, 1] (orthogonal to the item).
 *
 * This lets the test confirm that an entry whose value contains "relevant"
 * is ranked first even if it has zero tag overlap — pure semantic signal.
 */
function makeSemanticEncode(): (text: string) => Promise<Float32Array> {
  return async (text: string): Promise<Float32Array> => {
    if (text === 'item query text') {
      // Unit vector pointing along dim-0
      return new Float32Array([1, 0]);
    }
    if (text.includes('relevant')) {
      // High cosine similarity to [1,0]
      const v = new Float32Array([0.99, Math.sqrt(1 - 0.99 * 0.99)]);
      return v;
    }
    // All other texts point along dim-1 — orthogonal, low similarity
    return new Float32Array([0, 1]);
  };
}

/** An encode that always throws — simulates a broken encoder. */
const throwingEncode = async (_text: string): Promise<Float32Array> => {
  throw new Error('encoder error');
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rankMemoriesBySemantic', () => {
  it('returns empty array unchanged', async () => {
    const result = await rankMemoriesBySemantic('item', [], {
      isRealAvailable: realAvailable,
      encode: makeSemanticEncode(),
    });
    expect(result).toEqual([]);
  });

  it('semantic path: surfaces a zero-tag-overlap entry when it is most similar', async () => {
    // entry-b has zero overlap with any item tag, but its value contains "relevant"
    // so the mock encode gives it high cosine similarity to "item query text".
    const entries: ParsedMemoryEntry[] = [
      makeEntry('entry-a', 'unrelated topic about deployment', ['deploy']),
      makeEntry('entry-b', 'relevant semantic match', ['unrelated-tag']),
      makeEntry('entry-c', 'another unrelated entry about CI', ['ci']),
    ];

    const result = await rankMemoriesBySemantic('item query text', entries, {
      isRealAvailable: realAvailable,
      encode: makeSemanticEncode(),
    });

    expect(result[0]!.id).toBe('entry-b');
    expect(result).toHaveLength(3);
  });

  it('byte-identical fallback: returns entries in EXACT input order when hash fallback active', async () => {
    const entries: ParsedMemoryEntry[] = [
      makeEntry('e1', 'alpha', ['tag1']),
      makeEntry('e2', 'beta', ['tag2']),
      makeEntry('e3', 'gamma', ['tag3']),
    ];
    // isRealAvailable returns false — hash fallback active
    const result = await rankMemoriesBySemantic('query text', entries, {
      isRealAvailable: hashFallback,
      encode: makeSemanticEncode(),
    });

    // Must be byte-identical: same array contents in same order
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('e1');
    expect(result[1]!.id).toBe('e2');
    expect(result[2]!.id).toBe('e3');
    // And the same object references (not a copy that happens to be equal)
    for (let i = 0; i < entries.length; i++) {
      expect(result[i]).toBe(entries[i]);
    }
  });

  it('fail-safe: returns entries unchanged when encode throws', async () => {
    const entries: ParsedMemoryEntry[] = [
      makeEntry('e1', 'alpha', []),
      makeEntry('e2', 'beta', []),
    ];

    const result = await rankMemoriesBySemantic('query', entries, {
      isRealAvailable: realAvailable,
      encode: throwingEncode,
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('e1');
    expect(result[1]!.id).toBe('e2');
  });

  it('fail-safe: returns entries unchanged when isRealAvailable throws', async () => {
    const entries: ParsedMemoryEntry[] = [
      makeEntry('e1', 'alpha', []),
    ];

    const throwingAvail = async (): Promise<boolean> => {
      throw new Error('availability probe failed');
    };

    const result = await rankMemoriesBySemantic('query', entries, {
      isRealAvailable: throwingAvail,
      encode: makeSemanticEncode(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('e1');
  });

  it('single entry: returns it unchanged regardless of availability', async () => {
    const entries = [makeEntry('only', 'only entry', ['tag'])];

    const withReal = await rankMemoriesBySemantic('query', entries, {
      isRealAvailable: realAvailable,
      encode: makeSemanticEncode(),
    });
    expect(withReal[0]!.id).toBe('only');

    const withFallback = await rankMemoriesBySemantic('query', entries, {
      isRealAvailable: hashFallback,
      encode: makeSemanticEncode(),
    });
    expect(withFallback[0]!.id).toBe('only');
  });

  it('semantic path: handles entries with missing value gracefully', async () => {
    const entries: ParsedMemoryEntry[] = [
      { id: 'e1', type: 'review-finding', value: '', tags: [], key: 'my-key' },
      makeEntry('e2', 'relevant match text', []),
    ];

    const result = await rankMemoriesBySemantic('item query text', entries, {
      isRealAvailable: realAvailable,
      encode: makeSemanticEncode(),
    });

    // e2 has "relevant" in its value, should rank first
    expect(result[0]!.id).toBe('e2');
    expect(result).toHaveLength(2);
  });
});
