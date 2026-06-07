import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CYCLE_DETAIL = resolve(import.meta.dirname, '../routes/cycles/[id]/+page.svelte');

function source(): string {
  return readFileSync(CYCLE_DETAIL, 'utf-8');
}

describe('cycle detail epic-review verdict card contract', () => {
  it('fetches the epic-review endpoint through the workspace-aware, browser-guarded loader', () => {
    const s = source();

    expect(s).toContain('async function loadEpicReview(): Promise<void>');
    expect(s).toContain('if (!browser || !id) return;');
    expect(s).toContain('fetch(withWorkspace(`/api/v5/cycles/${id}/epic-review`))');
    // Loader runs on initial secondary load and on the live poll.
    expect(s).toContain('loadEpicReview(),');
    expect(s).toContain('void loadEpicReview();');
  });

  it('hides the card for a signal cycle by treating a 404 as "not an epic cycle"', () => {
    const s = source();

    // 404 → epicReview stays null, so the {#if epicReview} header card is hidden.
    expect(s).toMatch(/if \(res\.status === 404\) \{\s*epicReview = null;\s*return;\s*\}/);
    expect(s).toContain('let epicReview = $state<EpicReviewView | null>(null);');
  });

  it('renders EpicVerdictCard in the header only for epic cycles (verdict, rationale, faulted items)', () => {
    const s = source();

    // Header gate — only shown when epicReview is populated.
    expect(s).toContain('{#if epicReview}');
    expect(s).toContain('{@render EpicVerdictCard(epicReview)}');

    // Snippet structure: verdict badge, rationale excerpt, faulted items.
    expect(s).toContain('{#snippet EpicVerdictCard(review: EpicReviewView)}');
    expect(s).toContain('Badge variant={epicVerdictVariant(review.verdict)}');
    expect(s).toContain('epicRationaleExcerpt(review.rationale)');
    expect(s).toContain('{#if review.faultedItems.length > 0}');
    expect(s).toContain('{#each review.faultedItems as item, i (item.itemId ?? i)}');
  });

  it('maps verdicts to badge variants and excerpts long rationales', () => {
    const s = source();

    expect(s).toContain("function epicVerdictVariant(verdict: string | null)");
    expect(s).toContain("if (v === 'REQUEST_CHANGES'");
    expect(s).toContain("if (v === 'APPROVE'");
    expect(s).toContain('function epicRationaleExcerpt(text: string, max = 240): string');
  });
});
