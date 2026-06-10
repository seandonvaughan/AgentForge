/**
 * Source-level contract tests for EpicReviewCard.svelte
 *
 * Full DOM rendering requires the SvelteKit Vite plugin (which transforms
 * $lib/* path aliases and Svelte runes). These tests instead verify the
 * source-code contracts: prop shapes, API import, truncation logic, verdict
 * colour mapping, and 404/no-render behaviour — all things that break visibly
 * if the implementation drifts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const COMPONENT_PATH = resolve(import.meta.dirname, '../EpicReviewCard.svelte');
const source = readFileSync(COMPONENT_PATH, 'utf8');

// ── File presence ─────────────────────────────────────────────────────────────

describe('EpicReviewCard file', () => {
  it('exists and is non-empty', () => {
    expect(source.length).toBeGreaterThan(0);
  });
});

// ── Props contract ────────────────────────────────────────────────────────────

describe('EpicReviewCard props', () => {
  it('declares cycleId as a required string prop', () => {
    expect(source).toContain('cycleId: string');
  });

  it('accepts an optional class override prop', () => {
    // Both "class?: string" and destructuring "class: className" must be present
    expect(source).toContain('class?: string');
    expect(source).toContain('class: className');
  });

  it('uses $props() rune', () => {
    expect(source).toContain('$props()');
  });
});

// ── API integration ───────────────────────────────────────────────────────────

describe('EpicReviewCard API integration', () => {
  it('imports getEpicReview from the epic API module', () => {
    expect(source).toContain("from '$lib/api/epic.js'");
    expect(source).toContain('getEpicReview');
  });

  it('calls getEpicReview with the cycleId', () => {
    expect(source).toContain('getEpicReview(id)');
  });

  it('uses $effect to re-fetch when cycleId changes', () => {
    expect(source).toContain('$effect(');
  });

  it('captures cycleId as a local const to stabilise the async closure', () => {
    expect(source).toContain('const id = cycleId');
  });
});

// ── 404 / null-render contract ────────────────────────────────────────────────

describe('EpicReviewCard null-render on 404', () => {
  it('initialises review state with an explicit null (not missing initialiser)', () => {
    // Guards against the $state<T>() without initialiser pitfall that widens to never
    expect(source).toMatch(/\$state<EpicReview \| null>\(null\)/);
  });

  it('renders nothing when review is null (top-level {#if review !== null})', () => {
    expect(source).toContain('{#if review !== null}');
  });

  it('resets review to null before each fetch so stale data is not displayed', () => {
    // The effect must set review = null before calling getEpicReview
    expect(source).toContain('review = null');
  });
});

// ── Rationale truncation (String.slice only, no regex) ────────────────────────

describe('EpicReviewCard rationale truncation', () => {
  it('uses String.slice to truncate rationale at 200 chars', () => {
    expect(source).toContain('.slice(0, 200)');
  });

  it('does not use a regex for the truncation', () => {
    // Regex on user-controlled input triggers CodeQL ReDoS warnings
    expect(source).not.toMatch(/rationale\.replace\s*\(/);
    expect(source).not.toMatch(/rationale\.match\s*\(/);
  });

  it('appends an ellipsis character after the slice', () => {
    // Must contain the actual ellipsis char or HTML entity adjacent to slice
    expect(source).toMatch(/slice\(0, 200\).*['"`…]/s);
  });
});

// ── Verdict colour mapping ────────────────────────────────────────────────────

describe('EpicReviewCard verdict colour tokens', () => {
  it('maps pass verdict to --af-success', () => {
    expect(source).toContain('--af-success');
  });

  it('maps fail verdict to --af-danger', () => {
    expect(source).toContain('--af-danger');
  });

  it('maps warn verdict to --af-warning', () => {
    expect(source).toContain('--af-warning');
  });

  it('uses color-mix() alpha helper for pill background', () => {
    expect(source).toContain('color-mix(in srgb,');
  });
});

// ── Faulted items chips ───────────────────────────────────────────────────────

describe('EpicReviewCard faulted items chips', () => {
  it('only renders faulted-items section when faultedItems is present and non-empty', () => {
    // Guard: {#if review.faultedItems && review.faultedItems.length > 0}
    expect(source).toContain('review.faultedItems');
    expect(source).toContain('faultedItems.length > 0');
  });

  it('iterates over faultedItems with {#each}', () => {
    expect(source).toContain('{#each review.faultedItems');
  });

  it('renders each faulted item as a chip', () => {
    expect(source).toContain('item-chip');
  });
});

// ── Design-system token usage ─────────────────────────────────────────────────

describe('EpicReviewCard design tokens', () => {
  it('uses --af-surface for the card background', () => {
    expect(source).toContain('--af-surface');
  });

  it('uses --af-border for the card border', () => {
    expect(source).toContain('--af-border');
  });

  it('uses --af-text-muted for the card label', () => {
    expect(source).toContain('--af-text-muted');
  });

  it('applies af2-mono class for monospace elements', () => {
    expect(source).toContain('af2-mono');
  });
});
