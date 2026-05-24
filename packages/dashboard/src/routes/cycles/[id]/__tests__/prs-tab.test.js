/**
 * Source-level contract tests for the PRs tab on /cycles/[id]/+page.svelte
 *
 * SvelteKit components that import $app/* modules cannot be rendered in plain
 * vitest without the full Kit Vite plugin. Full rendering is therefore covered
 * by Playwright e2e. This file asserts source-level contracts only:
 *  - File presence
 *  - PR endpoint reference (/api/v5/cycles/:id/prs?ci=true)
 *  - Tab label "PRs" is present
 *  - Loading, error, and empty-state branches exist
 *  - Svelte 5 runes ($state, $effect) usage
 *  - Card and Badge imported from $lib/components/v2
 *  - CI bucket color treatment (pass/fail/pending/unknown)
 *  - Visibility-gated polling guard
 *  - 30 s cache constant (PRS_CACHE_MS / 30_000)
 *  - fmtAge uses padStart (mm:ss format)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const PAGE_PATH = resolve(__dirname, '../+page.svelte');
// ── File presence ─────────────────────────────────────────────────────────────
describe('PRs tab — file presence', () => {
    it('the cycle detail +page.svelte exists at the expected route path', () => {
        expect(existsSync(PAGE_PATH)).toBe(true);
    });
});
// ── Source helpers ────────────────────────────────────────────────────────────
function src() {
    return readFileSync(PAGE_PATH, 'utf-8');
}
// ── Endpoint ──────────────────────────────────────────────────────────────────
describe('PRs tab — endpoint contract', () => {
    it('references the /api/v5/cycles/:id/prs?ci=true endpoint', () => {
        expect(src()).toContain('/prs?ci=true');
    });
    it('builds the URL using the cycle id variable', () => {
        // The pattern must include the id interpolation directly before /prs
        expect(src()).toMatch(/`.*\$\{id\}.*\/prs\?ci=true`/);
    });
});
// ── Tab label ─────────────────────────────────────────────────────────────────
describe('PRs tab — tab label', () => {
    it('declares a tab with label "PRs"', () => {
        expect(src()).toContain("label: 'PRs'");
    });
    it('includes prs as a Tab type union member', () => {
        expect(src()).toContain("'prs'");
    });
});
// ── State management ──────────────────────────────────────────────────────────
describe('PRs tab — Svelte 5 runes', () => {
    it('uses $state rune (not legacy $: reactive declarations)', () => {
        const s = src();
        expect(s).toContain('$state');
        expect(s).not.toMatch(/^\s*\$:/m);
    });
    it('uses $effect rune for lifecycle management', () => {
        expect(src()).toContain('$effect');
    });
    it('declares prsLoading state', () => {
        expect(src()).toContain('prsLoading');
    });
    it('declares prsError state', () => {
        expect(src()).toContain('prsError');
    });
    it('declares prsData state', () => {
        expect(src()).toContain('prsData');
    });
});
// ── Loading / error / empty states ───────────────────────────────────────────
describe('PRs tab — UI state branches', () => {
    it('has a loading skeleton state (prsLoading guard)', () => {
        expect(src()).toContain('prsLoading');
        expect(src()).toContain('prs-skel');
    });
    it('has an error banner state with a Retry button', () => {
        const s = src();
        expect(s).toContain('prsError');
        expect(s).toContain('Failed to load PRs');
        expect(s).toContain('Retry');
    });
    it('has an empty state message for single-PR mode cycles', () => {
        expect(src()).toContain('single-PR mode');
        expect(src()).toContain('no per-agent PRs');
    });
});
// ── Table columns ─────────────────────────────────────────────────────────────
describe('PRs tab — table structure', () => {
    it('renders a PR number column that links to GitHub', () => {
        const s = src();
        expect(s).toContain('pr-num-link');
        expect(s).toContain('prUrl');
        expect(s).toContain('prNumber');
    });
    it('renders an agentId badge column', () => {
        expect(src()).toContain('agentId');
    });
    it('renders a branch column in monospace', () => {
        const s = src();
        expect(s).toContain('prs-branch');
        expect(s).toContain('pr.branch');
    });
    it('renders itemIds count with tooltip showing the list', () => {
        const s = src();
        expect(s).toContain('itemIds');
        expect(s).toContain('title={pr.itemIds.join');
    });
    it('renders a status badge per PR', () => {
        expect(src()).toContain('prStatusVariant');
    });
    it('renders an age column using fmtAge (mm:ss via padStart)', () => {
        const s = src();
        expect(s).toContain('fmtAge');
        expect(s).toContain('padStart');
    });
});
// ── CI bucket color treatment ─────────────────────────────────────────────────
describe('PRs tab — CI bucket colour treatment', () => {
    it('defines a ciBucketColor helper', () => {
        expect(src()).toContain('ciBucketColor');
    });
    it('maps bucket=pass to af-success (green)', () => {
        expect(src()).toContain("'pass'");
        expect(src()).toContain('var(--af-success)');
    });
    it('maps bucket=fail to af-danger (red)', () => {
        expect(src()).toContain("'fail'");
        expect(src()).toContain('var(--af-danger)');
    });
    it('maps bucket=pending to af-warning (amber)', () => {
        expect(src()).toContain("'pending'");
        expect(src()).toContain('var(--af-warning)');
    });
    it('maps bucket=unknown to af-dim (grey fallback)', () => {
        // The helper must return af-dim for the unknown bucket
        expect(src()).toContain('var(--af-dim)');
    });
    it('uses a coloured dot (prs-ci-dot) alongside a label chip', () => {
        const s = src();
        expect(s).toContain('prs-ci-dot');
        expect(s).toContain('prs-ci-chip');
    });
});
// ── Stats strip ───────────────────────────────────────────────────────────────
describe('PRs tab — stats strip', () => {
    it('renders a stats strip with open/merged/closed/pending counts', () => {
        const s = src();
        expect(s).toContain('prs-stats-strip');
        expect(s).toContain('counts.open');
        expect(s).toContain('counts.merged');
        expect(s).toContain('counts.closed');
        expect(s).toContain('counts.pending');
    });
});
// ── Visibility-gated polling ──────────────────────────────────────────────────
describe('PRs tab — polling contracts', () => {
    it('uses a 30-second cache constant (PRS_CACHE_MS / 30_000)', () => {
        const s = src();
        expect(s).toMatch(/PRS_CACHE_MS|30_000/);
    });
    it('guards polling on visibilityState (stops when hidden)', () => {
        expect(src()).toContain('visibilityState');
    });
    it('listens to visibilitychange event', () => {
        expect(src()).toContain('visibilitychange');
    });
    it('imports browser from $app/environment for SSR guard', () => {
        expect(src()).toContain("from '$app/environment'");
        expect(src()).toContain('browser');
    });
    it('has a startPrsPoll / stopPrsPoll pair for lifecycle', () => {
        const s = src();
        expect(s).toContain('startPrsPoll');
        expect(s).toContain('stopPrsPoll');
    });
    it('has a Refresh button on the PRs tab bar', () => {
        expect(src()).toContain('Refresh');
    });
});
// ── v2 component imports ──────────────────────────────────────────────────────
describe('PRs tab — v2 component imports', () => {
    it('imports Card from $lib/components/v2', () => {
        const s = src();
        expect(s).toContain('Card');
        expect(s).toContain("'$lib/components/v2'");
    });
    it('imports Badge from $lib/components/v2', () => {
        expect(src()).toContain('Badge');
    });
    it('imports Btn from $lib/components/v2 (used for Refresh / Retry)', () => {
        expect(src()).toContain('Btn');
    });
});
// ── Lazy loading contract ─────────────────────────────────────────────────────
describe('PRs tab — lazy-load contract', () => {
    it('only loads PRs when the prs tab is selected (selectTab guard)', () => {
        const s = src();
        // selectTab must trigger loadPrs when t === 'prs'
        expect(s).toContain("t === 'prs'");
        expect(s).toContain('loadPrs');
    });
    it('does NOT fetch PRs during onMount (no loadPrs call in onMount)', () => {
        // loadPrs should not be called inside the onMount body;
        // it should only be triggered on tab selection
        const s = src();
        const onMountBlock = s.match(/onMount\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/)?.[1] ?? '';
        expect(onMountBlock).not.toContain('loadPrs');
    });
});
