/**
 * Tests for packages/dashboard/src/lib/util/epic-waves.ts
 *
 * Covers: empty input, single item, parallel items, linear chains,
 * diamond graphs, dangling predecessor IDs, mixed inputs, and cycle
 * tolerance.
 */

import { describe, expect, it } from 'vitest';
import { groupIntoWaves } from '../epic-waves.js';
import type { DecompositionChild } from '../../api/epic.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function child(id: string, predecessors: string[] = []): DecompositionChild {
  return { id, title: id, files: [], estimatedCostUsd: 0, predecessors };
}

/** Extract just the id arrays from a wave result for readable assertions. */
function waveIds(waves: DecompositionChild[][]): string[][] {
  return waves.map(w => w.map(c => c.id).sort());
}

// ── empty / trivial ───────────────────────────────────────────────────────────

describe('groupIntoWaves — empty input', () => {
  it('returns [] for an empty children array', () => {
    expect(groupIntoWaves([])).toEqual([]);
  });
});

describe('groupIntoWaves — single item', () => {
  it('returns [[item]] for a single child with no predecessors', () => {
    const result = groupIntoWaves([child('a')]);
    expect(waveIds(result)).toEqual([['a']]);
  });

  it('returns [[item]] for a single child with a dangling predecessor', () => {
    const result = groupIntoWaves([child('a', ['ghost'])]);
    // 'ghost' is not in the list → dangling → placed in last (only) wave
    expect(waveIds(result)).toEqual([['a']]);
  });
});

// ── all-independent (wave 0 only) ────────────────────────────────────────────

describe('groupIntoWaves — parallel items', () => {
  it('puts all items in wave 0 when none have predecessors', () => {
    const items = [child('a'), child('b'), child('c')];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(1);
    expect(waveIds(result)[0]).toEqual(['a', 'b', 'c']);
  });
});

// ── linear chain ─────────────────────────────────────────────────────────────

describe('groupIntoWaves — linear chain', () => {
  it('produces one wave per item for A → B → C', () => {
    const items = [child('a'), child('b', ['a']), child('c', ['b'])];
    const result = groupIntoWaves(items);
    expect(waveIds(result)).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles a longer chain A → B → C → D → E', () => {
    const items = [
      child('a'),
      child('b', ['a']),
      child('c', ['b']),
      child('d', ['c']),
      child('e', ['d']),
    ];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(5);
    expect(waveIds(result)).toEqual([['a'], ['b'], ['c'], ['d'], ['e']]);
  });

  it('places item after all its predecessors even when input order is reversed', () => {
    // Reversed input order: C before B before A
    const items = [child('c', ['b']), child('b', ['a']), child('a')];
    const result = groupIntoWaves(items);
    expect(waveIds(result)).toEqual([['a'], ['b'], ['c']]);
  });
});

// ── diamond graph ─────────────────────────────────────────────────────────────

describe('groupIntoWaves — diamond graph', () => {
  // A → B
  // A → C
  // B → D
  // C → D
  it('groups B and C in the same wave for a diamond A→B,C→D', () => {
    const items = [
      child('a'),
      child('b', ['a']),
      child('c', ['a']),
      child('d', ['b', 'c']),
    ];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(3);
    expect(waveIds(result)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('correctly sequences a wide diamond with extra depth', () => {
    // Wave 0: a
    // Wave 1: b, c, e  (all depend only on a)
    // Wave 2: d         (depends on b and c)
    // Wave 3: f         (depends on d and e)
    const items = [
      child('a'),
      child('b', ['a']),
      child('c', ['a']),
      child('e', ['a']),
      child('d', ['b', 'c']),
      child('f', ['d', 'e']),
    ];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(4);
    expect(waveIds(result)[0]).toEqual(['a']);
    expect(waveIds(result)[1]).toEqual(['b', 'c', 'e']);
    expect(waveIds(result)[2]).toEqual(['d']);
    expect(waveIds(result)[3]).toEqual(['f']);
  });
});

// ── dangling predecessor IDs ──────────────────────────────────────────────────

describe('groupIntoWaves — dangling predecessor IDs', () => {
  it('places an item with a dangling predecessor in the last wave', () => {
    const items = [child('a'), child('b'), child('c', ['nonexistent'])];
    const result = groupIntoWaves(items);
    // a and b → wave 0; c has a dangling predecessor → last wave
    expect(result).toHaveLength(2);
    expect(waveIds(result)[0]).toEqual(['a', 'b']);
    expect(waveIds(result)[1]).toEqual(['c']);
  });

  it('groups multiple dangling items into the same last wave', () => {
    const items = [
      child('a'),
      child('b', ['ghost-1']),
      child('c', ['ghost-2']),
    ];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(2);
    expect(waveIds(result)[0]).toEqual(['a']);
    expect(waveIds(result)[1]).toEqual(['b', 'c']);
  });

  it('treats mixed dangling+valid predecessor as dangling (placed last)', () => {
    // Item 'b' has predecessor 'a' (valid) AND 'ghost' (dangling).
    // Should be treated as dangling and placed in last wave.
    const items = [child('a'), child('b', ['a', 'ghost'])];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(2);
    expect(waveIds(result)[0]).toEqual(['a']);
    expect(waveIds(result)[1]).toEqual(['b']);
  });

  it('returns a single wave when all items have dangling predecessors', () => {
    const items = [child('a', ['x']), child('b', ['y']), child('c', ['z'])];
    const result = groupIntoWaves(items);
    expect(result).toHaveLength(1);
    expect(waveIds(result)[0]).toEqual(['a', 'b', 'c']);
  });

  it('never throws regardless of dangling predecessor content', () => {
    const items = [
      child('a', ['completely-made-up-id-12345']),
      child('b', ['another-fake', 'also-fake']),
    ];
    expect(() => groupIntoWaves(items)).not.toThrow();
  });
});

// ── mixed resolved + dangling ─────────────────────────────────────────────────

describe('groupIntoWaves — mixed resolved and dangling', () => {
  it('interleaves resolved waves correctly then appends dangling last', () => {
    // Resolved chain: x → y → z
    // Dangling items: p (depends on 'missing') and q (depends on 'also-missing')
    const items = [
      child('x'),
      child('y', ['x']),
      child('z', ['y']),
      child('p', ['missing']),
      child('q', ['also-missing']),
    ];
    const result = groupIntoWaves(items);
    // Expect 4 waves: [x], [y], [z], [p, q]
    expect(result).toHaveLength(4);
    expect(waveIds(result)[0]).toEqual(['x']);
    expect(waveIds(result)[1]).toEqual(['y']);
    expect(waveIds(result)[2]).toEqual(['z']);
    expect(waveIds(result)[3]).toEqual(['p', 'q']);
  });
});

// ── cycle tolerance ───────────────────────────────────────────────────────────

describe('groupIntoWaves — cycle tolerance', () => {
  it('does not hang or throw when a cycle is present', () => {
    // A → B → A (cycle)
    const items = [child('a', ['b']), child('b', ['a'])];
    expect(() => groupIntoWaves(items)).not.toThrow();
  });

  it('places cyclic items in a trailing wave so nothing is silently dropped', () => {
    // C has no predecessor; A and B form a cycle.
    const items = [child('c'), child('a', ['b']), child('b', ['a'])];
    const result = groupIntoWaves(items);
    // c → wave 0; a and b are cyclic → appended last
    const allIds = result.flat().map(c => c.id).sort();
    expect(allIds).toEqual(['a', 'b', 'c']);
    // c must appear before a and b
    const waveOfC = result.findIndex(w => w.some(c => c.id === 'c'));
    const waveOfA = result.findIndex(w => w.some(c => c.id === 'a'));
    expect(waveOfC).toBeLessThan(waveOfA);
  });
});

// ── return value invariants ───────────────────────────────────────────────────

describe('groupIntoWaves — return value invariants', () => {
  it('preserves all children across waves (no item dropped)', () => {
    const items = [
      child('a'),
      child('b', ['a']),
      child('c', ['a']),
      child('d', ['b', 'c']),
      child('e', ['ghost']),
    ];
    const result = groupIntoWaves(items);
    const resultIds = result.flat().map(c => c.id).sort();
    expect(resultIds).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns original DecompositionChild object references (not copies)', () => {
    const a = child('a');
    const b = child('b', ['a']);
    const result = groupIntoWaves([a, b]);
    expect(result[0]).toContain(a);
    expect(result[1]).toContain(b);
  });

  it('produces no empty waves', () => {
    const items = [child('a'), child('b', ['a'])];
    const result = groupIntoWaves(items);
    for (const wave of result) {
      expect(wave.length).toBeGreaterThan(0);
    }
  });
});
