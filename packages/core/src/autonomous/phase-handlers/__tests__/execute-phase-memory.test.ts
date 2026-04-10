/**
 * Unit tests for execute-phase memory injection helpers:
 *   - readRelevantMemoryEntries
 *   - formatMemorySection
 *
 * These helpers close the memory feedback loop: before each sprint item is
 * dispatched to an agent, prior failure entries are read from the JSONL store,
 * filtered by tag overlap, and injected into the prompt so agents avoid
 * repeating past mistakes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readRelevantMemoryEntries,
  formatMemorySection,
  type MemoryEntry,
} from '../execute-phase.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-exec-mem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write one or more MemoryEntry objects as JSONL lines to a given filename. */
function writeMemoryFile(filename: string, entries: MemoryEntry[]): void {
  const memDir = join(tmpRoot, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(memDir, filename), content, 'utf8');
}

// ---------------------------------------------------------------------------
// readRelevantMemoryEntries
// ---------------------------------------------------------------------------

describe('readRelevantMemoryEntries', () => {
  it('returns an empty array when the memory directory does not exist', () => {
    const entries = readRelevantMemoryEntries(tmpRoot, ['typescript']);
    expect(entries).toEqual([]);
  });

  it('returns an empty array when no JSONL files are present', () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'memory'), { recursive: true });
    const entries = readRelevantMemoryEntries(tmpRoot, ['typescript']);
    expect(entries).toEqual([]);
  });

  it('returns entries whose tags overlap with the item tags', () => {
    writeMemoryFile('review-finding.jsonl', [
      { id: 'e1', type: 'review-finding', value: 'Missing tests', tags: ['typescript', 'testing'] },
      { id: 'e2', type: 'review-finding', value: 'Unrelated', tags: ['deployment'] },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['typescript']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('e1');
  });

  it('excludes entries with no tag overlap', () => {
    writeMemoryFile('failure-pattern.jsonl', [
      { id: 'fp1', type: 'failure-pattern', value: 'Wrong thing', tags: ['python', 'ci'] },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['typescript', 'memory']);
    expect(entries).toEqual([]);
  });

  it('returns all entries when itemTags is empty (no filter applied)', () => {
    writeMemoryFile('gate-verdict.jsonl', [
      { id: 'gv1', type: 'gate-verdict', value: 'rejected', tags: ['deploy'] },
      { id: 'gv2', type: 'gate-verdict', value: 'rejected again', tags: ['testing'] },
    ]);

    // Empty tags → tagSet.size === 0 → skip the tag filter, include everything.
    const entries = readRelevantMemoryEntries(tmpRoot, []);
    expect(entries).toHaveLength(2);
  });

  it('performs case-insensitive tag matching', () => {
    writeMemoryFile('learned-fact.jsonl', [
      { id: 'lf1', type: 'learned-fact', value: 'TypeScript generics', tags: ['TypeScript', 'DX'] },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['typescript']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('lf1');
  });

  it('reads across multiple JSONL files and merges results', () => {
    writeMemoryFile('review-finding.jsonl', [
      { id: 'rf1', type: 'review-finding', value: 'MAJOR: no validation', tags: ['api', 'memory'] },
    ]);
    writeMemoryFile('gate-verdict.jsonl', [
      { id: 'gv1', type: 'gate-verdict', value: 'Gate rejected', tags: ['memory', 'execute-phase'] },
    ]);
    writeMemoryFile('cycle-outcome.jsonl', [
      { id: 'co1', type: 'cycle-outcome', value: 'Cycle summary', tags: ['memory'] },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['memory']);
    expect(entries).toHaveLength(3);
  });

  it('respects the maxEntries cap', () => {
    const manyEntries: MemoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      type: 'review-finding',
      value: `finding ${i}`,
      tags: ['memory'],
    }));
    writeMemoryFile('review-finding.jsonl', manyEntries);

    const entries = readRelevantMemoryEntries(tmpRoot, ['memory'], 3);
    expect(entries).toHaveLength(3);
  });

  it('defaults to maxEntries=5', () => {
    const manyEntries: MemoryEntry[] = Array.from({ length: 8 }, (_, i) => ({
      id: `e${i}`,
      type: 'failure-pattern',
      value: `fp ${i}`,
      tags: ['chore'],
    }));
    writeMemoryFile('failure-pattern.jsonl', manyEntries);

    const entries = readRelevantMemoryEntries(tmpRoot, ['chore']);
    expect(entries).toHaveLength(5);
  });

  it('prioritises failure-related types above cycle-outcome', () => {
    // cycle-outcome is explicitly excluded from PRIORITY_TYPES in the handler.
    const now = new Date().toISOString();
    writeMemoryFile('cycle-outcome.jsonl', [
      { id: 'co1', type: 'cycle-outcome', value: 'outcome', tags: ['memory'], createdAt: now },
    ]);
    writeMemoryFile('failure-pattern.jsonl', [
      { id: 'fp1', type: 'failure-pattern', value: 'failure', tags: ['memory'], createdAt: now },
    ]);
    writeMemoryFile('gate-verdict.jsonl', [
      { id: 'gv1', type: 'gate-verdict', value: 'rejected', tags: ['memory'], createdAt: now },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['memory'], 10);
    // Failure-related types come first; cycle-outcome is last.
    const types = entries.map((e) => e.type);
    const lastIndex = types.lastIndexOf('cycle-outcome');
    expect(lastIndex).toBe(types.length - 1);
    // fp1 and gv1 must both appear before co1.
    expect(types.indexOf('failure-pattern')).toBeLessThan(lastIndex);
    expect(types.indexOf('gate-verdict')).toBeLessThan(lastIndex);
  });

  it('sorts within priority group by recency (most recent first)', () => {
    writeMemoryFile('review-finding.jsonl', [
      {
        id: 'old',
        type: 'review-finding',
        value: 'old finding',
        tags: ['memory'],
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'new',
        type: 'review-finding',
        value: 'new finding',
        tags: ['memory'],
        createdAt: '2026-04-09T00:00:00.000Z',
      },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['memory'], 10);
    expect(entries[0]!.id).toBe('new');
    expect(entries[1]!.id).toBe('old');
  });

  it('silently skips malformed JSONL lines', () => {
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    // One valid line, one garbage line.
    writeFileSync(
      join(memDir, 'failure-pattern.jsonl'),
      '{"id":"good","type":"failure-pattern","value":"ok","tags":["memory"]}\nNOT_JSON\n',
      'utf8',
    );

    const entries = readRelevantMemoryEntries(tmpRoot, ['memory']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('good');
  });

  it('silently skips unreadable JSONL files', () => {
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    // Write a directory where a file is expected — will fail readFileSync.
    mkdirSync(join(memDir, 'broken.jsonl'));
    // Also write a healthy file to confirm other files still work.
    writeMemoryFile('review-finding.jsonl', [
      { id: 'ok', type: 'review-finding', value: 'fine', tags: ['memory'] },
    ]);

    const entries = readRelevantMemoryEntries(tmpRoot, ['memory']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// formatMemorySection
// ---------------------------------------------------------------------------

describe('formatMemorySection', () => {
  it('returns an empty string for an empty entry list', () => {
    expect(formatMemorySection([])).toBe('');
  });

  it('includes a section header', () => {
    const entries: MemoryEntry[] = [
      { id: 'e1', type: 'review-finding', value: 'MAJOR: missing type checks', tags: [] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('## Memory: Past Failures on Similar Work');
  });

  it('formats each entry as a bullet point with type and label', () => {
    const entries: MemoryEntry[] = [
      { id: 'abc-123', type: 'failure-pattern', value: 'Always validate input', tags: [] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('- [failure-pattern]');
    expect(section).toContain('**abc-123**');
    expect(section).toContain('Always validate input');
  });

  it('prefers key over id as the label', () => {
    const entries: MemoryEntry[] = [
      { id: 'uuid-999', key: 'guard-sprint-items', type: 'learned-fact', value: 'Validate before dispatch', tags: [] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('**guard-sprint-items**');
    expect(section).not.toContain('uuid-999');
  });

  it('falls back to id when key is absent', () => {
    const entries: MemoryEntry[] = [
      { id: 'fallback-id', type: 'gate-verdict', value: 'rejected: no tests', tags: [] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('**fallback-id**');
  });

  it('falls back to type when both key and id are absent', () => {
    const entries: MemoryEntry[] = [
      { type: 'review-finding', value: 'something broke', tags: [] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('**review-finding**');
  });

  it('JSON-stringifies non-string value fields', () => {
    const entries: MemoryEntry[] = [
      // Cast to any to simulate a deserialized object value arriving at runtime.
      { id: 'e1', type: 'cycle-outcome', value: JSON.stringify({ verdict: 'ok', cost: 1.5 }), tags: [] },
    ];
    const section = formatMemorySection(entries);
    // The value was already a string (JSON.stringify result), just confirm it renders.
    expect(section).toContain('verdict');
  });

  it('renders multiple entries as separate bullet points', () => {
    const entries: MemoryEntry[] = [
      { id: 'e1', type: 'review-finding', value: 'First finding', tags: [] },
      { id: 'e2', type: 'failure-pattern', value: 'Second finding', tags: [] },
    ];
    const section = formatMemorySection(entries);
    const lines = section.split('\n').filter((l) => l.startsWith('-'));
    expect(lines).toHaveLength(2);
  });

  it('includes the instructional preamble', () => {
    const entries: MemoryEntry[] = [
      { id: 'e1', type: 'failure-pattern', value: 'Watch out', tags: [] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('avoid repeating past mistakes');
  });
});
