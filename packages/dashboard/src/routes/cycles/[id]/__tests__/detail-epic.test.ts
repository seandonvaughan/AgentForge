/**
 * Source-level contract tests for objective-cycle Epic/Spend integration on
 * /cycles/[id]/+page.svelte.
 *
 * The route imports SvelteKit $app modules, so this follows the existing PRs
 * tab test style and asserts the source contracts that exercise the operator
 * surface without rendering the component in plain vitest.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('cycle detail Epic/Spend integration — file presence', () => {
  it('the cycle detail +page.svelte exists at the expected route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

describe('cycle detail Epic/Spend integration — tab contracts', () => {
  it('adds epic and spend as Tab union members', () => {
    const s = src();
    expect(s).toContain("'epic'");
    expect(s).toContain("'spend'");
  });

  it('declares gated Epic and Spend tab labels for objective cycles', () => {
    const s = src();
    expect(s).toContain('isObjectiveCycle');
    expect(s).toContain("label: 'Epic'");
    expect(s).toContain("label: 'Spend'");
  });

  it('renders Epic and Spend tab panels', () => {
    const s = src();
    expect(s).toContain("activeTab === 'epic'");
    expect(s).toContain("activeTab === 'spend'");
    expect(s).toContain('EPIC WAVES');
    expect(s).toContain('SPEND REPORT');
  });
});

describe('cycle detail Epic/Spend integration — objective-cycle gate', () => {
  it('detects objective cycles from objective text, epicIntegration, epic-review mode, or parentEpicId items', () => {
    const s = src();
    expect(s).toContain('objectiveText !== null');
    expect(s).toContain('epicIntegration !== null');
    expect(s).toContain("epicReview?.mode === 'epic-review'");
    expect(s).toContain('parentEpicId');
  });

  it('guards objective-only tabs by redirecting inactive access back to overview', () => {
    const s = src();
    expect(s).toContain("activeTab === 'epic' || activeTab === 'spend'");
    expect(s).toContain("activeTab = 'overview'");
  });
});

describe('cycle detail Epic/Spend integration — epic-review verdict card', () => {
  it('renders an objective-gated header verdict card', () => {
    const s = src();
    expect(s).toContain('epic-verdict-card');
    expect(s).toContain('Epic review verdict');
    expect(s).toContain('EPIC REVIEW');
    expect(s).toContain('epicReviewVerdict');
  });

  it('loads the legacy gate phase endpoint and filters for mode=epic-review', () => {
    const s = src();
    expect(s).toContain('/phases/gate');
    expect(s).toContain("body?.mode === 'epic-review'");
    expect(s).toContain('loadEpicReview');
  });

  it('browser-guards the epic-review fetch path', () => {
    const s = src();
    expect(s).toContain("from '$app/environment'");
    expect(s).toContain('if (!browser || !id) return');
  });

  it('maps epic-review verdicts to Badge variants', () => {
    const s = src();
    expect(s).toContain('epicVerdictVariant');
    expect(s).toContain("'request_changes'");
    expect(s).toContain("'triage'");
  });
});

describe('cycle detail Epic/Spend integration — spend report surface', () => {
  it('derives planned, execution, overhead, and utilization spend values', () => {
    const s = src();
    expect(s).toContain('spendPlannedUsd');
    expect(s).toContain('spendExecutionUsd');
    expect(s).toContain('spendOverheadUsd');
    expect(s).toContain('spendUtilizationPct');
  });

  it('renders planned vs actual spend columns', () => {
    const s = src();
    expect(s).toContain('<th>Planned</th>');
    expect(s).toContain('<th>Actual</th>');
    expect(s).toContain('<th>Delta</th>');
  });
});
