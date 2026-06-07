import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createObjectiveCycle,
  getDecomposition,
  getEpicReview,
  getSpendReport,
  type ObjectiveDecomposition,
} from '../objective.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('objective API client', () => {
  it('fetches and unwraps a decomposition artifact', async () => {
    const decomposition: ObjectiveDecomposition = {
      epicId: 'epic-123',
      rationale: 'Split by risk',
      children: [
        {
          id: 'C1',
          title: 'Client lib',
          description: 'Add typed helpers',
          files: ['packages/dashboard/src/lib/api/objective.ts'],
          capabilityTags: ['svelte-api-client'],
          suggestedAssignee: 'svelte-cycles-engineer',
          estimatedCostUsd: 4,
          estimatedComplexity: 'low',
          predecessors: [],
          wave: 0,
        },
      ],
      validationReport: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 1,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: decomposition }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDecomposition('cycle/one')).resolves.toEqual(decomposition);
    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles/cycle%2Fone/decomposition');
  });

  it('returns null for absent objective artifacts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'missing' }, { status: 404 })));

    await expect(getDecomposition('missing')).resolves.toBeNull();
    await expect(getEpicReview('missing')).resolves.toBeNull();
    await expect(getSpendReport('missing')).resolves.toBeNull();
  });

  it('posts an objective cycle launch request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      cycleId: 'cycle-123',
      startedAt: '2026-06-06T00:00:00.000Z',
      runtimeMode: 'codex-cli',
    }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createObjectiveCycle({
      objective: 'Ship objective mode',
      budgetUsd: 42,
    })).resolves.toMatchObject({ cycleId: 'cycle-123' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v5/cycles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'Ship objective mode', budgetUsd: 42 }),
    });
  });

  it('throws API error messages for non-404 failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'budgetUsd must be positive' }, { status: 400 })));

    await expect(createObjectiveCycle({ objective: 'x', budgetUsd: 0 }))
      .rejects
      .toThrow('budgetUsd must be positive');
  });
});
