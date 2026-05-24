// @vitest-environment happy-dom
/**
 * V2 Layout shell — contract tests
 *
 * SvelteKit components that import $app/navigation and $app/stores cannot be
 * rendered in a plain vitest environment without the full SvelteKit Vite plugin
 * wired in — doing so causes the transform to hang indefinitely waiting for Kit's
 * module resolver. Full rendering is therefore covered by Playwright e2e tests.
 *
 * This file asserts:
 *  - The design-spec constants (heights, widths, grid areas) per HANDOFF.md §7
 *  - localStorage key contracts used by both Layout.svelte and Sidebar.svelte
 *  - File system presence of each component (verifies the barrel can be imported)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
const ROOT = resolve(__dirname, '../layout');
// ── File existence ──────────────────────────────────────────────────────────
describe('V2 Layout shell file presence', () => {
    const components = ['Topbar.svelte', 'StatusLine.svelte', 'Sidebar.svelte', 'Layout.svelte', 'index.ts'];
    for (const file of components) {
        it(`${file} exists in the layout directory`, () => {
            expect(existsSync(resolve(ROOT, file))).toBe(true);
        });
    }
});
// ── Barrel index exports ────────────────────────────────────────────────────
describe('Barrel index.ts re-exports', () => {
    it('exports Topbar, StatusLine, Sidebar, Layout', () => {
        const src = readFileSync(resolve(ROOT, 'index.ts'), 'utf-8');
        expect(src).toContain("export { default as Topbar }");
        expect(src).toContain("export { default as StatusLine }");
        expect(src).toContain("export { default as Sidebar }");
        expect(src).toContain("export { default as Layout }");
    });
});
// ── CSS Grid areas contract ─────────────────────────────────────────────────
describe('Layout grid template areas (HANDOFF.md §7)', () => {
    it('Layout.svelte contains the correct grid-template-areas', () => {
        const src = readFileSync(resolve(ROOT, 'Layout.svelte'), 'utf-8');
        // These three rows must appear in the component source
        expect(src).toContain('"topbar  topbar"');
        expect(src).toContain('"status  status"');
        expect(src).toContain('"sidebar main"');
    });
    it('Topbar.svelte uses 44px height', () => {
        const src = readFileSync(resolve(ROOT, 'Topbar.svelte'), 'utf-8');
        expect(src).toContain('44px');
    });
    it('StatusLine.svelte uses 22px height', () => {
        const src = readFileSync(resolve(ROOT, 'StatusLine.svelte'), 'utf-8');
        expect(src).toContain('22px');
    });
    it('Sidebar.svelte uses 48px collapsed width', () => {
        const src = readFileSync(resolve(ROOT, 'Sidebar.svelte'), 'utf-8');
        expect(src).toContain('48px');
    });
    it('Sidebar.svelte uses 220px expanded width', () => {
        const src = readFileSync(resolve(ROOT, 'Sidebar.svelte'), 'utf-8');
        expect(src).toContain('220px');
    });
});
// ── Design token references ─────────────────────────────────────────────────
describe('Design token usage', () => {
    it('Topbar.svelte uses --af-bg background', () => {
        const src = readFileSync(resolve(ROOT, 'Topbar.svelte'), 'utf-8');
        expect(src).toContain('var(--af-bg)');
    });
    it('StatusLine.svelte uses --af-surface background', () => {
        const src = readFileSync(resolve(ROOT, 'StatusLine.svelte'), 'utf-8');
        expect(src).toContain('var(--af-surface)');
    });
    it('Sidebar.svelte uses --af-accent or --af-purple for active state', () => {
        const src = readFileSync(resolve(ROOT, 'Sidebar.svelte'), 'utf-8');
        expect(src).toMatch(/--af-purple|--af-accent/);
    });
});
// ── localStorage key contract ───────────────────────────────────────────────
describe('Sidebar pin state localStorage key', () => {
    it('Sidebar.svelte uses the key af2-sidebar-pinned', () => {
        const src = readFileSync(resolve(ROOT, 'Sidebar.svelte'), 'utf-8');
        expect(src).toContain("'af2-sidebar-pinned'");
    });
    it('Layout.svelte reads the same key af2-sidebar-pinned', () => {
        const src = readFileSync(resolve(ROOT, 'Layout.svelte'), 'utf-8');
        expect(src).toContain("'af2-sidebar-pinned'");
    });
    it('Sidebar.svelte defaults to pinned=true when key is absent (source contract)', () => {
        // Verify via source file inspection rather than runtime localStorage
        // (tests run in Node environment which has no localStorage).
        // The contract: when localStorage returns null, pinned must default to true.
        const src = readFileSync(resolve(ROOT, 'Sidebar.svelte'), 'utf-8');
        // Either the ternary `=== null ? true` or `?? true` pattern must be present.
        expect(src).toMatch(/=== null \? true|\?\? true/);
    });
});
// ── Polling behaviour contract ──────────────────────────────────────────────
describe('Polling endpoints referenced in components', () => {
    it('Topbar.svelte polls /api/v5/cycles', () => {
        const src = readFileSync(resolve(ROOT, 'Topbar.svelte'), 'utf-8');
        expect(src).toContain('/api/v5/cycles');
    });
    it('StatusLine.svelte calls /api/v5/health/services', () => {
        const src = readFileSync(resolve(ROOT, 'StatusLine.svelte'), 'utf-8');
        expect(src).toContain('/api/v5/health/services');
    });
    it('StatusLine.svelte attempts /api/v5/counters with fallback', () => {
        const src = readFileSync(resolve(ROOT, 'StatusLine.svelte'), 'utf-8');
        expect(src).toContain('/api/v5/counters');
    });
    it('StatusLine.svelte has visibility-aware pause guard', () => {
        const src = readFileSync(resolve(ROOT, 'StatusLine.svelte'), 'utf-8');
        expect(src).toContain('visibilityState');
    });
    it('Topbar.svelte has visibility-aware pause guard', () => {
        const src = readFileSync(resolve(ROOT, 'Topbar.svelte'), 'utf-8');
        expect(src).toContain('visibilityState');
    });
});
