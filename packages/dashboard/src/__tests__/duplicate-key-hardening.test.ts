import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROUTES_ROOT = resolve(import.meta.dirname, '../routes');
const AGENT_DETAIL = resolve(ROUTES_ROOT, 'agents/[id]/+page.svelte');
const CYCLE_DETAIL = resolve(ROUTES_ROOT, 'cycles/[id]/+page.svelte');

function source(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('dashboard duplicate-key hardening', () => {
  it('does not key agent detail sessions or memory rows only by legacy ids', () => {
    const s = source(AGENT_DETAIL);

    expect(s).toContain('function sessionRowKey');
    expect(s).toContain('function memoryEntryKey');
    expect(s).toContain('{#each sessions as s, i (sessionRowKey(s, i))}');
    expect(s).toContain('{#each memFiltered as m, i (memoryEntryKey(m, i))}');
    expect(s).not.toContain('{#each sessions as s (s.id ?? Math.random())}');
    expect(s).not.toContain('{#each memFiltered as m (m.id)}');
  });

  it('does not key cycle item views only by duplicate-prone backlog ids', () => {
    const s = source(CYCLE_DETAIL);

    expect(s).toContain('function sprintItemKey');
    expect(s).toContain('function scoredItemKey');
    expect(s).toContain("{#each itemsByStatus.inProgress.slice(0, 1) as it, i (sprintItemKey(it, i, 'now'))}");
    expect(s).toContain('{#each col.items as it, i (sprintItemKey(it, i, col.title))}');
    expect(s).toContain('{#each [...scoring.items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) as it, idx (scoredItemKey(it, idx))}');
    expect(s).not.toContain('{#each col.items as it (it.id)}');
    expect(s).not.toContain('{#each [...scoring.items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) as it, idx (it.id ?? idx)}');
  });
});
