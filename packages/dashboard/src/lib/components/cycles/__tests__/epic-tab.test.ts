/**
 * Source-level contract tests for EpicTab.svelte
 *
 * Full DOM rendering requires the SvelteKit Vite plugin (which transforms
 * $lib/* path aliases and Svelte runes). These tests instead verify the
 * source-code contracts: prop shapes, API imports, wave rendering logic,
 * empty/null states, and design-token usage — all things that break visibly
 * if the implementation drifts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const COMPONENT_PATH = resolve(import.meta.dirname, '../EpicTab.svelte');
const source = readFileSync(COMPONENT_PATH, 'utf8');

// ── File presence ─────────────────────────────────────────────────────────────

describe('EpicTab file', () => {
  it('exists and is non-empty', () => {
    expect(source.length).toBeGreaterThan(0);
  });
});

// ── Props contract ────────────────────────────────────────────────────────────

describe('EpicTab props', () => {
  it('declares cycleId as a required string prop', () => {
    expect(source).toContain('cycleId: string');
  });

  it('declares itemResults as an optional Record prop', () => {
    expect(source).toContain('itemResults?');
    expect(source).toContain('Record<string, ItemResult>');
  });

  it('accepts an optional class override prop', () => {
    expect(source).toContain('class?: string');
    expect(source).toContain('class: className');
  });

  it('uses $props() rune', () => {
    expect(source).toContain('$props()');
  });

  it('exports ItemResult interface so consumers can type their prop', () => {
    expect(source).toContain('export interface ItemResult');
  });
});

// ── API & utility imports ─────────────────────────────────────────────────────

describe('EpicTab API integration', () => {
  it('imports getDecomposition from the epic API module', () => {
    expect(source).toContain("from '$lib/api/epic.js'");
    expect(source).toContain('getDecomposition');
  });

  it('imports the Decomposition type', () => {
    expect(source).toContain('type Decomposition');
  });

  it('imports DecompositionChild type', () => {
    expect(source).toContain('DecompositionChild');
  });

  it('imports groupIntoWaves from the epic-waves utility', () => {
    expect(source).toContain("from '$lib/util/epic-waves.js'");
    expect(source).toContain('groupIntoWaves');
  });

  it('calls getDecomposition with the cycleId', () => {
    expect(source).toContain('getDecomposition(id)');
  });

  it('uses $effect to re-fetch when cycleId changes', () => {
    expect(source).toContain('$effect(');
  });

  it('captures cycleId as a local const to stabilise the async closure', () => {
    expect(source).toContain('const id = cycleId');
  });
});

// ── SSR / browser safety ──────────────────────────────────────────────────────

describe('EpicTab browser safety', () => {
  it('imports browser from $app/environment', () => {
    expect(source).toContain("from '$app/environment'");
    expect(source).toContain('browser');
  });

  it('guards the fetch with a browser check inside the effect', () => {
    expect(source).toContain('if (!browser)');
  });
});

// ── State initialisation ──────────────────────────────────────────────────────

describe('EpicTab state initialisation', () => {
  it('initialises decomposition with an explicit null', () => {
    // Guards against $state<T>() without initialiser which widens to never
    expect(source).toMatch(/\$state<Decomposition \| null>\(null\)/);
  });

  it('initialises fetchError with an explicit null', () => {
    expect(source).toMatch(/\$state<string \| null>\(null\)/);
  });

  it('resets decomposition to null before each fetch to avoid stale data', () => {
    expect(source).toContain('decomposition = null');
  });
});

// ── Wave rendering ────────────────────────────────────────────────────────────

describe('EpicTab wave rendering', () => {
  it('derives waves using groupIntoWaves', () => {
    expect(source).toContain('groupIntoWaves(decomposition.children)');
  });

  it('uses $derived.by for the waves computation', () => {
    expect(source).toContain('$derived.by');
  });

  it('renders wave groups with {#each waves as wave', () => {
    expect(source).toContain('{#each waves as wave');
  });

  it('renders child cards with {#each wave as child', () => {
    expect(source).toContain('{#each wave as child');
  });

  it('shows child item id (truncated)', () => {
    // slice ensures only first 12 chars of the id are shown
    expect(source).toContain('child.id.slice(0, 12)');
  });

  it('renders the child title', () => {
    expect(source).toContain('child.title');
  });

  it('renders the estimated cost', () => {
    expect(source).toContain('child.estimatedCostUsd');
  });

  it('renders declared files with {#each child.files', () => {
    expect(source).toContain('{#each child.files');
  });

  it('caps displayed files and shows a "+N more" overflow hint', () => {
    expect(source).toContain('MAX_FILES_VISIBLE');
    expect(source).toContain('more');
  });
});

// ── Live status / cost from itemResults ───────────────────────────────────────

describe('EpicTab itemResults join', () => {
  it('looks up the result for each child from itemResults', () => {
    expect(source).toContain('itemResults[child.id]');
  });

  it('falls back to "pending" when no result is found', () => {
    expect(source).toContain("?? 'pending'");
  });

  it('renders the live cost when available', () => {
    expect(source).toContain('liveCost');
  });

  it('renders the live status', () => {
    expect(source).toContain('liveStatus');
  });
});

// ── Empty / null / error states ───────────────────────────────────────────────

describe('EpicTab empty and error states', () => {
  it('shows a no-decomposition notice when decomposition is null', () => {
    expect(source).toContain('No decomposition found for this cycle.');
  });

  it('shows a loading skeleton while fetching', () => {
    expect(source).toContain('{#if loading}');
    expect(source).toContain('skel');
  });

  it('shows an error message on fetch failure', () => {
    expect(source).toContain('fetchError');
    expect(source).toContain('Could not load decomposition');
  });

  it('shows an empty-decomposition notice when waves is empty', () => {
    expect(source).toContain('waves.length === 0');
  });
});

// ── Status colour mapping ─────────────────────────────────────────────────────

describe('EpicTab status colour tokens', () => {
  it('maps completed to --af-success', () => {
    expect(source).toContain('--af-success');
  });

  it('maps failed/killed/crashed to --af-danger', () => {
    expect(source).toContain('--af-danger');
  });

  it('maps in_progress to --af-purple', () => {
    expect(source).toContain('--af-purple');
  });

  it('uses statusColor() helper — no bare regex on status strings', () => {
    expect(source).toContain('statusColor(');
    // Regex on user-controlled strings is a CodeQL ReDoS risk
    expect(source).not.toMatch(/status\.match\s*\(/);
    expect(source).not.toMatch(/status\.replace\s*\(.*\.\*/);
  });
});

// ── fmtUsd helper — no regex on user-controlled values ───────────────────────

describe('EpicTab fmtUsd helper', () => {
  it('uses toFixed for formatting, not a regex', () => {
    expect(source).toContain('toFixed(');
    expect(source).not.toMatch(/v\.replace\s*\(/);
    expect(source).not.toMatch(/v\.match\s*\(/);
  });
});

// ── Design-system tokens ──────────────────────────────────────────────────────

describe('EpicTab design tokens', () => {
  it('uses --af-surface for card backgrounds', () => {
    expect(source).toContain('--af-surface');
  });

  it('uses --af-border for card borders', () => {
    expect(source).toContain('--af-border');
  });

  it('uses --af-text-muted for muted labels', () => {
    expect(source).toContain('--af-text-muted');
  });

  it('applies af2-mono class for monospace elements', () => {
    expect(source).toContain('af2-mono');
  });
});
