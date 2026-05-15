import { writable } from 'svelte/store';
import { api } from '$api/client.js';

export interface Session {
  id: string;
  agentId: string;
  model: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  // snake_case aliases that the server may return
  agent_id?: string;
  started_at?: string;
  completed_at?: string;
  cost_usd?: number;
}

export const sessions = writable<Session[]>([]);
export const sessionsLoading = writable(false);
export const sessionsError = writable<string | null>(null);

export async function loadSessions(opts?: { limit?: number; offset?: number }): Promise<void> {
  sessionsLoading.set(true);
  sessionsError.set(null);
  try {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const path = `/sessions${qs ? '?' + qs : ''}`;
    const res = await api.get<{ data: Session[]; meta?: { total: number } }>(path);
    sessions.set(res.data ?? []);
  } catch (err) {
    sessionsError.set(err instanceof Error ? err.message : 'Failed to load sessions');
  } finally {
    sessionsLoading.set(false);
  }
}

// ---------------------------------------------------------------------------
// Legacy store wrapper — kept so existing components that use
// $sessionsStore.data / sessionsStore.load() continue to work.
// ---------------------------------------------------------------------------
function createSessionsStore() {
  const internal = writable<{ data: Session[]; loading: boolean; error: string | null }>({
    data: [],
    loading: false,
    error: null,
  });

  sessions.subscribe(data => internal.update(s => ({ ...s, data })));
  sessionsLoading.subscribe(loading => internal.update(s => ({ ...s, loading })));
  sessionsError.subscribe(error => internal.update(s => ({ ...s, error })));

  return {
    subscribe: internal.subscribe,
    async load(opts?: { limit?: number; offset?: number }) {
      await loadSessions(opts ?? { limit: 100 });
    },
  };
}

export const sessionsStore = createSessionsStore();
