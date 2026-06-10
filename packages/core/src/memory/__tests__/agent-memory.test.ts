// W2 — per-agent personal memory store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAgentMemory,
  readAgentMemory,
  extractLearnedNotes,
  AGENT_MEMORY_MAX_ENTRIES,
} from '../agent-memory.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-agent-memory-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('appendAgentMemory / readAgentMemory', () => {
  it('appends to .agentforge/memory/agents/<agentId>.jsonl and reads newest-first', () => {
    appendAgentMemory(root, 'coder', { kind: 'item-outcome', value: 'first', itemId: 'i1', outcome: 'completed' });
    appendAgentMemory(root, 'coder', { kind: 'self-note', value: 'second' });

    const file = join(root, '.agentforge', 'memory', 'agents', 'coder.jsonl');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);

    const entries = readAgentMemory(root, 'coder', 5);
    expect(entries.map((e) => e.value)).toEqual(['second', 'first']);
    expect(entries[1]).toMatchObject({ kind: 'item-outcome', itemId: 'i1', outcome: 'completed' });
  });

  it('isolates agents — one agent never sees another\'s memory', () => {
    appendAgentMemory(root, 'coder', { kind: 'self-note', value: 'coder note' });
    appendAgentMemory(root, 'reviewer', { kind: 'self-note', value: 'reviewer note' });
    expect(readAgentMemory(root, 'coder').map((e) => e.value)).toEqual(['coder note']);
    expect(readAgentMemory(root, 'reviewer').map((e) => e.value)).toEqual(['reviewer note']);
  });

  it('rejects unsafe agent ids (no path traversal)', () => {
    expect(appendAgentMemory(root, '../evil', { kind: 'self-note', value: 'nope' })).toBeNull();
    expect(readAgentMemory(root, '../evil')).toEqual([]);
  });

  it('compacts to the cap with dedupe-by-value (latest wins)', () => {
    for (let i = 0; i < AGENT_MEMORY_MAX_ENTRIES + 20; i++) {
      appendAgentMemory(root, 'coder', { kind: 'self-note', value: `note-${i}` });
    }
    // duplicate value — must not double-count after compaction
    appendAgentMemory(root, 'coder', { kind: 'self-note', value: 'note-0' });

    const file = join(root, '.agentforge', 'memory', 'agents', 'coder.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(AGENT_MEMORY_MAX_ENTRIES);

    const newest = readAgentMemory(root, 'coder', 1)[0];
    expect(newest!.value).toBe('note-0');
  });

  it('returns [] for a fresh repo', () => {
    expect(readAgentMemory(root, 'coder')).toEqual([]);
  });
});

describe('extractLearnedNotes', () => {
  it('extracts LEARNED: lines (bulleted or bare, case-insensitive), capped at 3', () => {
    const response = [
      'I did the thing.',
      'LEARNED: the build requires corepack pnpm, plain npm fails on lockfile v9',
      '- learned: SvelteKit treats +*.ts in routes/ as route files',
      'LEARNED: too short',
      'LEARNED: vitest 4 rejects --minWorkers with a fatal CACError',
      'LEARNED: a fourth note that exceeds the cap and is dropped entirely yes',
      'Done.',
    ].join('\n');
    const notes = extractLearnedNotes(response);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('corepack pnpm');
    expect(notes[1]).toContain('SvelteKit');
    expect(notes[2]).toContain('vitest 4');
  });

  it('returns [] when no LEARNED markers present', () => {
    expect(extractLearnedNotes('just a normal report\nwith lines')).toEqual([]);
  });
});
