/**
 * Unit tests for writeMemoryEntry / readMemoryEntries.
 *
 * These test the core JSONL persistence helpers in isolation — no server layer.
 * Each test gets its own tmp directory so writes never cross-contaminate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeMemoryEntry, readMemoryEntries } from '../types.js';
import type { CycleMemoryEntry, MemoryEntryType } from '../types.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-mem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── writeMemoryEntry ────────────────────────────────────────────────────────

describe('writeMemoryEntry', () => {
  it('returns a completed entry with auto-generated id and createdAt', () => {
    const entry = writeMemoryEntry(tmpRoot, {
      type: 'cycle-outcome',
      value: 'Cycle completed OK',
    });

    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.type).toBe('cycle-outcome');
    expect(entry.value).toBe('Cycle completed OK');
  });

  it('respects caller-supplied id and createdAt', () => {
    const entry = writeMemoryEntry(tmpRoot, {
      id: 'custom-id-42',
      type: 'gate-verdict',
      value: 'approved',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(entry.id).toBe('custom-id-42');
    expect(entry.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('persists the entry as a JSONL line in .agentforge/memory/<type>.jsonl', () => {
    writeMemoryEntry(tmpRoot, {
      id: 'e1',
      type: 'review-finding',
      value: 'MAJOR: missing tests',
      source: 'cycle-xyz',
    });

    const filePath = join(tmpRoot, '.agentforge', 'memory', 'review-finding.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as CycleMemoryEntry;
    expect(parsed.id).toBe('e1');
    expect(parsed.type).toBe('review-finding');
    expect(parsed.value).toBe('MAJOR: missing tests');
    expect(parsed.source).toBe('cycle-xyz');
  });

  it('appends multiple entries to the same JSONL file', () => {
    writeMemoryEntry(tmpRoot, { id: 'a', type: 'failure-pattern', value: 'foo' });
    writeMemoryEntry(tmpRoot, { id: 'b', type: 'failure-pattern', value: 'bar' });
    writeMemoryEntry(tmpRoot, { id: 'c', type: 'failure-pattern', value: 'baz' });

    const filePath = join(tmpRoot, '.agentforge', 'memory', 'failure-pattern.jsonl');
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!).id).toBe('c');
  });

  it('writes entries for different types into separate files', () => {
    writeMemoryEntry(tmpRoot, { type: 'cycle-outcome', value: 'v1' });
    writeMemoryEntry(tmpRoot, { type: 'gate-verdict', value: 'v2' });

    const memDir = join(tmpRoot, '.agentforge', 'memory');
    expect(existsSync(join(memDir, 'cycle-outcome.jsonl'))).toBe(true);
    expect(existsSync(join(memDir, 'gate-verdict.jsonl'))).toBe(true);
  });

  it('preserves optional key, source, and tags fields', () => {
    const entry = writeMemoryEntry(tmpRoot, {
      type: 'learned-fact',
      value: 'TypeScript generics improve DX',
      key: 'ts-generics-dx',
      source: 'agent-007',
      tags: ['typescript', 'dx'],
    });

    expect(entry.key).toBe('ts-generics-dx');
    expect(entry.source).toBe('agent-007');
    expect(entry.tags).toEqual(['typescript', 'dx']);

    const filePath = join(tmpRoot, '.agentforge', 'memory', 'learned-fact.jsonl');
    const parsed = JSON.parse(
      readFileSync(filePath, 'utf8').trim(),
    ) as CycleMemoryEntry;
    expect(parsed.key).toBe('ts-generics-dx');
    expect(parsed.source).toBe('agent-007');
    expect(parsed.tags).toEqual(['typescript', 'dx']);
  });

  it('omits key, source, and tags keys when not provided', () => {
    const entry = writeMemoryEntry(tmpRoot, {
      type: 'cycle-outcome',
      value: 'minimal',
    });

    // Keys should not be present (not just undefined) — sparse object
    expect('key' in entry).toBe(false);
    expect('source' in entry).toBe(false);
    expect('tags' in entry).toBe(false);
  });

  it('does not leave .lock files after successful write', () => {
    writeMemoryEntry(tmpRoot, { type: 'cycle-outcome', value: 'lock test' });

    const lockPath = join(tmpRoot, '.agentforge', 'memory', 'cycle-outcome.jsonl.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('is non-fatal when projectRoot is not writable', () => {
    // Passing a path that clearly cannot be created should not throw.
    expect(() =>
      writeMemoryEntry('/dev/null/no-such-path', {
        type: 'cycle-outcome',
        value: 'should not crash',
      }),
    ).not.toThrow();
  });
});

// ── readMemoryEntries ───────────────────────────────────────────────────────

describe('readMemoryEntries', () => {
  it('returns empty array when memory directory does not exist', () => {
    const entries = readMemoryEntries(tmpRoot, 'cycle-outcome');
    expect(entries).toEqual([]);
  });

  it('returns empty array when the specific type file does not exist', () => {
    // Write a different type so the directory exists
    writeMemoryEntry(tmpRoot, { type: 'gate-verdict', value: 'v' });
    const entries = readMemoryEntries(tmpRoot, 'cycle-outcome');
    expect(entries).toEqual([]);
  });

  it('reads all written entries back', () => {
    writeMemoryEntry(tmpRoot, { id: 'r1', type: 'review-finding', value: 'a' });
    writeMemoryEntry(tmpRoot, { id: 'r2', type: 'review-finding', value: 'b' });

    const entries = readMemoryEntries(tmpRoot, 'review-finding');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe('r1');
    expect(entries[1]!.id).toBe('r2');
  });

  it('applies the limit and returns the most-recent (tail) entries', () => {
    for (let i = 0; i < 15; i++) {
      writeMemoryEntry(tmpRoot, {
        id: `id-${i}`,
        type: 'failure-pattern',
        value: `v${i}`,
      });
    }

    const entries = readMemoryEntries(tmpRoot, 'failure-pattern', 5);
    expect(entries).toHaveLength(5);
    // The tail (most recent appended) entries should be returned
    expect(entries[0]!.id).toBe('id-10');
    expect(entries[4]!.id).toBe('id-14');
  });

  it('defaults to limit=10', () => {
    for (let i = 0; i < 12; i++) {
      writeMemoryEntry(tmpRoot, { type: 'learned-fact', value: `v${i}` });
    }
    const entries = readMemoryEntries(tmpRoot, 'learned-fact');
    expect(entries).toHaveLength(10);
  });

  it('returns all entries when count is below the limit', () => {
    writeMemoryEntry(tmpRoot, { type: 'gate-verdict', value: 'sole entry' });
    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 50);
    expect(entries).toHaveLength(1);
  });

  it('round-trips all CycleMemoryEntry fields without data loss', () => {
    const original: CycleMemoryEntry = {
      id: 'round-trip-id',
      type: 'cycle-outcome' as MemoryEntryType,
      value: 'round trip value',
      createdAt: '2026-04-09T12:00:00.000Z',
      source: 'cycle-test',
      tags: ['a', 'b'],
    };

    writeMemoryEntry(tmpRoot, original);
    const [read] = readMemoryEntries(tmpRoot, 'cycle-outcome', 1);

    expect(read).toEqual(original);
  });
});
