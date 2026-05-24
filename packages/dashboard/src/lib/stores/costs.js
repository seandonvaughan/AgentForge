import { writable, derived } from 'svelte/store';
import { api } from '$api/client.js';
export const costs = writable([]);
export const costsLoading = writable(false);
export const costsError = writable(null);
export const totalUsd = derived(costs, $costs => $costs.reduce((sum, c) => sum + (c.totalCostUsd ?? c.cost_usd ?? 0), 0));
export async function loadCosts() {
    costsLoading.set(true);
    costsError.set(null);
    try {
        const res = await api.get('/costs');
        costs.set(res.data ?? []);
    }
    catch (err) {
        costsError.set(err instanceof Error ? err.message : 'Failed to load costs');
    }
    finally {
        costsLoading.set(false);
    }
}
// ---------------------------------------------------------------------------
// Legacy store wrapper — kept so existing components that use
// $costStore.data / $costStore.totalUsd / costStore.load() still work.
// ---------------------------------------------------------------------------
function createCostStore() {
    const internal = writable({
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
