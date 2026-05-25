/**
 * Contract tests for the Topbar `Worktrees: N` pill.
 *
 * These are source-level tests that inspect the Svelte component's source
 * code to verify key behavioral contracts without requiring a full SvelteKit
 * runtime or JSDOM environment. The same pattern is used across the dashboard
 * test suite (see runner-page-server.test.ts).
 *
 * Contracts verified:
 *  1. The `runningWorktrees` state variable is declared.
 *  2. The pill renders only when `runningWorktrees > 0` (zero-state hidden).
 *  3. The pill click navigates to `/branches`.
 *  4. `fetchCounters` reads `runningWorktrees` from the API response.
 *  5. `document.*` calls are inside the `$effect` callback (browser-guarded).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOPBAR_PATH = resolve(
  './packages/dashboard/src/lib/components/v2/layout/Topbar.svelte',
);

const source = readFileSync(TOPBAR_PATH, 'utf8');

describe('Topbar — runningWorktrees state', () => {
  it('declares runningWorktrees as a $state variable', () => {
    expect(source).toContain('let runningWorktrees = $state(0)');
  });
});

describe('Topbar — Worktrees pill conditional rendering', () => {
  it('gates the worktrees pill on runningWorktrees > 0', () => {
    expect(source).toContain('{#if runningWorktrees > 0}');
  });

  it('hides the pill when runningWorktrees is 0 (condition is strictly > 0)', () => {
    // The condition must be > 0, not >= 0 or just truthy, so zero hides it
    expect(source).toMatch(/\{#if runningWorktrees > 0\}/);
  });
});

describe('Topbar — Worktrees pill navigation', () => {
  it('navigates to /branches on click', () => {
    expect(source).toContain("goto('/branches')");
  });
});

describe('Topbar — fetchCounters reads runningWorktrees from API', () => {
  it('reads runningWorktrees key from the API response', () => {
    expect(source).toContain("raw['runningWorktrees']");
  });

  it('fetches /api/v5/counters', () => {
    expect(source).toContain("fetch('/api/v5/counters')");
  });
});

describe('Topbar — fetchActiveCycle reads the v5 cycles response shape', () => {
  it('uses the cycles array returned by /api/v5/cycles', () => {
    expect(source).toContain('cycles: Array<{');
    expect(source).toContain('json.cycles?.find');
  });

  it('does not depend on the legacy data array for active cycle polling', () => {
    expect(source).not.toContain('json.data?.[0]');
  });
});

describe('Topbar — browser safety', () => {
  it('does not call document.* directly at the script top level', () => {
    // Split source on `<script` to isolate the script block
    const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const scriptBlock = scriptMatch![1];

    // Find all lines that directly reference `document.` (not inside a function
    // or $effect body). A direct top-level call would look like:
    //   document.addEventListener(...)
    // or
    //   const x = document.something
    // but NOT inside an indented function body or $effect.
    // We verify by checking that no line starting with `  document.` (2-space
    // indent = top-level script statement) exists.
    const lines = scriptBlock.split('\n');
    const topLevelDocLines = lines.filter((l) => /^  document\./.test(l));
    expect(topLevelDocLines).toHaveLength(0);
  });

  it('window.matchMedia is guarded with typeof window !== undefined', () => {
    expect(source).toContain("typeof window !== 'undefined'");
  });
});
