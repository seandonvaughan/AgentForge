/**
 * Source-level contract tests for /objective.
 *
 * SvelteKit pages importing $app/* are covered here with source contracts,
 * matching the nearby route tests that avoid plain Vitest component rendering.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('/objective page file', () => {
  it('exists at the route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

describe('/objective submit contract', () => {
  it('defines createObjectiveCycle and posts objective cycles to /api/v5/cycles', () => {
    const s = src();
    expect(s).toContain('async function createObjectiveCycle');
    expect(s).toContain("withWorkspace('/api/v5/cycles')");
    expect(s).toContain("method: 'POST'");
    expect(s).toContain("'Content-Type': 'application/json'");
    expect(s).toContain('objective: input.objective');
    expect(s).toContain('budgetUsd: input.budgetUsd');
  });

  it('submits via the form handler and prevents native navigation', () => {
    const s = src();
    expect(s).toContain('onsubmit={handleSubmit}');
    expect(s).toContain('event.preventDefault()');
    expect(s).toContain('createObjectiveCycle({');
  });
});

describe('/objective validation contract', () => {
  it('requires non-empty objective text before submission', () => {
    const s = src();
    expect(s).toContain('objective.trim()');
    expect(s).toContain('Enter an objective before launching a cycle.');
  });

  it('requires a positive USD budget', () => {
    const s = src();
    expect(s).toContain('budgetUsd <= 0');
    expect(s).toContain('Budget must be a positive USD amount.');
    expect(s).toContain('disabled={!canSubmit}');
  });
});

describe('/objective navigation contract', () => {
  it('navigates to the created cycle detail page after success', () => {
    const s = src();
    expect(s).toContain("import { goto } from '$app/navigation'");
    expect(s).toMatch(/goto\(`\/cycles\/\$\{created\.cycleId\}`\)/);
  });

  it('handles both cycleId and id response shapes', () => {
    const s = src();
    expect(s).toContain('json.cycleId ?? json.id');
    expect(s).toContain('Server did not return a cycleId');
  });
});

describe('/objective budget band contract', () => {
  it('computes the C20 spendable budget band using the core formula', () => {
    const s = src();
    expect(s).toContain('function computeBudgetBand');
    expect(s).toContain('Math.max(0, (Number.isFinite(value) ? value - 6 : 0) / 1.2)');
    expect(s).toContain('lowerUsd: spendableUsd * 0.7');
    expect(s).toContain('upperUsd: spendableUsd');
  });

  it('renders helper text describing the computed budget band', () => {
    const s = src();
    expect(s).toContain('budgetBandText');
    expect(s).toContain('Planner child estimates should total');
    expect(s).toContain('70%-100% of spendable funds');
  });
});

describe('/objective browser guards', () => {
  it('imports browser and guards document access', () => {
    const s = src();
    expect(s).toContain("import { browser } from '$app/environment'");
    expect(s).toContain('if (!browser) return;');
    expect(s).toContain("document.getElementById('objective')");
  });

  it('uses Svelte 5 runes instead of legacy reactive declarations', () => {
    const s = src();
    expect(s).toContain('$state');
    expect(s).toContain('$derived');
    expect(s).not.toMatch(/^\s*\$:/m);
  });
});
