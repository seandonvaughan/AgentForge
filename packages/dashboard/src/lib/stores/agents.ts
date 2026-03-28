import { writable, derived } from 'svelte/store';
import { api } from '$api/client.js';

export interface Agent {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  systemPrompt?: string;
  skills?: string[];
  workspaceId?: string;
  // Legacy / extended fields returned by some endpoints
  id?: string;
  role?: string;
  sessionCount?: number;
  successCount?: number;
  totalCostUsd?: number;
  status?: string;
}

export const agents = writable<Agent[]>([]);
export const agentsLoading = writable(false);
export const agentsError = writable<string | null>(null);

export const agentsByModel = derived(agents, $agents => ({
  opus: $agents.filter(a => a.model === 'opus'),
  sonnet: $agents.filter(a => a.model === 'sonnet'),
  haiku: $agents.filter(a => a.model === 'haiku'),
}));

export async function loadAgents(): Promise<void> {
  agentsLoading.set(true);
  agentsError.set(null);
  try {
    const res = await api.get<{ data: Agent[]; meta?: { total: number } }>('/agents');
    agents.set(res.data ?? []);
  } catch (err) {
    agentsError.set(err instanceof Error ? err.message : 'Failed to load agents');
  } finally {
    agentsLoading.set(false);
  }
}

// ---------------------------------------------------------------------------
// Legacy store wrapper — kept so existing components (AgentTable, StatGrid,
// agents/+page.svelte) that use $agentsStore.data / agentsStore.load() still work
// without modification.
// ---------------------------------------------------------------------------
function createAgentsStore() {
  const internal = writable<{ data: Agent[]; loading: boolean; error: string | null }>({
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
