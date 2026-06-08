// packages/dashboard/src/lib/__tests__/objective-api.test.ts
//
// Unit tests for the objective-mode fetch helpers.
//
// Strategy:
//   - Use vi.stubGlobal to inject a mock fetch so tests are fully isolated.
//   - The workspace store is un-seeded in happy-dom (localStorage is empty),
//     so withWorkspace() returns URLs unchanged — plain path assertions work.
//   - Each test teardown calls vi.unstubAllGlobals() to prevent leakage.

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  getDecomposition,
  getEpicReview,
  getSpendReport,
  postObjective,
} from '../objective-api.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Response-like object for vi.stubGlobal('fetch', ...). */
function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── getDecomposition ──────────────────────────────────────────────────────────

describe('getDecomposition', () => {
  it('fetches the correct URL', async () => {
    const fetchMock = makeFetch(200, []);
    vi.stubGlobal('fetch', fetchMock);

    await getDecomposition('cycle-abc');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles/cycle-abc/decomposition');
  });

  it('URL-encodes the cycle id', async () => {
    const fetchMock = makeFetch(200, []);
    vi.stubGlobal('fetch', fetchMock);

    await getDecomposition('a/b c');

    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles/a%2Fb%20c/decomposition');
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', makeFetch(404, {}));

    const result = await getDecomposition('cycle-missing');

    expect(result).toBeNull();
  });

  it('returns parsed JSON on success', async () => {
    const payload = [{ waveIndex: 0, children: [] }];
    vi.stubGlobal('fetch', makeFetch(200, payload));

    const result = await getDecomposition('cycle-abc');

    expect(result).toEqual(payload);
  });

  it('throws on non-404 error status', async () => {
    vi.stubGlobal('fetch', makeFetch(500, {}));

    await expect(getDecomposition('cycle-abc')).rejects.toThrow('HTTP 500');
  });

  it('throws on 503 error status', async () => {
    vi.stubGlobal('fetch', makeFetch(503, {}));

    await expect(getDecomposition('cycle-abc')).rejects.toThrow('HTTP 503');
  });
});

// ── getEpicReview ─────────────────────────────────────────────────────────────

describe('getEpicReview', () => {
  it('fetches the correct URL', async () => {
    const fetchMock = makeFetch(200, { verdict: 'pass', rationale: 'all good', faultedItems: [] });
    vi.stubGlobal('fetch', fetchMock);

    await getEpicReview('cycle-xyz');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles/cycle-xyz/epic-review');
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', makeFetch(404, {}));

    const result = await getEpicReview('cycle-xyz');

    expect(result).toBeNull();
  });

  it('returns parsed artifact on success', async () => {
    const payload = { verdict: 'partial', rationale: 'one item failed', faultedItems: ['w2-c'] };
    vi.stubGlobal('fetch', makeFetch(200, payload));

    const result = await getEpicReview('cycle-xyz');

    expect(result).toEqual(payload);
  });

  it('throws on non-404 error status', async () => {
    vi.stubGlobal('fetch', makeFetch(422, {}));

    await expect(getEpicReview('cycle-xyz')).rejects.toThrow('HTTP 422');
  });
});

// ── getSpendReport ────────────────────────────────────────────────────────────

describe('getSpendReport', () => {
  it('fetches the correct URL', async () => {
    const fetchMock = makeFetch(200, {
      perItem: [],
      totals: { executionUsd: 0, overheadUsd: 0, utilizationPct: 0 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await getSpendReport('cycle-abc');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles/cycle-abc/spend-report');
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', makeFetch(404, {}));

    const result = await getSpendReport('cycle-abc');

    expect(result).toBeNull();
  });

  it('returns parsed report on success', async () => {
    const payload = {
      perItem: [{ id: 'w1-a', plannedUsd: 2.5, actualUsd: 2.1 }],
      totals: { executionUsd: 2.1, overheadUsd: 0.3, utilizationPct: 80 },
    };
    vi.stubGlobal('fetch', makeFetch(200, payload));

    const result = await getSpendReport('cycle-abc');

    expect(result).toEqual(payload);
  });

  it('throws on non-404 error status', async () => {
    vi.stubGlobal('fetch', makeFetch(500, {}));

    await expect(getSpendReport('cycle-abc')).rejects.toThrow('HTTP 500');
  });
});

// ── postObjective ─────────────────────────────────────────────────────────────

describe('postObjective', () => {
  it('POSTs to the correct URL with JSON body', async () => {
    const fetchMock = makeFetch(200, { cycleId: 'new-cycle-123' });
    vi.stubGlobal('fetch', fetchMock);

    await postObjective({ objective: 'improve test coverage to 90%', budgetUsd: 50 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v5/objective', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'improve test coverage to 90%', budgetUsd: 50 }),
    });
  });

  it('accepts a body with only budgetUsd (objective is optional)', async () => {
    const fetchMock = makeFetch(200, { cycleId: 'new-cycle-456' });
    vi.stubGlobal('fetch', fetchMock);

    await postObjective({ budgetUsd: 30 });

    expect(fetchMock).toHaveBeenCalledWith('/api/v5/objective', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budgetUsd: 30 }),
    });
  });

  it('accepts an empty body (all fields optional)', async () => {
    const fetchMock = makeFetch(200, { cycleId: 'new-cycle-789' });
    vi.stubGlobal('fetch', fetchMock);

    await postObjective({});

    expect(fetchMock).toHaveBeenCalledWith('/api/v5/objective', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({}),
    }));
  });

  it('returns the cycleId from the server response', async () => {
    vi.stubGlobal('fetch', makeFetch(200, { cycleId: 'new-cycle-123' }));

    const result = await postObjective({ budgetUsd: 25 });

    expect(result.cycleId).toBe('new-cycle-123');
  });

  it('throws on non-ok status', async () => {
    vi.stubGlobal('fetch', makeFetch(400, {}));

    await expect(postObjective({ objective: 'bad request' })).rejects.toThrow('HTTP 400');
  });

  it('throws on 409 conflict', async () => {
    vi.stubGlobal('fetch', makeFetch(409, {}));

    await expect(postObjective({})).rejects.toThrow('HTTP 409');
  });
});
