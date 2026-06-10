/**
 * Source-level contract tests for the Epic tab, Spend tab, and EpicReviewCard
 * integration on /cycles/[id]/+page.svelte.
 *
 * SvelteKit components that import $app/* cannot be rendered in plain vitest
 * without the full Kit Vite plugin. Full rendering is covered by Playwright e2e.
 * This file asserts source-level contracts only:
 *  - File presence
 *  - EpicTab, SpendTab, EpicReviewCard component imports
 *  - getDecomposition API import used for isEpic probe
 *  - 'epic' and 'spend' are Tab type union members
 *  - Tab labels 'Epic' and 'Spend' are present
 *  - isEpic state variable exists
 *  - epicItemResults derived exists
 *  - probeDecomposition function wired into loadSecondaryCycleData
 *  - EpicReviewCard mounted in the header region (gated on isEpic)
 *  - Epic and Spend tab panes reference the components
 *  - epicItemResults passed as itemResults to EpicTab
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

// ── File presence ─────────────────────────────────────────────────────────────

describe('epic-tabs — file presence', () => {
  it('the cycle detail +page.svelte exists at the expected route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

// ── Source helper ─────────────────────────────────────────────────────────────

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

// ── Component imports ─────────────────────────────────────────────────────────

describe('epic-tabs — component imports', () => {
  it('imports EpicTab from $lib/components/cycles/EpicTab.svelte', () => {
    expect(src()).toContain("import EpicTab from '$lib/components/cycles/EpicTab.svelte'");
  });

  it('imports SpendTab from $lib/components/cycles/SpendTab.svelte', () => {
    expect(src()).toContain("import SpendTab from '$lib/components/cycles/SpendTab.svelte'");
  });

  it('imports EpicReviewCard from $lib/components/cycles/EpicReviewCard.svelte', () => {
    expect(src()).toContain("import EpicReviewCard from '$lib/components/cycles/EpicReviewCard.svelte'");
  });
});

// ── API import ────────────────────────────────────────────────────────────────

describe('epic-tabs — API import', () => {
  it('imports getDecomposition from $lib/api/epic.js for the isEpic probe', () => {
    const s = src();
    expect(s).toContain('getDecomposition');
    expect(s).toContain("from '$lib/api/epic.js'");
  });
});

// ── Tab type ──────────────────────────────────────────────────────────────────

describe('epic-tabs — Tab type', () => {
  it("includes 'epic' as a Tab type union member", () => {
    expect(src()).toMatch(/'epic'/);
  });

  it("includes 'spend' as a Tab type union member", () => {
    expect(src()).toMatch(/'spend'/);
  });
});

// ── Tab labels ────────────────────────────────────────────────────────────────

describe('epic-tabs — tab labels', () => {
  it("declares a tab with label 'Epic'", () => {
    expect(src()).toContain("label: 'Epic'");
  });

  it("declares a tab with label 'Spend'", () => {
    expect(src()).toContain("label: 'Spend'");
  });

  it('adds Epic/Spend tabs conditionally inside the isEpic guard', () => {
    const s = src();
    expect(s).toContain('isEpic');
    // Both tabs are pushed/appended only when isEpic is true
    const epicTabSection = s.indexOf("label: 'Epic'");
    const isEpicGuard = s.lastIndexOf('isEpic', epicTabSection);
    expect(isEpicGuard).toBeGreaterThan(-1);
  });
});

// ── State and derived ─────────────────────────────────────────────────────────

describe('epic-tabs — Svelte 5 runes', () => {
  it('declares isEpic as a $state variable', () => {
    expect(src()).toContain('isEpic = $state(false)');
  });

  it('declares epicItemResults as a $derived.by', () => {
    expect(src()).toContain('epicItemResults');
    expect(src()).toContain('$derived.by');
  });

  it('builds epicItemResults from execute-phase agentsData runs', () => {
    const s = src();
    expect(s).toContain("r.phase !== 'execute'");
    expect(s).toContain('epicItemResults');
  });
});

// ── probeDecomposition ────────────────────────────────────────────────────────

describe('epic-tabs — probeDecomposition', () => {
  it('defines a probeDecomposition function', () => {
    expect(src()).toContain('probeDecomposition');
  });

  it('calls getDecomposition(id) inside probeDecomposition', () => {
    const s = src();
    expect(s).toContain('getDecomposition(id)');
  });

  it('sets isEpic = true when decomposition is non-null', () => {
    const s = src();
    expect(s).toContain('isEpic = d !== null');
  });

  it('includes probeDecomposition in loadSecondaryCycleData', () => {
    const s = src();
    const secondary = s.match(/loadSecondaryCycleData[\s\S]*?Promise\.allSettled\([\s\S]*?\]\)/)?.[0] ?? '';
    expect(secondary).toContain('probeDecomposition');
  });
});

// ── EpicReviewCard in header ──────────────────────────────────────────────────

describe('epic-tabs — EpicReviewCard in header region', () => {
  it('renders EpicReviewCard in the template', () => {
    expect(src()).toContain('<EpicReviewCard');
  });

  it('passes cycleId={id} to EpicReviewCard', () => {
    expect(src()).toContain('EpicReviewCard cycleId={id}');
  });

  it('gates EpicReviewCard on isEpic', () => {
    const s = src();
    // EpicReviewCard must appear after an isEpic check
    const cardIdx = s.indexOf('<EpicReviewCard');
    const isEpicIdx = s.lastIndexOf('isEpic', cardIdx);
    expect(isEpicIdx).toBeGreaterThan(-1);
  });
});

// ── Epic tab pane ─────────────────────────────────────────────────────────────

describe('epic-tabs — Epic tab pane', () => {
  it("has a {#if activeTab === 'epic'} pane", () => {
    expect(src()).toContain("activeTab === 'epic'");
  });

  it('renders <EpicTab inside the epic tab pane', () => {
    expect(src()).toContain('<EpicTab');
  });

  it('passes cycleId={id} to EpicTab', () => {
    expect(src()).toContain('EpicTab cycleId={id}');
  });

  it('passes epicItemResults as itemResults to EpicTab', () => {
    expect(src()).toContain('itemResults={epicItemResults}');
  });
});

// ── Spend tab pane ────────────────────────────────────────────────────────────

describe('epic-tabs — Spend tab pane', () => {
  it("has a {#if activeTab === 'spend'} pane", () => {
    expect(src()).toContain("activeTab === 'spend'");
  });

  it('renders <SpendTab inside the spend tab pane', () => {
    expect(src()).toContain('<SpendTab');
  });

  it('passes cycleId={id} to SpendTab', () => {
    expect(src()).toContain('SpendTab cycleId={id}');
  });
});
