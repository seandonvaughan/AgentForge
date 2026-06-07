import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import EpicVerdictCard from '$lib/components/cycles/EpicVerdictCard.svelte';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('EpicVerdictCard', () => {
  describe('verdict pill', () => {
    it('renders an APPROVE verdict with success styling', () => {
      const { getByTestId, container } = render(EpicVerdictCard, {
        props: { verdict: 'APPROVE', rationale: 'Branch satisfies the objective.' },
      });

      expect(getByTestId('verdict-pill').textContent).toBe('APPROVE');
      expect(container.querySelector('.epic-verdict-card')?.getAttribute('data-verdict')).toBe(
        'APPROVE',
      );
      expect(container.querySelector('.tone-success')).not.toBeNull();
    });

    it('renders a REQUEST_CHANGES verdict with danger styling and humanized label', () => {
      const { getByTestId, container } = render(EpicVerdictCard, {
        props: { verdict: 'REQUEST_CHANGES', rationale: 'A child item is broken.' },
      });

      expect(getByTestId('verdict-pill').textContent).toBe('REQUEST CHANGES');
      expect(container.querySelector('.tone-danger')).not.toBeNull();
    });

    it('renders a TRIAGE verdict with warning styling', () => {
      const { getByTestId, container } = render(EpicVerdictCard, {
        props: { verdict: 'TRIAGE', rationale: 'Reviewer output was unparseable.' },
      });

      expect(getByTestId('verdict-pill').textContent).toBe('TRIAGE');
      expect(container.querySelector('.tone-warning')).not.toBeNull();
    });
  });

  describe('rationale excerpt', () => {
    it('shows the full rationale when under the excerpt length', () => {
      const { getByTestId } = render(EpicVerdictCard, {
        props: { verdict: 'APPROVE', rationale: 'Short and sweet.' },
      });

      expect(getByTestId('rationale').textContent?.trim()).toBe('Short and sweet.');
    });

    it('truncates a long rationale with an ellipsis and keeps the full text in the title', () => {
      const long = 'x'.repeat(400);
      const { getByTestId } = render(EpicVerdictCard, {
        props: { verdict: 'APPROVE', rationale: long, excerptLength: 50 },
      });

      const node = getByTestId('rationale');
      expect(node.textContent?.trim().endsWith('…')).toBe(true);
      expect(node.textContent?.trim().length).toBeLessThan(long.length);
      expect(node.getAttribute('title')).toBe(long);
    });

    it('falls back to a placeholder when no rationale is provided', () => {
      const { getByTestId } = render(EpicVerdictCard, {
        props: { verdict: 'APPROVE' },
      });

      expect(getByTestId('rationale').textContent?.trim()).toBe('No rationale provided.');
    });
  });

  describe('faulted items', () => {
    it('renders the faulted-items list when items are present', () => {
      const { getByTestId, getAllByText } = render(EpicVerdictCard, {
        props: {
          verdict: 'REQUEST_CHANGES',
          rationale: 'Two items need work.',
          faultedItems: [
            { itemId: 'child-3', reason: 'Missing endpoint', files: ['a.ts', 'b.ts'] },
            { itemId: 'child-7', reason: 'Test gap' },
          ],
        },
      });

      const list = getByTestId('faulted-items');
      expect(list.querySelectorAll('li.evc-fault')).toHaveLength(2);
      expect(getByTestId('fault-count').textContent?.trim()).toBe('2 faulted');
      expect(getAllByText('child-3')).toHaveLength(1);
      // Files render only when present.
      expect(list.textContent).toContain('a.ts, b.ts');
    });

    it('omits the faulted-items list and count when none are present', () => {
      const { queryByTestId } = render(EpicVerdictCard, {
        props: { verdict: 'APPROVE', rationale: 'All good.', faultedItems: [] },
      });

      expect(queryByTestId('faulted-items')).toBeNull();
      expect(queryByTestId('fault-count')).toBeNull();
    });

    it('omits the faulted-items list when the prop is undefined', () => {
      const { queryByTestId } = render(EpicVerdictCard, {
        props: { verdict: 'TRIAGE', rationale: 'Unparseable.' },
      });

      expect(queryByTestId('faulted-items')).toBeNull();
    });
  });
});
