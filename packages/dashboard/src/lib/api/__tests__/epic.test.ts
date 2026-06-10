/**
 * Tests for packages/dashboard/src/lib/api/epic.ts
 *
 * Verifies:
 *   - getDecomposition / getEpicReview / getSpendReport return typed data on 200
 *   - all three GET wrappers return null on 404
 *   - non-404 errors are rethrown
 *   - createObjectiveCycle POSTs the correct body to /api/v5/cycles
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDecomposition,
  getEpicReview,
  getSpendReport,
  createObjectiveCycle,
  type Decomposition,
  type EpicReview,
  type SpendReport,
  type ObjectiveCycle,
} from '../epic.js';

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  // No-op: individual tests install their own fetch stubs via vi.stubGlobal.
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Fixture data ──────────────────────────────────────────────────────────────

const CYCLE_ID = 'cycle-abc-123';

const DECOMPOSITION_FIXTURE: Decomposition = {
  id: CYCLE_ID,
  objective: 'Build a user authentication system',
  budgetUsd: 50,
  children: [
    {
      id: 'item-1',
      title: 'Implement login endpoint',
      files: ['src/auth/login.ts'],
      estimatedCostUsd: 20,
      predecessors: [],
    },
    {
      id: 'item-2',
      title: 'Add JWT validation middleware',
      files: ['src/auth/jwt.ts', 'src/middleware/auth.ts'],
      estimatedCostUsd: 15,
      predecessors: ['item-1'],
    },
  ],
  createdAt: '2026-06-10T10:00:00.000Z',
};

const EPIC_REVIEW_FIXTURE: EpicReview = {
  verdict: 'pass',
  rationale: 'All items completed within budget with no regressions.',
};

const EPIC_REVIEW_FAIL_FIXTURE: EpicReview = {
  verdict: 'fail',
  rationale: 'Two items exceeded their budget cap.',
  faultedItems: ['item-1', 'item-2'],
};

const SPEND_REPORT_FIXTURE: SpendReport = {
  cycleId: CYCLE_ID,
  items: [
    { itemId: 'item-1', title: 'Implement login endpoint', plannedUsd: 20, actualUsd: 18.5 },
    { itemId: 'item-2', title: 'Add JWT validation middleware', plannedUsd: 15, actualUsd: 16.2 },
  ],
  execution: 34.7,
  overhead: 5.3,
  utilization: 0.867,
};

// ── getDecomposition ──────────────────────────────────────────────────────────

describe('getDecomposition', () => {
  it('returns typed Decomposition on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(200, DECOMPOSITION_FIXTURE));

    const result = await getDecomposition(CYCLE_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(CYCLE_ID);
    expect(result!.objective).toBe('Build a user authentication system');
    expect(result!.budgetUsd).toBe(50);
    expect(result!.children).toHaveLength(2);
    expect(result!.children[0]!.id).toBe('item-1');
    expect(result!.children[0]!.predecessors).toHaveLength(0);
    expect(result!.children[1]!.predecessors).toEqual(['item-1']);
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', mockFetch(404, { error: 'Not found' }));

    const result = await getDecomposition(CYCLE_ID);

    expect(result).toBeNull();
  });

  it('throws on non-404 error', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { error: 'Internal server error' }));

    await expect(getDecomposition(CYCLE_ID)).rejects.toThrow('Internal server error');
  });

  it('calls the correct URL', async () => {
    const fetchMock = mockFetch(200, DECOMPOSITION_FIXTURE);
    vi.stubGlobal('fetch', fetchMock);

    await getDecomposition(CYCLE_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/v5/cycles/${CYCLE_ID}/decomposition`);
  });
});

// ── getEpicReview ─────────────────────────────────────────────────────────────

describe('getEpicReview', () => {
  it('returns typed EpicReview on 200 (pass)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, EPIC_REVIEW_FIXTURE));

    const result = await getEpicReview(CYCLE_ID);

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('pass');
    expect(result!.rationale).toContain('within budget');
    expect(result!.faultedItems).toBeUndefined();
  });

  it('returns typed EpicReview on 200 (fail with faultedItems)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, EPIC_REVIEW_FAIL_FIXTURE));

    const result = await getEpicReview(CYCLE_ID);

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('fail');
    expect(result!.faultedItems).toEqual(['item-1', 'item-2']);
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', mockFetch(404, {}));

    const result = await getEpicReview(CYCLE_ID);

    expect(result).toBeNull();
  });

  it('throws on non-404 error using message field', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { message: 'Service unavailable' }));

    await expect(getEpicReview(CYCLE_ID)).rejects.toThrow('Service unavailable');
  });

  it('calls the correct URL', async () => {
    const fetchMock = mockFetch(200, EPIC_REVIEW_FIXTURE);
    vi.stubGlobal('fetch', fetchMock);

    await getEpicReview(CYCLE_ID);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/v5/cycles/${CYCLE_ID}/epic-review`);
  });
});

// ── getSpendReport ────────────────────────────────────────────────────────────

describe('getSpendReport', () => {
  it('returns typed SpendReport on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(200, SPEND_REPORT_FIXTURE));

    const result = await getSpendReport(CYCLE_ID);

    expect(result).not.toBeNull();
    expect(result!.cycleId).toBe(CYCLE_ID);
    expect(result!.items).toHaveLength(2);
    expect(result!.items[0]!.itemId).toBe('item-1');
    expect(result!.items[0]!.plannedUsd).toBe(20);
    expect(result!.items[0]!.actualUsd).toBe(18.5);
    expect(result!.execution).toBe(34.7);
    expect(result!.overhead).toBe(5.3);
    expect(result!.utilization).toBeCloseTo(0.867);
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', mockFetch(404, {}));

    const result = await getSpendReport(CYCLE_ID);

    expect(result).toBeNull();
  });

  it('throws on non-404 error', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'Forbidden' }));

    await expect(getSpendReport(CYCLE_ID)).rejects.toThrow('Forbidden');
  });

  it('throws with fallback HTTP status message when body has no error/message field', async () => {
    vi.stubGlobal('fetch', mockFetch(502, {}));

    await expect(getSpendReport(CYCLE_ID)).rejects.toThrow('HTTP 502');
  });

  it('calls the correct URL', async () => {
    const fetchMock = mockFetch(200, SPEND_REPORT_FIXTURE);
    vi.stubGlobal('fetch', fetchMock);

    await getSpendReport(CYCLE_ID);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/v5/cycles/${CYCLE_ID}/spend-report`);
  });
});

// ── createObjectiveCycle ──────────────────────────────────────────────────────

describe('createObjectiveCycle', () => {
  const NEW_CYCLE: ObjectiveCycle = {
    id: 'cycle-new-xyz',
    objective: 'Add OAuth2 support',
    budgetUsd: 75,
    status: 'pending',
  };

  it('POSTs to /api/v5/cycles and returns the new cycle', async () => {
    vi.stubGlobal('fetch', mockFetch(200, NEW_CYCLE));

    const result = await createObjectiveCycle({ objective: 'Add OAuth2 support', budgetUsd: 75 });

    expect(result.id).toBe('cycle-new-xyz');
    expect(result.status).toBe('pending');
  });

  it('sends objective and budgetUsd in the request body', async () => {
    const fetchMock = mockFetch(200, NEW_CYCLE);
    vi.stubGlobal('fetch', fetchMock);

    await createObjectiveCycle({ objective: 'Add OAuth2 support', budgetUsd: 75 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v5/cycles');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(options.body as string) as unknown;
    expect(body).toMatchObject({ objective: 'Add OAuth2 support', budgetUsd: 75 });
  });

  it('throws when POST returns a non-OK status', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { error: 'Invalid objective' }));

    await expect(
      createObjectiveCycle({ objective: '', budgetUsd: 0 }),
    ).rejects.toThrow('Invalid objective');
  });
});
