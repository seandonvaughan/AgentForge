// W1 — full-text note entities + deterministic keyword retrieval.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeKnowledgeEntry, loadKnowledgeEntities } from '../persistence.js';
import { searchKnowledgeNotes, buildKbPromptBlock } from '../kb-retrieval.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-kb-retrieval-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeKnowledgeEntry note layer', () => {
  it('persists a full-text note entity alongside extracted terms', () => {
    const written = writeKnowledgeEntry(root, {
      text: 'The WorktreePool serializes git worktree creation behind a mutex to avoid config races.',
      source: 'review',
      cycleId: 'c1',
      tags: ['MAJOR'],
    });
    const note = written.find((e) => e.properties['kind'] === 'note');
    expect(note).toBeDefined();
    expect(note!.description).toContain('serializes git worktree creation');
    expect(note!.properties['source']).toBe('review');

    // Round-trips through the JSONL loader.
    const loaded = loadKnowledgeEntities(root);
    expect(loaded.some((e) => e.properties?.['kind'] === 'note')).toBe(true);
    // raw file sanity — one line per entity
    const raw = readFileSync(join(root, '.agentforge', 'knowledge', 'entities.jsonl'), 'utf8');
    expect(raw.trim().split('\n').length).toBe(written.length);
  });

  it('skips the note for trivially short text', () => {
    const written = writeKnowledgeEntry(root, { text: 'CamelCaseThing', source: 'audit' });
    expect(written.some((e) => e.properties['kind'] === 'note')).toBe(false);
  });
});

describe('searchKnowledgeNotes', () => {
  it('returns keyword-relevant notes ranked by overlap', () => {
    writeKnowledgeEntry(root, {
      text: 'The worktree pool requires completion markers before reusing node_modules installs.',
      source: 'review',
    });
    writeKnowledgeEntry(root, {
      text: 'Dashboard sparkline buckets cover the last 24 hours in two-hour windows.',
      source: 'audit',
    });

    const hits = searchKnowledgeNotes(root, 'reuse worktree node_modules provisioning', 3);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.text).toContain('completion markers');
    // The unrelated dashboard note must not outrank the relevant one.
    expect(hits[0]!.text).not.toContain('sparkline');
  });

  it('returns [] on fresh repos and for stopword-only queries', () => {
    expect(searchKnowledgeNotes(root, 'worktree pool')).toEqual([]);
    writeKnowledgeEntry(root, { text: 'Some note text that is long enough to persist.', source: 'learn' });
    expect(searchKnowledgeNotes(root, 'the and of to')).toEqual([]);
  });
});

describe('buildKbPromptBlock', () => {
  it('renders hits as a sourced bullet block, empty string for no hits', () => {
    expect(buildKbPromptBlock([])).toBe('');
    const block = buildKbPromptBlock([
      { name: 'n', text: 'watch out for the barrel file', source: 'review', createdAt: '', score: 3 },
    ]);
    expect(block).toContain('## Project knowledge');
    expect(block).toContain('- [review] watch out for the barrel file');
  });
});
