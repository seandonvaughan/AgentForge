/**
 * Source-level contract tests for SpendTab.svelte
 *
 * Full DOM rendering requires the SvelteKit Vite plugin (which transforms
 * $lib/* path aliases and Svelte runes). These tests instead verify the
 * source-code contracts: prop shapes, API imports, helper imports, state
 * initialisation, 404-notice, per-item table columns, totals rendering, delta
 * colour mapping, and design token usage — all things that break visibly if
 * the implementation drifts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const COMPONENT_PATH = resolve(import.meta.dirname, '../SpendTab.svelte');
const source = readFileSync(COMPONENT_PATH, 'utf8');

// ── File presence ──────────────────────────────────────────────────────────────

describe('SpendTab file', () => {
  it('exists and is non-empty', () => {
    expect(source.length).toBeGreaterThan(0);
  });
});

// ── Props contract ─────────────────────────────────────────────────────────────

describe('SpendTab props', () => {
  it('declares cycleId as a required string prop', () => {
    expect(source).toContain('cycleId: string');
  });

  it('accepts an optional class override prop', () => {
    expect(source).toContain('class?: string');
    expect(source).toContain('class: className');
  });

  it('uses $props() rune', () => {
    expect(source).toContain('$props()');
  });
});

// ── API integration ────────────────────────────────────────────────────────────

describe('SpendTab API integration', () => {
  it('imports getSpendReport from the epic API module', () => {
    expect(source).toContain("from '$lib/api/epic.js'");
    expect(source).toContain('getSpendReport');
  });

  it('calls getSpendReport with the cycleId local snapshot', () => {
    expect(source).toContain('getSpendReport(id)');
  });

  it('uses $effect to re-fetch when cycleId changes', () => {
    expect(source).toContain('$effect(');
  });

  it('captures cycleId as a local const to stabilise the async closure', () => {
    expect(source).toContain('const id = cycleId');
  });
});

// ── Spend-report helper imports ────────────────────────────────────────────────

describe('SpendTab spend-report helpers', () => {
  it('imports buildSpendRows from the spend-report utility', () => {
    expect(source).toContain("from '$lib/util/spend-report.js'");
    expect(source).toContain('buildSpendRows');
  });

  it('imports buildSpendTotals from the spend-report utility', () => {
    expect(source).toContain('buildSpendTotals');
  });

  it('calls buildSpendRows with the fetched report', () => {
    expect(source).toContain('buildSpendRows(report)');
  });

  it('calls buildSpendTotals with the fetched report', () => {
    expect(source).toContain('buildSpendTotals(report)');
  });
});

// ── State initialisation ───────────────────────────────────────────────────────

describe('SpendTab state initialisation', () => {
  it('initialises report state with an explicit null (not missing initialiser)', () => {
    // Guards against the $state<T>() without initialiser pitfall
    expect(source).toMatch(/\$state<SpendReport \| null>\(null\)/);
  });

  it('initialises loading state as true', () => {
    expect(source).toContain('$state(true)');
  });

  it('resets report to null before each fetch so stale data is not displayed', () => {
    expect(source).toContain('report = null');
  });
});

// ── 404 / no-report state ──────────────────────────────────────────────────────

describe('SpendTab 404 / no-report state', () => {
  it('checks for null report explicitly in the template', () => {
    expect(source).toContain('report === null');
  });

  it('shows a "no spend report yet" notice when report is null', () => {
    expect(source).toMatch(/[Nn]o spend report/);
  });
});

// ── Per-item table ─────────────────────────────────────────────────────────────

describe('SpendTab per-item table', () => {
  it('renders a table element for the item breakdown', () => {
    expect(source).toContain('<table');
  });

  it('iterates over rows with {#each}', () => {
    expect(source).toContain('{#each rows as row');
  });

  it('renders a Planned column header', () => {
    expect(source).toMatch(/[Pp]lanned/);
  });

  it('renders an Actual column header', () => {
    expect(source).toMatch(/[Aa]ctual/);
  });

  it('renders a Delta column header', () => {
    expect(source).toMatch(/[Dd]elta/);
  });

  it('outputs row.plannedFormatted in the table', () => {
    expect(source).toContain('row.plannedFormatted');
  });

  it('outputs row.actualFormatted in the table', () => {
    expect(source).toContain('row.actualFormatted');
  });

  it('outputs row.deltaFormatted in the table', () => {
    expect(source).toContain('row.deltaFormatted');
  });

  it('outputs row.deltaPctFormatted in the table', () => {
    expect(source).toContain('row.deltaPctFormatted');
  });
});

// ── Totals section ─────────────────────────────────────────────────────────────

describe('SpendTab totals section', () => {
  it('renders executionFormatted', () => {
    expect(source).toContain('totals.executionFormatted');
  });

  it('renders overheadFormatted', () => {
    expect(source).toContain('totals.overheadFormatted');
  });

  it('renders utilizationFormatted', () => {
    expect(source).toContain('totals.utilizationFormatted');
  });
});

// ── Delta colour mapping ───────────────────────────────────────────────────────

describe('SpendTab delta colour mapping', () => {
  it('applies a pos class for under-budget items (colour: --af-success)', () => {
    expect(source).toContain('.pos');
    expect(source).toContain('--af-success');
  });

  it('applies a neg class for over-budget items (colour: --af-danger)', () => {
    expect(source).toContain('.neg');
    expect(source).toContain('--af-danger');
  });
});

// ── Design-system token usage ──────────────────────────────────────────────────

describe('SpendTab design tokens', () => {
  it('uses --af-surface for table header background', () => {
    expect(source).toContain('--af-surface');
  });

  it('uses --af-border for cell dividers', () => {
    expect(source).toContain('--af-border');
  });

  it('uses --af-text-muted for muted labels', () => {
    expect(source).toContain('--af-text-muted');
  });

  it('applies af2-mono class for numeric values', () => {
    expect(source).toContain('af2-mono');
  });
});
