import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import EpicReviewCard, {
  epicReviewVerdictVariant,
  formatEpicReviewVerdict,
  formatFaultedFiles,
  formatRationaleExcerpt,
  type EpicReviewArtifact,
} from '../EpicReviewCard.svelte';

function mockReview(review: EpicReviewArtifact | null, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (status === 204) return new Response(null, { status });
    return new Response(review === null ? null : JSON.stringify({ data: review }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

describe('EpicReviewCard formatters', () => {
  it('formats verdict labels and badge variants', () => {
    expect(formatEpicReviewVerdict('APPROVE')).toBe('Approved');
    expect(formatEpicReviewVerdict('REQUEST_CHANGES')).toBe('Changes requested');
    expect(formatEpicReviewVerdict('TRIAGE')).toBe('Triage');
    expect(formatEpicReviewVerdict('unexpected')).toBe('Unknown');

    expect(epicReviewVerdictVariant('APPROVE')).toBe('success');
    expect(epicReviewVerdictVariant('REQUEST_CHANGES')).toBe('danger');
    expect(epicReviewVerdictVariant('TRIAGE')).toBe('warning');
    expect(epicReviewVerdictVariant('unexpected')).toBe('muted');
  });

  it('formats rationale excerpts and faulted file summaries', () => {
    expect(formatRationaleExcerpt('  Ready\n\nfor release.  ')).toBe('Ready for release.');
    expect(formatRationaleExcerpt('a'.repeat(230))).toHaveLength(220);
    expect(formatRationaleExcerpt('a'.repeat(230)).endsWith('...')).toBe(true);

    expect(formatFaultedFiles([])).toBe('No files listed');
    expect(formatFaultedFiles(['one.ts', 'two.ts'])).toBe('one.ts, two.ts');
    expect(formatFaultedFiles(['one.ts', 'two.ts', 'three.ts'])).toBe('one.ts, two.ts +1');
  });
});

describe('EpicReviewCard rendering', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders an approve verdict without faulted items', async () => {
    mockReview({
      mode: 'epic-review',
      verdict: 'APPROVE',
      rationale: 'All sprint items meet the gate and no regressions were found.',
      faultedItems: [],
    });

    render(EpicReviewCard, { props: { cycleId: 'cycle-1' } });

    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(screen.getByText('All sprint items meet the gate and no regressions were found.')).toBeTruthy();
    expect(screen.queryByLabelText('Faulted items')).toBeNull();
  });

  it('renders request-changes verdict with faulted items', async () => {
    mockReview({
      mode: 'epic-review',
      verdict: 'REQUEST_CHANGES',
      rationale: 'Two child items need fixes before this epic can close.',
      faultedItems: [
        {
          itemId: 'C21',
          reason: 'Missing cancellation copy in the header.',
          files: ['packages/dashboard/src/routes/cycles/[id]/+page.svelte'],
        },
        {
          itemId: 'C22',
          reason: 'Fault projection is not wired to live updates.',
          files: ['a.ts', 'b.ts', 'c.ts'],
        },
      ],
    });

    render(EpicReviewCard, { props: { cycleId: 'cycle-2' } });

    expect(await screen.findByText('Changes requested')).toBeTruthy();
    expect(screen.getByLabelText('Faulted items')).toBeTruthy();
    expect(screen.getByText('C21')).toBeTruthy();
    expect(screen.getByText('Missing cancellation copy in the header.')).toBeTruthy();
    expect(screen.getByText('packages/dashboard/src/routes/cycles/[id]/+page.svelte')).toBeTruthy();
    expect(screen.getByText('C22')).toBeTruthy();
    expect(screen.getByText('a.ts, b.ts +1')).toBeTruthy();
  });

  it('renders a triage verdict distinctly', async () => {
    mockReview({
      mode: 'epic-review',
      verdict: 'TRIAGE',
      rationale: 'Review output was unparseable, so deterministic verification remains authoritative.',
      faultedItems: [],
      triageUsed: true,
    });

    render(EpicReviewCard, { props: { cycleId: 'cycle-3' } });

    expect(await screen.findByText('Triage')).toBeTruthy();
    expect(screen.getByText('Review output was unparseable, so deterministic verification remains authoritative.')).toBeTruthy();
  });

  it('renders no card when the epic-review artifact is absent', async () => {
    mockReview(null, 404);

    const { container } = render(EpicReviewCard, { props: { cycleId: 'cycle-missing' } });

    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});
