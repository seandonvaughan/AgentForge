import { writable, derived } from 'svelte/store';
import { api } from '$api/client.js';
export const agents = writable([]);
export const agentsLoading = writable(false);
export const agentsError = writable(null);
export const agentsByModel = derived(agents, $agents => ({
    opus: $agents.filter(a => a.model === 'opus'),
    sonnet: $agents.filter(a => a.model === 'sonnet'),
    haiku: $agents.filter(a => a.model === 'haiku'),
}));
export async function loadAgents() {
    agentsLoading.set(true);
    agentsError.set(null);
    try {
        const res = await api.get('/agents');
        agents.set(res.data ?? []);
    }
    catch (err) {
        agentsError.set(err instanceof Error ? err.message : 'Failed to load agents');
    }
    finally {
        agentsLoading.set(false);
    }
}
// ---------------------------------------------------------------------------
// Legacy store wrapper — kept so existing components (AgentTable, StatGrid,
// agents/+page.svelte) that use $agentsStore.data / agentsStore.load() still work
// without modification.
// ---------------------------------------------------------------------------
function createAgentsStore() {
    const internal = writable({
        data: [],
        loading: false,
        error: null,
    });
    // Mirror the flat stores into this combined store
    agents.subscribe(data => internal.update(s => ({ ...s, data })));
    agentsLoading.subscribe(loading => internal.update(s => ({ ...s, loading })));
    agentsError.subscribe(error => internal.update(s => ({ ...s, error })));
    return {
        subscribe: internal.subscribe,
        async load() {
            await loadAgents();
        },
    };
}
export const agentsStore = createAgentsStore();
