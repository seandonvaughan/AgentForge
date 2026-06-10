/**
 * Source-level contract tests for the epic badge on /cycles (+page.svelte).
 *
 * SvelteKit Svelte components that import $app/* modules cannot be rendered in
 * plain vitest without the full Kit Vite plugin — hanging transforms make
 * component mounting infeasible here. Full rendering is covered by Playwright e2e.
 *
 * This file asserts source-level contracts for the epic badge feature added by
 * this item, consuming the `epic`/`childCount` fields plumbed server-side by
 * child-6 (packages/server/src/routes/v5/cycles.ts):
 *  - The CycleRow interface declares the `epic` and `childCount` fields.
 *  - An `epicLabel()` helper renders the 'epic · N children' text with
 *    singular/plural handling.
 *  - The badge is gated on `epic === true` so non-epic rows are untouched.
 *  - The badge uses v2 design tokens (--af-purple, color-mix) like the rest
 *    of the file, not a hard-coded colour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

let src: string;
function read(): string {
  if (!src) src = readFileSync(PAGE_PATH, 'utf-8');
  return src;
}

describe('+page.svelte file presence', () => {
  it('exists at the expected SvelteKit route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

describe('CycleRow epic fields (from child-6 payload)', () => {
  it('declares the epic field on the row type', () => {
    expect(read()).toMatch(/epic\?:\s*boolean/);
  });

  it('declares the childCount field on the row type', () => {
    expect(read()).toMatch(/childCount\?:\s*number/);
  });
});

describe('epicLabel helper', () => {
  it('defines an epicLabel helper', () => {
    expect(read()).toContain('function epicLabel');
  });

  it('produces a "children" plural and "child" singular label', () => {
    const s = read();
    expect(s).toContain('children');
    expect(s).toContain("'child'");
  });

  it('uses an epic · N children template (middot separator)', () => {
    // The dot separator matches the preview row + config-chip aesthetic.
    expect(read()).toMatch(/epic\s*·/);
  });
});

describe('badge rendering — gated on epic === true', () => {
  it('only renders the pill when epic === true (non-epic rows untouched)', () => {
    expect(read()).toMatch(/c\.epic\s*===\s*true/);
  });

  it('renders the epic-pill element via the epicLabel helper', () => {
    const s = read();
    expect(s).toContain('class="epic-pill"');
    expect(s).toContain('epicLabel(c)');
  });
});

describe('v2 design tokens', () => {
  it('styles the pill with the --af-purple token, not a hard-coded colour', () => {
    const s = read();
    // The .epic-pill rule must exist and lean on the purple token via color-mix.
    expect(s).toMatch(/\.epic-pill\s*\{/);
    const block = s.slice(s.indexOf('.epic-pill {'));
    expect(block).toContain('--af-purple');
    expect(block).toContain('color-mix');
  });
});
