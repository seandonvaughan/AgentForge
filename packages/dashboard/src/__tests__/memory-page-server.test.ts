/**
 * Unit tests for the SSR-side memory data loading in
 * packages/dashboard/src/routes/memory/+page.server.ts.
 *
 * Exercises _readMemoriesJson (curated JSON path) and _readMemoryEntries
 * (JSONL + curated merge path) with isolated tmp directories so the tests
 * never touch the checked-in project files.
 *
 * A smoke test at the bottom verifies the real project data loads without
 * errors — mirrors the pattern used in agents-page-server.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _readMemoriesJson, _readMemoryEntries } from '../routes/memory/+page.server.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-memory-ssr-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDataDir(): string {
  const dir = join(tmpRoot, '.agentforge', 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMemoryDir(): string {
  const dir = join(tmpRoot, '.agentforge', 'memory');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMemoriesJson(entries: unknown[]): void {
  const dir = makeDataDir();
  writeFileSync(
    join(dir, 'memories.json'),
    JSON.stringify({ version: '1.0', entries }),
  );
}

function writeJsonlFile(filename: string, lines: unknown[]): void {
  const dir = makeMemoryDir();
  writeFileSync(join(dir, filename), lines.map(l => JSON.stringify(l)).join('\n'));
}

// ── _readMemoriesJson — curated JSON file ─────────────────────────────────────

describe('_readMemoriesJson — missing / empty states', () => {
  it('returns [] when .agentforge/data/memories.json does not exist', () => {
    expect(_readMemoriesJson(tmpRoot)).toEqual([]);
  });

  it('returns [] when memories.json has no entries array', () => {
    const dir = makeDataDir();
    writeFileSync(join(dir, 'memories.json'), JSON.stringify({ version: '1.0' }));
    expect(_readMemoriesJson(tmpRoot)).toEqual([]);
  });

  it('returns [] when memories.json is malformed JSON', () => {
    const dir = makeDataDir();
    writeFileSync(join(dir, 'memories.json'), '{ invalid }');
    expect(_readMemoriesJson(tmpRoot)).toEqual([]);
  });

  it('returns [] when entries array is empty', () => {
    writeMemoriesJson([]);
    expect(_readMemoriesJson(tmpRoot)).toEqual([]);
  });
});

describe('_readMemoriesJson — field mapping', () => {
  it('maps a minimal entry with id and summary', () => {
    writeMemoriesJson([
      { id: 'mem-001', summary: 'Test summary', category: 'lesson' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'mem-001',
      value: 'Test summary',
      summary: 'Test summary',
      category: 'lesson',
      type: 'lesson',
    });
  });

  it('uses filename (without extension) as the display key', () => {
    writeMemoriesJson([
      { id: 'mem-001', filename: 'lesson_parallel_agents.md', summary: 'x' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.key).toBe('lesson_parallel_agents');
  });

  it('strips .json extension from filename key', () => {
    writeMemoriesJson([
      { id: 'mem-001', filename: 'config_data.json', summary: 'x' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.key).toBe('config_data');
  });

  it('falls back to id as key when filename is missing', () => {
    writeMemoriesJson([{ id: 'mem-999', summary: 'no filename' }]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.key).toBe('mem-999');
  });

  it('generates a synthetic id (curated-N) when entry has no id', () => {
    writeMemoriesJson([
      { summary: 'no id here', category: 'feedback' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.id).toBe('curated-0');
  });

  it('maps agentId and source from the agentId field', () => {
    writeMemoriesJson([
      { id: 'mem-001', agentId: 'ceo', summary: 'test', category: 'config' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.agentId).toBe('ceo');
    expect(result[0]!.source).toBe('ceo');
  });

  it('maps tags array when present', () => {
    writeMemoriesJson([
      { id: 'mem-001', tags: ['cost', 'routing'], summary: 'x' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.tags).toEqual(['cost', 'routing']);
  });

  it('defaults tags to [] when absent', () => {
    writeMemoriesJson([{ id: 'mem-001', summary: 'x' }]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.tags).toEqual([]);
  });

  it('maps createdAt and updatedAt', () => {
    const ts = '2026-03-15T10:00:00.000Z';
    writeMemoriesJson([{ id: 'mem-001', summary: 'x', createdAt: ts }]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result[0]!.createdAt).toBe(ts);
    expect(result[0]!.updatedAt).toBe(ts); // fallback to createdAt when updatedAt missing
  });

  it('returns multiple entries in order', () => {
    writeMemoriesJson([
      { id: 'mem-001', summary: 'first', category: 'project' },
      { id: 'mem-002', summary: 'second', category: 'feedback' },
    ]);

    const result = _readMemoriesJson(tmpRoot);
    expect(result).toHaveLength(2);
    expect(result.map(e => e.id)).toEqual(['mem-001', 'mem-002']);
  });
});

// ── _readMemoryEntries — empty project ───────────────────────────────────────

describe('_readMemoryEntries — empty project', () => {
  it('returns empty entries, agents, and types when no data exists', () => {
    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.types).toEqual([]);
  });

  it('returns empty result when memory dir exists but has no .jsonl files', () => {
    makeMemoryDir();
    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toEqual([]);
  });

  it('reads curated memories.json even when JSONL directory is absent', () => {
    writeMemoriesJson([
      { id: 'mem-001', summary: 'curated entry', category: 'lesson', agentId: 'ceo' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('mem-001');
    expect(result.agents).toEqual(['ceo']);
    expect(result.types).toContain('lesson');
  });
});

// ── _readMemoryEntries — JSONL reading ────────────────────────────────────────

describe('_readMemoryEntries — JSONL reading', () => {
  it('reads a single JSONL file and returns its entries', () => {
    writeJsonlFile('cycle-outcomes.jsonl', [
      { id: 'e1', type: 'cycle-outcome', value: '{"sprintVersion":"v12.0.0","stage":"completed"}', createdAt: '2026-05-01T00:00:00Z', source: 'cycle-abc' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('e1');
    expect(result.entries[0]!.type).toBe('cycle-outcome');
    expect(result.entries[0]!.source).toBe('cycle-abc');
  });

  it('skips JSONL lines missing required id or type fields', () => {
    writeJsonlFile('mixed.jsonl', [
      { id: 'good', type: 'learned-fact', value: 'x', createdAt: '2026-05-01T00:00:00Z' },
      { value: 'no id or type' },             // missing both
      { id: 'no-type', value: 'missing type' }, // missing type
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('good');
  });

  it('skips malformed (non-JSON) JSONL lines without crashing', () => {
    const dir = makeMemoryDir();
    writeFileSync(join(dir, 'bad.jsonl'), [
      JSON.stringify({ id: 'ok', type: 'learned-fact', value: 'x', createdAt: '2026-05-01T00:00:00Z' }),
      '{ not valid json :::',
    ].join('\n'));

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('ok');
  });

  it('ignores non-.jsonl files in the memory directory', () => {
    const dir = makeMemoryDir();
    writeFileSync(join(dir, 'notes.txt'), 'not jsonl');
    writeFileSync(join(dir, 'config.json'), '{"entries":[]}');
    writeJsonlFile('real.jsonl', [
      { id: 'e1', type: 'learned-fact', value: 'hello', createdAt: '2026-05-01T00:00:00Z' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
  });

  it('accumulates agents and types from JSONL entries', () => {
    writeJsonlFile('data.jsonl', [
      { id: 'e1', type: 'gate-verdict', value: '{}', source: 'cycle-1', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'e2', type: 'review-finding', value: 'x', source: 'cycle-2', createdAt: '2026-05-02T00:00:00Z' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.agents).toContain('cycle-1');
    expect(result.agents).toContain('cycle-2');
    expect(result.types).toContain('gate-verdict');
    expect(result.types).toContain('review-finding');
  });
});

// ── _readMemoryEntries — per-agent memory (v25: memory/agents/*.jsonl) ───────

describe('_readMemoryEntries — per-agent memory files (v25)', () => {
  function writeAgentJsonlFile(agentId: string, lines: unknown[]): void {
    const dir = join(makeMemoryDir(), 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${agentId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }

  it('picks up memory/agents/*.jsonl entries as type agent-memory with agentId from filename', () => {
    writeAgentJsonlFile('cli-engineer', [
      { id: 'am-1', kind: 'self-note', value: 'Always register new v5 routes in both server paths.', createdAt: '2026-06-01T00:00:00Z', cycleId: 'cycle-1', itemId: 'item-1' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.type).toBe('agent-memory');
    expect(entry.agentId).toBe('cli-engineer');
    expect(entry.kind).toBe('self-note');
    expect(entry.cycleId).toBe('cycle-1');
    expect(entry.itemId).toBe('item-1');
    expect(result.agents).toContain('cli-engineer');
    expect(result.types).toContain('agent-memory');
  });

  it('preserves the item-outcome kind and outcome field', () => {
    writeAgentJsonlFile('coder', [
      { id: 'am-2', kind: 'item-outcome', value: 'completed "thing" (1 attempt, $0.10)', createdAt: '2026-06-01T00:00:00Z', cycleId: 'cycle-9', itemId: 'item-9', outcome: 'completed' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe('item-outcome');
    expect(result.entries[0]!.outcome).toBe('completed');
  });

  it('merges per-agent entries alongside shared-pool JSONL entries', () => {
    writeJsonlFile('gate-verdict.jsonl', [
      { id: 'gv-1', type: 'gate-verdict', value: '{}', createdAt: '2026-05-02T00:00:00Z' },
    ]);
    writeAgentJsonlFile('coder', [
      { id: 'am-3', kind: 'self-note', value: 'A lesson worth keeping around.', createdAt: '2026-06-01T00:00:00Z' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries.map(e => e.id).sort()).toEqual(['am-3', 'gv-1']);
  });

  it('skips malformed lines and entries without an id in per-agent files', () => {
    const dir = join(makeMemoryDir(), 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'coder.jsonl'), [
      '{ not valid json :::',
      JSON.stringify({ kind: 'self-note', value: 'missing id' }),
      JSON.stringify({ id: 'ok-1', kind: 'self-note', value: 'valid lesson here', createdAt: '2026-06-01T00:00:00Z' }),
    ].join('\n') + '\n');

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('ok-1');
  });
});

// ── _readMemoryEntries — merge and deduplication ──────────────────────────────

describe('_readMemoryEntries — JSONL + curated merge', () => {
  it('merges curated entries alongside JSONL entries', () => {
    writeJsonlFile('data.jsonl', [
      { id: 'jsonl-1', type: 'gate-verdict', value: '{}', createdAt: '2026-05-02T00:00:00Z' },
    ]);
    writeMemoriesJson([
      { id: 'curated-a', summary: 'curated entry', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    const ids = result.entries.map(e => e.id);
    expect(ids).toContain('jsonl-1');
    expect(ids).toContain('curated-a');
  });

  it('deduplicates by id — JSONL wins over curated when same id appears in both', () => {
    writeJsonlFile('data.jsonl', [
      { id: 'shared-id', type: 'gate-verdict', value: '{"verdict":"APPROVE"}', createdAt: '2026-05-02T00:00:00Z' },
    ]);
    writeMemoriesJson([
      { id: 'shared-id', summary: 'this should be ignored', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    const matching = result.entries.filter(e => e.id === 'shared-id');
    expect(matching).toHaveLength(1);
    // JSONL entry should win — its type is gate-verdict, not lesson
    expect(matching[0]!.type).toBe('gate-verdict');
  });

  it('sorts entries newest-first by createdAt', () => {
    writeMemoriesJson([
      { id: 'old', summary: 'old', createdAt: '2026-01-01T00:00:00Z', category: 'lesson' },
      { id: 'new', summary: 'new', createdAt: '2026-05-01T00:00:00Z', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries[0]!.id).toBe('new');
    expect(result.entries[1]!.id).toBe('old');
  });
});

// ── _readMemoryEntries — filtering ────────────────────────────────────────────

describe('_readMemoryEntries — search filter', () => {
  it('returns all entries when searchTerm is undefined', () => {
    writeMemoriesJson([
      { id: 'a', summary: 'alpha', category: 'lesson' },
      { id: 'b', summary: 'beta', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(2);
  });

  it('filters by searchTerm matching the summary (case-insensitive)', () => {
    writeMemoriesJson([
      { id: 'a', summary: 'Model routing for Opus', category: 'config' },
      { id: 'b', summary: 'Cost control strategies', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { searchTerm: 'opus' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('a');
  });

  it('filters by searchTerm matching tags', () => {
    writeMemoriesJson([
      { id: 'a', summary: 'x', tags: ['routing', 'cost'], category: 'config' },
      { id: 'b', summary: 'y', tags: ['testing'], category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { searchTerm: 'routing' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('a');
  });

  it('returns no entries when searchTerm matches nothing', () => {
    writeMemoriesJson([
      { id: 'a', summary: 'something', tags: ['a', 'b'], category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { searchTerm: 'zzznomatch' });
    expect(result.entries).toHaveLength(0);
  });
});

describe('_readMemoryEntries — agent filter', () => {
  it('returns all entries when agentFilter is undefined', () => {
    writeMemoriesJson([
      { id: 'a', agentId: 'ceo', summary: 'x', category: 'config' },
      { id: 'b', agentId: 'coo', summary: 'y', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, {});
    expect(result.entries).toHaveLength(2);
  });

  it('returns all entries when agentFilter is "all"', () => {
    writeMemoriesJson([
      { id: 'a', agentId: 'ceo', summary: 'x', category: 'config' },
      { id: 'b', agentId: 'coo', summary: 'y', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { agentFilter: 'all' });
    expect(result.entries).toHaveLength(2);
  });

  it('filters to a specific agent by agentId', () => {
    writeMemoriesJson([
      { id: 'a', agentId: 'ceo', summary: 'x', category: 'config' },
      { id: 'b', agentId: 'coo', summary: 'y', category: 'lesson' },
      { id: 'c', agentId: 'ceo', summary: 'z', category: 'feedback' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { agentFilter: 'ceo' });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every(e => e.agentId === 'ceo')).toBe(true);
  });

  it('returns empty entries when filtering by unknown agentId', () => {
    writeMemoriesJson([
      { id: 'a', agentId: 'ceo', summary: 'x', category: 'config' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { agentFilter: 'unknown-agent' });
    expect(result.entries).toHaveLength(0);
  });
});

describe('_readMemoryEntries — type filter', () => {
  it('filters entries to a specific type', () => {
    writeJsonlFile('data.jsonl', [
      { id: 'e1', type: 'gate-verdict', value: '{}', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'e2', type: 'review-finding', value: 'x', createdAt: '2026-05-02T00:00:00Z' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { typeFilter: 'gate-verdict' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('gate-verdict');
  });

  it('agents and types arrays reflect the full corpus even when typeFilter is active', () => {
    writeJsonlFile('data.jsonl', [
      { id: 'e1', type: 'gate-verdict', value: '{}', source: 'agent-a', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'e2', type: 'review-finding', value: 'x', source: 'agent-b', createdAt: '2026-05-02T00:00:00Z' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { typeFilter: 'gate-verdict' });
    // agents and types come from the full corpus scan before filtering
    expect(result.agents).toContain('agent-a');
    expect(result.agents).toContain('agent-b');
    expect(result.types).toContain('gate-verdict');
    expect(result.types).toContain('review-finding');
    // But entries are filtered
    expect(result.entries).toHaveLength(1);
  });

  it('returns empty entries when typeFilter matches nothing', () => {
    writeMemoriesJson([
      { id: 'a', summary: 'x', category: 'lesson' },
    ]);

    const result = _readMemoryEntries(tmpRoot, { typeFilter: 'cycle-outcome' });
    expect(result.entries).toHaveLength(0);
  });
});

describe('_readMemoryEntries — combined search + agent + type filters', () => {
  it('applies all three filters simultaneously', () => {
    writeMemoriesJson([
      { id: 'a', agentId: 'ceo', summary: 'routing strategy', tags: ['routing'], category: 'config' },
      { id: 'b', agentId: 'ceo', summary: 'cost analysis', tags: ['cost'], category: 'lesson' },
      { id: 'c', agentId: 'coo', summary: 'routing tables', tags: ['routing'], category: 'config' },
    ]);

    // All three filters: agent=ceo, type=config, search=routing
    const result = _readMemoryEntries(tmpRoot, {
      agentFilter: 'ceo',
      typeFilter: 'config',
      searchTerm: 'routing',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('a');
  });

  it('filter-before-cap: applies filters before the SSR_LIMIT slice', () => {
    // Write 210 entries — more than SSR_LIMIT (200) — only 5 match the filter
    const entries: unknown[] = [];
    for (let i = 0; i < 205; i++) {
      entries.push({
        id: `e-${i}`,
        summary: `entry ${i}`,
        category: 'lesson',
        agentId: 'generic',
        createdAt: `2026-05-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`,
      });
    }
    // 5 entries with a unique agent
    for (let i = 205; i < 210; i++) {
      entries.push({
        id: `special-${i}`,
        summary: `special entry ${i}`,
        category: 'config',
        agentId: 'special-agent',
        createdAt: `2026-06-01T00:00:00Z`,
      });
    }
    writeMemoriesJson(entries);

    // Without filter: returns capped at 200
    const unfiltered = _readMemoryEntries(tmpRoot, {});
    expect(unfiltered.entries).toHaveLength(200);

    // With agent filter: all 5 special entries should appear even though they
    // would be beyond the cap in an unfiltered response
    const filtered = _readMemoryEntries(tmpRoot, { agentFilter: 'special-agent' });
    expect(filtered.entries).toHaveLength(5);
    expect(filtered.entries.every(e => e.agentId === 'special-agent')).toBe(true);
  });
});

// ── Real-project smoke test ───────────────────────────────────────────────────

describe('_readMemoryEntries — real project data', () => {
  it('returns real memory entries from the live .agentforge directory', () => {
    // 4 levels up from packages/dashboard/src/__tests__/
    const realRoot = join(import.meta.dirname, '../../../../');
    const result = _readMemoryEntries(realRoot, {});

    // The project has at least the 18 curated entries in memories.json
    expect(result.entries.length).toBeGreaterThanOrEqual(1);

    // Every entry must have a non-empty id and key
    for (const entry of result.entries) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.key.length).toBeGreaterThan(0);
    }

    // agents and types arrays are always sorted
    const sortedAgents = [...result.agents].sort();
    expect(result.agents).toEqual(sortedAgents);
    const sortedTypes = [...result.types].sort();
    expect(result.types).toEqual(sortedTypes);
  });

  it('search filter returns subset of real entries', () => {
    const realRoot = join(import.meta.dirname, '../../../../');
    const all = _readMemoryEntries(realRoot, {});
    const filtered = _readMemoryEntries(realRoot, { searchTerm: 'routing' });

    // filtered is a strict subset
    expect(filtered.entries.length).toBeLessThanOrEqual(all.entries.length);
    // every filtered entry must actually match the search term
    for (const entry of filtered.entries) {
      const haystack = [entry.key, entry.value, entry.summary ?? '', (entry.tags ?? []).join(' ')]
        .join(' ')
        .toLowerCase();
      expect(haystack).toContain('routing');
    }
  });
});
