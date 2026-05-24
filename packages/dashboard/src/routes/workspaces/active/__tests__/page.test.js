/**
 * SSR contract tests for /workspaces/active (+page.svelte)
 *
 * SvelteKit Svelte components that import $app/* modules cannot be rendered
 * in plain vitest without the full Kit Vite plugin wired in — doing so causes
 * the transform to hang. Full rendering is therefore covered by Playwright e2e.
 *
 * This file instead asserts source-level contracts:
 *  - File presence and module exports
 *  - Polling endpoint references
 *  - Svelte 5 runes usage ($state, $effect)
 *  - Visibility-aware pause guard
 *  - Required UI element markers (empty-state, stats-bar, table)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const PAGE_PATH = resolve(__dirname, '../+page.svelte');
// ── File presence ─────────────────────────────────────────────────────────────
describe('+page.svelte file presence', () => {
    it('exists at the expected SvelteKit route path', () => {
        expect(existsSync(PAGE_PATH)).toBe(true);
    });
});
// ── Source contract helpers ───────────────────────────────────────────────────
let src;
describe('+page.svelte source contracts', () => {
    it('file can be read as UTF-8 without throwing', () => {
        src = readFileSync(PAGE_PATH, 'utf-8');
        expect(typeof src).toBe('string');
        expect(src.length).toBeGreaterThan(0);
    });
    // ── Svelte 5 runes ────────────────────────────────────────────────────────
    it('uses $state rune (Svelte 5 — not legacy reactive declarations)', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('$state');
        // Must NOT fall back to $: reactive declarations
        expect(s).not.toMatch(/^\s*\$:/m);
    });
    it('uses $effect rune for the polling lifecycle', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('$effect');
    });
    // ── Endpoint reference ────────────────────────────────────────────────────
    it('polls /api/v5/workspaces/active endpoint', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('/api/v5/workspaces/active');
    });
    // ── Visibility guard ──────────────────────────────────────────────────────
    it('has a visibilityState check to pause polling when hidden', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('visibilityState');
    });
    it('listens to visibilitychange event', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('visibilitychange');
    });
    // ── Required UI elements ──────────────────────────────────────────────────
    it('renders a stats-bar section with KpiTile components', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('stats-bar');
        expect(s).toContain('KpiTile');
    });
    it('renders a table with the expected column headers', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('Agent');
        expect(s).toContain('Branch');
        expect(s).toContain('Age');
        expect(s).toContain('Current Item');
        expect(s).toContain('Path');
    });
    it('has a friendly empty state message', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('No active worktrees');
        expect(s).toContain('agents will appear here when a cycle is running');
    });
    // ── 5s poll interval ──────────────────────────────────────────────────────
    it('uses a 5000 ms poll interval', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toMatch(/5000|POLL_MS\s*=\s*5000/);
    });
    // ── v2 component imports ──────────────────────────────────────────────────
    it('imports v2 components from $lib/components/v2', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain("'$lib/components/v2'");
    });
    it('imports PulseDot (live indicator)', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('PulseDot');
    });
    // ── Age formatter ─────────────────────────────────────────────────────────
    it('formats age as mm:ss (fmtAge function present)', () => {
        const s = readFileSync(PAGE_PATH, 'utf-8');
        expect(s).toContain('fmtAge');
        expect(s).toContain('padStart');
    });
});
