import { writable, derived } from 'svelte/store';
import { api } from '$api/client.js';

export interface CostRecord {
  agentId: string;
  model: string;
  totalCostUsd: number;
  sessionCount: number;
  // snake_case aliases that the server may return
  agent_id?: string;
  cost_usd?: number;
  session_count?: number;
}

export const costs = writable<CostRecord[]>([]);
export const costsLoading = writable(false);
export const costsError = writable<string | null>(null);

export const totalUsd = derived(costs, $costs =>
  $costs.reduce((sum, c) => sum + (c.totalCostUsd ?? c.cost_usd ?? 0), 0)
);

export async function loadCosts(): Promise<void> {
  costsLoading.set(true);
  costsError.set(null);
  try {
    const res = await api.get<{ data: CostRecord[] }>('/costs');
    costs.set(res.data ?? []);
  } catch (err) {
    costsError.set(err instanceof Error ? err.message : 'Failed to load costs');
  } finally {
    costsLoading.set(false);
  }
}

// ---------------------------------------------------------------------------
// Legacy store wrapper — kept so existing components that use
// $costStore.data / $costStore.totalUsd / costStore.load() still work.
// ---------------------------------------------------------------------------
function createCostStore() {
  const internal = writable<{ data: CostRecord[]; loading: boolean; error: string | null }>({
    data: [],
    loading: false,
    error: null,
  });

  costs.subscribe(data => internal.update(s => ({ ...s, data })));
  costsLoading.subscribe(loading => internal.update(s => ({ ...s, loading })));
  costsError.subscribe(error => internal.update(s => ({ ...s, error })));

  // Derived totalUsd exposed as a property on the store object so templates
  // can use $costStore.totalUsd as they did before.
  const storeWithTotal = {
    subscribe: internal.subscribe,
    totalUsd,
    async load() {
      await loadCosts();
    },
  };

  return storeWithTotal;
}

export const costStore = createCostStore();
