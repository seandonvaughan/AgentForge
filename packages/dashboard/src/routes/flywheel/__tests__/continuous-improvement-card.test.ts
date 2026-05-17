/**
 * Source-level contract tests for the Continuous Improvement card added to
 * packages/dashboard/src/routes/flywheel/+page.svelte.
 *
 * SvelteKit Svelte components that import $app/* cannot be rendered in plain
 * vitest — the transform hangs without the full Kit Vite plugin.  Full
 * rendering is covered by Playwright e2e.  These tests assert source-level
 * contracts that pin the behaviour we care about:
 *
 *   1. Endpoint reference — the page fetches from the correct URL
 *   2. Svelte 5 runes — $state and $effect used (not legacy reactive $:)
 *   3. Empty-state / error-state branches exist in the template
 *   4. v2 component atoms imported (Card, Sparkline)
 *   5. 30 s poll interval
 *   6. Visibility-gated polling
 *   7. 404 resilience — treated as empty state, not an error
 *   8. Trend-chip variants — all four chip values present in source
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

// ── File presence ─────────────────────────────────────────────────────────────

describe('Continuous Improvement — file presence', () => {
  it('+page.svelte exists at the expected route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

// ── Source text helper ────────────────────────────────────────────────────────

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

// ── 1. Endpoint reference ─────────────────────────────────────────────────────

describe('Continuous Improvement — endpoint reference', () => {
  it('fetches from /api/v5/flywheel/continuous-improvement', () => {
    expect(src()).toContain('/api/v5/flywheel/continuous-improvement');
  });

  it('stores the endpoint in a named constant CI_ENDPOINT', () => {
    expect(src()).toContain('CI_ENDPOINT');
    expect(src()).toContain("'/api/v5/flywheel/continuous-improvement'");
  });
});

// ── 2. Svelte 5 runes ─────────────────────────────────────────────────────────

describe('Continuous Improvement — Svelte 5 runes', () => {
  it('uses $state rune for CI loading state', () => {
    expect(src()).toContain('ciLoading');
    expect(src()).toContain('$state');
  });

  it('uses $effect rune for CI polling lifecycle', () => {
    expect(src()).toContain('$effect');
  });

  it('does NOT use legacy $: reactive declarations', () => {
    expect(src()).not.toMatch(/^\s*\$:/m);
  });

  it('uses $derived for ciSparklineData and ciPct', () => {
    const s = src();
    expect(s).toContain('ciSparklineData');
    expect(s).toContain('ciPct');
    expect(s).toContain('$derived');
  });
});

// ── 3. Empty-state / error-state branches ────────────────────────────────────

describe('Continuous Improvement — template branches', () => {
  it('has an empty-state message about running a cycle', () => {
    const s = src();
    expect(s).toContain('No continuous-improvement data yet');
    expect(s).toContain('run a cycle to start tracking');
  });

  it('has an error-state inline banner referencing ciError', () => {
    const s = src();
    expect(s).toContain('ciError');
    expect(s).toContain('continuous-improvement data');
  });

  it('has a skeleton loading state while ciLoading is true', () => {
    const s = src();
    expect(s).toContain('ciLoading');
    expect(s).toContain('ci-skeleton');
  });
});

// ── 4. v2 component atoms ─────────────────────────────────────────────────────

describe('Continuous Improvement — v2 component atoms', () => {
  it('imports Card from $lib/components/v2', () => {
    const s = src();
    expect(s).toContain('Card');
    expect(s).toContain("'$lib/components/v2'");
  });

  it('imports Sparkline from $lib/components/v2', () => {
    const s = src();
    expect(s).toContain('Sparkline');
  });

  it('uses Sparkline component in CI card template', () => {
    const s = src();
    expect(s).toContain('ciSparklineData');
    // Sparkline receives data= prop bound to ciSparklineData
    expect(s).toContain('data={ciSparklineData}');
  });
});

// ── 5. Poll interval ──────────────────────────────────────────────────────────

describe('Continuous Improvement — 30 s poll interval', () => {
  it('defines CI_POLL_MS constant at 30000 ms', () => {
    const s = src();
    expect(s).toContain('CI_POLL_MS');
    expect(s).toMatch(/CI_POLL_MS\s*=\s*30_?000/);
  });

  it('uses CI_POLL_MS in setInterval call', () => {
    const s = src();
    expect(s).toContain('CI_POLL_MS');
    expect(s).toContain('setInterval');
  });
});

// ── 6. Visibility-gated polling ───────────────────────────────────────────────

describe('Continuous Improvement — visibility-gated polling', () => {
  it('checks document.visibilityState before polling', () => {
    expect(src()).toContain('visibilityState');
  });

  it('listens to the visibilitychange DOM event', () => {
    expect(src()).toContain('visibilitychange');
  });

  it('uses browser guard from $app/environment', () => {
    const s = src();
    expect(s).toContain("from '$app/environment'");
    expect(s).toContain('browser');
  });
});

// ── 7. 404 resilience ────────────────────────────────────────────────────────

describe('Continuous Improvement — 404 resilience', () => {
  it('handles 404 response from the endpoint without throwing an error', () => {
    // The loadCi function must check res.status === 404 and treat it as
    // empty data rather than setting ciError.
    const s = src();
    expect(s).toContain('404');
    // Empty state path taken on 404 (ciPayload set to null, not ciError)
    expect(s).toMatch(/status.*404|404.*status/);
  });
});

// ── 8. Trend-chip variants ────────────────────────────────────────────────────

describe('Continuous Improvement — trend-chip visual treatment', () => {
  it('has a improving trend chip with --af-success color', () => {
    const s = src();
    expect(s).toContain('improving');
    expect(s).toContain('var(--af-success)');
  });

  it('has a flat trend chip with --af-dim (muted) color', () => {
    const s = src();
    expect(s).toContain('flat');
    expect(s).toContain('var(--af-dim)');
  });

  it('has a regressing trend chip with --af-danger color', () => {
    const s = src();
    expect(s).toContain('regressing');
    expect(s).toContain('var(--af-danger)');
  });

  it('has an insufficient-data chip with --af-faint (grey) color', () => {
    const s = src();
    expect(s).toContain('insufficient-data');
    expect(s).toContain('var(--af-faint)');
  });

  it('renders the ci-trend-chip span element for the chip', () => {
    const s = src();
    expect(s).toContain('ci-trend-chip');
  });

  it('displays the trend value in the chip (ciTrend variable used)', () => {
    const s = src();
    expect(s).toContain('ciTrend');
  });
});

// ── 9. "Last N cycles" label ─────────────────────────────────────────────────

describe('Continuous Improvement — last N cycles label', () => {
  it('shows a "Last N cycles" label below the sparkline', () => {
    const s = src();
    expect(s).toContain('Last');
    expect(s).toContain('cycle');
    expect(s).toContain('ciPayload.data.length');
  });
});
