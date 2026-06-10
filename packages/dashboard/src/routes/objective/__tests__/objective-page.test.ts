/**
 * Source-level contract tests for /objective (+page.svelte).
 *
 * SvelteKit Svelte components that import $app/* modules cannot be rendered
 * in plain vitest without the full Kit Vite plugin — hanging transforms make
 * component mounting infeasible here. Full rendering is covered by Playwright e2e.
 *
 * This file asserts source-level contracts:
 *  - File presence at the expected SvelteKit route path
 *  - Svelte 5 runes usage ($state, $derived)
 *  - Inline validation logic (non-empty objective, positive finite budget)
 *  - createObjectiveCycle import from $lib/api/epic.ts
 *  - goto call on success
 *  - browser guard from $app/environment
 *  - Error banner presence
 *  - Submit button disabled state wiring
 *  - v2 component imports (Btn, Card)
 *  - POST payload shape inferred from createObjectiveCycle call
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

// ── File presence ─────────────────────────────────────────────────────────────

describe('+page.svelte file presence', () => {
  it('exists at the expected SvelteKit route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

// ── Source helpers ────────────────────────────────────────────────────────────

let src: string;

function read(): string {
  if (!src) src = readFileSync(PAGE_PATH, 'utf-8');
  return src;
}

// ── Svelte 5 runes ────────────────────────────────────────────────────────────

describe('Svelte 5 runes', () => {
  it('uses $state rune', () => {
    expect(read()).toContain('$state');
  });

  it('uses $derived for computed validation', () => {
    expect(read()).toContain('$derived');
  });

  it('does NOT use legacy $: reactive declarations', () => {
    expect(read()).not.toMatch(/^\s*\$:/m);
  });
});

// ── API integration ───────────────────────────────────────────────────────────

describe('API integration', () => {
  it('imports createObjectiveCycle from $lib/api/epic', () => {
    const s = read();
    // Either the .js extension (NodeNext) or .ts import form is acceptable.
    expect(s).toMatch(/createObjectiveCycle/);
    expect(s).toMatch(/\$lib\/api\/epic/);
  });

  it('calls createObjectiveCycle with objective and budgetUsd fields', () => {
    const s = read();
    // The call must pass both fields so the POST body matches the server contract.
    expect(s).toContain('objective');
    expect(s).toContain('budgetUsd');
    expect(s).toContain('createObjectiveCycle');
  });

  it('navigates to /cycles/:id after successful creation', () => {
    const s = read();
    expect(s).toContain('goto');
    expect(s).toContain('/cycles/');
    // Must use the returned id from createObjectiveCycle.
    expect(s).toContain('created.id');
  });

  it('imports goto from $app/navigation', () => {
    expect(read()).toContain("'$app/navigation'");
    expect(read()).toContain('goto');
  });
});

// ── browser guard ─────────────────────────────────────────────────────────────

describe('browser guard', () => {
  it('imports browser from $app/environment', () => {
    expect(read()).toContain("'$app/environment'");
    expect(read()).toContain('browser');
  });

  it('wraps goto call with a browser guard to prevent SSR errors', () => {
    const s = read();
    // Both `browser` and `goto` must appear in the same vicinity.
    const browserIdx = s.indexOf('browser');
    const gotoIdx = s.indexOf('goto');
    expect(browserIdx).toBeGreaterThan(-1);
    expect(gotoIdx).toBeGreaterThan(-1);
    // They should be within 200 characters of each other (same block).
    expect(Math.abs(gotoIdx - browserIdx)).toBeLessThan(200);
  });
});

// ── Inline validation ─────────────────────────────────────────────────────────

describe('inline validation', () => {
  it('validates that objective is non-empty', () => {
    const s = read();
    // The page must check that the objective is non-empty.
    expect(s).toContain('objective');
    // Validation error message present somewhere in the source.
    expect(s).toMatch(/required|non-empty|empty/i);
  });

  it('validates that budgetUsd is a positive finite number', () => {
    const s = read();
    // Must check positivity — either via budgetUsd > 0 or Number.isFinite.
    expect(s).toMatch(/budgetUsd\s*>\s*0|Number\.isFinite/);
  });

  it('guards submission when formValid is false', () => {
    // formValid (or equivalent) must gate the submit handler.
    expect(read()).toContain('formValid');
  });

  it('marks fields as touched on blur to reveal validation errors', () => {
    const s = read();
    expect(s).toContain('Touched');
    expect(s).toContain('onblur');
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('has a submitError state variable', () => {
    expect(read()).toContain('submitError');
  });

  it('renders an error banner when submitError is set', () => {
    const s = read();
    expect(s).toContain('submitError');
    // Must use a danger-class banner (not just a toast).
    expect(s).toContain('banner--danger');
  });

  it('resets submitting to false on error', () => {
    const s = read();
    // submitting must be set back to false in the catch block.
    const catchIdx = s.indexOf('catch');
    expect(catchIdx).toBeGreaterThan(-1);
    const afterCatch = s.slice(catchIdx, catchIdx + 200);
    expect(afterCatch).toContain('submitting = false');
  });
});

// ── Submit button ─────────────────────────────────────────────────────────────

describe('submit button', () => {
  it('disables the submit button when submitting', () => {
    const s = read();
    expect(s).toContain('submitting');
    // The Btn component must receive a disabled prop that includes submitting.
    expect(s).toContain('disabled={submitting}');
  });

  it('supports Ctrl+Enter keyboard shortcut to submit', () => {
    const s = read();
    expect(s).toContain('ctrlKey');
    expect(s).toContain("'Enter'");
  });
});

// ── v2 component imports ──────────────────────────────────────────────────────

describe('v2 design system', () => {
  it("imports v2 components from '$lib/components/v2'", () => {
    expect(read()).toContain("'$lib/components/v2'");
  });

  it('uses Btn component for the submit button', () => {
    expect(read()).toContain('Btn');
  });

  it('uses Card component for layout', () => {
    expect(read()).toContain('Card');
  });
});

// ── createObjectiveCycle contract (unit) ──────────────────────────────────────

describe('createObjectiveCycle POST payload contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs to /api/v5/cycles with objective and budgetUsd', async () => {
    // Import the real function and verify it sends the correct payload shape.
    // This catches regressions where the field names are renamed on one side only.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ id: 'cycle-test-001', status: 'pending', budgetUsd: 50 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Use relative path — $lib alias is not resolved in plain vitest dynamic imports.
    const { createObjectiveCycle } = await import('../../../lib/api/epic.js');
    const result = await createObjectiveCycle({
      objective: 'Add OAuth2 support',
      budgetUsd: 50,
    });

    expect(result.id).toBe('cycle-test-001');

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v5/cycles');
    expect((options as RequestInit).method).toBe('POST');

    const body = JSON.parse((options as RequestInit).body as string) as Record<string, unknown>;
    expect(body['objective']).toBe('Add OAuth2 support');
    expect(body['budgetUsd']).toBe(50);
  });

  it('throws when the server returns a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Invalid objective' }),
    }));

    // Use relative path — $lib alias is not resolved in plain vitest dynamic imports.
    const { createObjectiveCycle } = await import('../../../lib/api/epic.js');
    await expect(
      createObjectiveCycle({ objective: '', budgetUsd: 0 }),
    ).rejects.toThrow('Invalid objective');
  });
});
