import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ObjectivePage from '../routes/objective/+page.svelte';
import { currentWorkspaceId } from '../lib/stores/workspace.js';
import { goto } from '$app/navigation';

vi.mock('$app/environment', () => ({
  browser: true,
  dev: true,
  building: false,
  version: 'test',
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

const gotoMock = vi.mocked(goto);

beforeEach(() => {
  localStorage.clear();
  currentWorkspaceId.set(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('/objective page', () => {
  it('posts the objective cycle body and navigates to the created cycle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cycleId: 'cycle-123' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(ObjectivePage);

    await fireEvent.input(screen.getByLabelText('Objective'), {
      target: { value: 'Improve cycle launch reliability' },
    });
    await fireEvent.input(screen.getByLabelText('Budget USD'), {
      target: { value: '75' },
    });
    await fireEvent.submit(screen.getByRole('form', { name: 'Launch objective cycle' }));

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/cycles/cycle-123'));
    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Improve cycle launch reliability',
        budgetUsd: 75,
      }),
    });
  });

  it('blocks empty objective submissions with validation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(ObjectivePage);

    await fireEvent.submit(screen.getByRole('form', { name: 'Launch objective cycle' }));

    expect(await screen.findByText('Objective is required.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gotoMock).not.toHaveBeenCalled();
  });
});
