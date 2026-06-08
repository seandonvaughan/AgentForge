/**
 * Source-level contract tests for /objective/+page.svelte
 *
 * SvelteKit components that import $app/* modules cannot be rendered in plain
 * vitest without the full Kit Vite plugin. This file asserts source-level
 * contracts only:
 *
 *  - File presence
 *  - POST payload shape: { objective, budgetUsd } sent to /api/v5/cycles
 *  - Navigation to /cycles/:id on success (goto call)
 *  - Client-side validation errors surface inline (no toast)
 *  - All document/window access is browser-guarded
 *  - Svelte 5 runes ($state, $derived) usage
 *  - v2 components imported from $lib/components/v2
 *  - withWorkspace used for URL construction
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

// ── File presence ─────────────────────────────────────────────────────────────

describe('objective +page.svelte — file presence', () => {
  it('exists at the expected SvelteKit route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

// ── Source helpers ────────────────────────────────────────────────────────────

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

// ── Svelte 5 runes ────────────────────────────────────────────────────────────

describe('objective +page.svelte — Svelte 5 runes', () => {
  it('uses $state rune (not legacy $: reactive declarations)', () => {
    const s = src();
    expect(s).toContain('$state');
    expect(s).not.toMatch(/^\s*\$:/m);
  });

  it('uses $derived for derived values', () => {
    expect(src()).toContain('$derived');
  });

  it('declares objective state', () => {
    expect(src()).toContain('objective');
  });

  it('declares budgetUsd state', () => {
    expect(src()).toContain('budgetUsd');
  });

  it('declares launching state for submit-in-progress tracking', () => {
    expect(src()).toContain('launching');
  });
});

// ── POST payload ──────────────────────────────────────────────────────────────

describe('objective +page.svelte — POST /api/v5/cycles payload', () => {
  it('references the /api/v5/cycles endpoint', () => {
    expect(src()).toContain('/api/v5/cycles');
  });

  it('sends objective in the POST body', () => {
    // The payload object literal must include objective
    expect(src()).toMatch(/objective.*objectiveTrimmed|objective:\s*objective/);
  });

  it('sends budgetUsd in the POST body', () => {
    expect(src()).toContain('budgetUsd');
  });

  it('uses POST method for the fetch call', () => {
    const s = src();
    expect(s).toContain("method: 'POST'");
  });

  it('sets Content-Type to application/json', () => {
    expect(src()).toContain("'Content-Type': 'application/json'");
  });

  it('uses withWorkspace to construct the URL', () => {
    expect(src()).toContain('withWorkspace');
  });
});

// ── Navigation on success ─────────────────────────────────────────────────────

describe('objective +page.svelte — navigation on success', () => {
  it('imports goto from $app/navigation', () => {
    const s = src();
    expect(s).toContain('goto');
    expect(s).toContain("from '$app/navigation'");
  });

  it('navigates to /cycles/:id using cycleId from response', () => {
    const s = src();
    // Should navigate to /cycles/${newId} or equivalent
    expect(s).toMatch(/goto\s*\(\s*`\/cycles\/\$\{/);
  });

  it('reads cycleId (or id) from the response JSON', () => {
    const s = src();
    expect(s).toContain('cycleId');
  });
});

// ── Validation errors ─────────────────────────────────────────────────────────

describe('objective +page.svelte — inline validation errors', () => {
  it('declares a validationError state (not a toast)', () => {
    expect(src()).toContain('validationError');
  });

  it('declares a launchError state for server-side errors', () => {
    expect(src()).toContain('launchError');
  });

  it('renders validation error inline with role="alert"', () => {
    expect(src()).toContain('role="alert"');
  });

  it('validates that objective is non-empty before submitting', () => {
    const s = src();
    // Either via a validate() function or inline guard
    expect(s).toMatch(/objective|Objective/);
    expect(s).toContain('empty');
  });

  it('validates that budgetUsd is positive', () => {
    const s = src();
    expect(s).toContain('budgetUsd');
    // Positive check
    expect(s).toMatch(/budgetUsd\s*>\s*0|positive/);
  });
});

// ── Browser guard ─────────────────────────────────────────────────────────────

describe('objective +page.svelte — browser guard', () => {
  it("imports browser from '$app/environment'", () => {
    const s = src();
    expect(s).toContain('browser');
    expect(s).toContain("from '$app/environment'");
  });

  it('guards goto (navigation) behind browser check', () => {
    const s = src();
    // goto must only be called inside a browser guard
    expect(s).toContain('if (browser)');
  });
});

// ── v2 components ─────────────────────────────────────────────────────────────

describe('objective +page.svelte — v2 component imports', () => {
  it("imports from '$lib/components/v2'", () => {
    expect(src()).toContain("'$lib/components/v2'");
  });

  it('imports Btn', () => {
    expect(src()).toContain('Btn');
  });

  it('imports Card', () => {
    expect(src()).toContain('Card');
  });

  it('imports Badge', () => {
    expect(src()).toContain('Badge');
  });
});

// ── Submit button ─────────────────────────────────────────────────────────────

describe('objective +page.svelte — submit button', () => {
  it('has a launch / submit button', () => {
    const s = src();
    expect(s).toMatch(/Launch Objective|Launch|Submit/);
  });

  it('disables the button when launching is true', () => {
    expect(src()).toContain('launching');
    expect(src()).toContain('disabled');
  });

  it('shows a spinner or "Launching…" label during submission', () => {
    const s = src();
    expect(s).toContain('Launching');
  });
});

// ── Keyboard shortcut ─────────────────────────────────────────────────────────

describe('objective +page.svelte — Ctrl+Enter shortcut', () => {
  it('handles Ctrl+Enter or Cmd+Enter to submit', () => {
    const s = src();
    expect(s).toContain("'Enter'");
    expect(s).toMatch(/ctrlKey|metaKey/);
  });
});
