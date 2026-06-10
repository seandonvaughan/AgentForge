// W1 — af_kb_search MCP tool: keyword search over KB note entities.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afKbSearch } from '../af-kb-search.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-mcp-kb-search-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeEntities(entities: Array<Record<string, unknown>>): void {
  const dir = join(root, '.agentforge', 'knowledge');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entities.jsonl'), entities.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

it('returns note hits ranked by keyword overlap, ignoring term entities', () => {
  writeEntities([
    // term entity — must be ignored
    { id: '1', name: 'WorktreePool', type: 'module', properties: { source: 'review' }, createdAt: '2026-06-01T00:00:00Z' },
    // note entities
    {
      id: '2', name: 'worktree provisioning note', type: 'concept',
      description: 'worktree reuse requires completion markers before trusting node_modules',
      properties: { kind: 'note', source: 'review' }, createdAt: '2026-06-01T00:00:00Z',
    },
    {
      id: '3', name: 'dashboard note', type: 'concept',
      description: 'sparkline buckets cover 24 hours',
      properties: { kind: 'note', source: 'audit' }, createdAt: '2026-06-01T00:00:00Z',
    },
  ]);

  const result = afKbSearch({ query: 'worktree node_modules markers' }, root);
  expect(result.ok).toBe(true);
  expect(result.data!.hits.length).toBe(1);
  expect(result.data!.hits[0]!.text).toContain('completion markers');
  expect(result.data!.hits[0]!.source).toBe('review');
});

it('returns empty hits for a repo without a knowledge base', () => {
  const result = afKbSearch({ query: 'anything relevant' }, root);
  expect(result).toEqual({ ok: true, data: { hits: [] }, error: null });
});

it('rejects stopword-only queries', () => {
  const result = afKbSearch({ query: 'the and of' }, root);
  expect(result.ok).toBe(false);
  expect(result.error!.code).toBe('EMPTY_QUERY');
});
