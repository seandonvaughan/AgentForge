import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SpendTable v2 atom — source-level contract test.
 *
 * The root vitest config runs packages/**​/__tests__ under the `node`
 * environment with NO Svelte plugin, so this atom (like Btn.svelte and the
 * Layout shell) is verified by asserting its source contract rather than by
 * mounting it. Full rendering is exercised by the dashboard Playwright e2e
 * suite once the SpendTab consumer embeds it.
 */
const componentPath = resolve(import.meta.dirname, '../SpendTable.svelte');

describe('SpendTable', () => {
  it('exists as a colocated v2 atom', () => {
    expect(existsSync(componentPath)).toBe(true);
  });

  it('is a pure presentational atom — zero workspace/data dependencies', () => {
    const source = readFileSync(componentPath, 'utf8');
    // Iron law: atoms import no @agentforge/* package and never fetch.
    expect(source).not.toMatch(/from\s+['"]@agentforge\//);
    expect(source).not.toContain('fetch(');
    // The artifact shape is mirrored locally instead of imported.
    expect(source).toContain('export interface SpendTableReport');
    expect(source).toContain('export interface SpendTableRow');
  });

  it('accepts a report prop and an external class override (Svelte 5 runes)', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('= $props()');
    expect(source).toContain('class: className');
    expect(source).toContain('report: SpendTableReport');
  });

  it('renders the per-item planned-vs-actual table header', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('Planned');
    expect(source).toContain('Actual');
    expect(source).toContain('Status');
    // Each row is keyed by itemId.
    expect(source).toContain('{#each rows as row (row.itemId)}');
  });

  it('renders the execution / overhead / utilization totals footer', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('<tfoot>');
    expect(source).toContain('Execution');
    expect(source).toContain('Overhead');
    expect(source).toContain('Utilization');
    expect(source).toContain('report?.executionUsd');
    expect(source).toContain('report?.overheadUsd');
    expect(source).toContain('fmtPct(report?.utilization)');
  });

  it('handles an empty perItem set without crashing', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('rows.length === 0');
  });

  it('uses ReDoS-safe String.includes for status classification (no regex)', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('.includes(');
    expect(source).not.toMatch(/\.test\(\s*status/);
  });

  it('styles exclusively with v2 --af-* design tokens', () => {
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('var(--af-text)');
    expect(source).toContain('var(--af-border)');
    expect(source).toContain('color-mix(in srgb');
  });
});
