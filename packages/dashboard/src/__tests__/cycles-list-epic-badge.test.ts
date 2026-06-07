import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CYCLES_LIST = resolve(import.meta.dirname, '../routes/cycles/+page.svelte');

function source(): string {
  return readFileSync(CYCLES_LIST, 'utf-8');
}

describe('cycles list epic badge contract', () => {
  it('reads epic metadata from the list endpoint row shape', () => {
    const s = source();

    expect(s).toContain('isEpic?: boolean;');
    expect(s).toContain('childCount?: number | null;');
  });

  it('renders epic rows with an epic badge and child count', () => {
    const s = source();

    expect(s).toContain('{#if c.isEpic}');
    expect(s).toContain('<Badge variant="purple">epic</Badge>');
    expect(s).toContain('<span class="epic-child-count af2-mono">{c.childCount ?? 0} children</span>');
  });

  it('keeps signal rows badge-free by not rendering an else branch', () => {
    const s = source();
    const epicBlock = s.match(/\{#if c\.isEpic\}[\s\S]*?\{\/if\}/)?.[0] ?? '';

    expect(epicBlock).toContain('<Badge variant="purple">epic</Badge>');
    expect(epicBlock).not.toContain('{:else}');
  });

  it('guards document polling hooks with the browser environment flag', () => {
    const s = source();

    expect(s).toContain("import { browser } from '$app/environment';");
    expect(s).toContain("const paused = browser && document.visibilityState === 'hidden';");
    expect(s).toContain('if (browser) {');
  });
});
