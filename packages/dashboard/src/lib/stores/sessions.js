import { writable } from 'svelte/store';
import { api } from '$api/client.js';
export const sessions = writable([]);
export const sessionsLoading = writable(false);
export const sessionsError = writable(null);
export async function loadSessions(opts) {
    sessionsLoading.set(true);
    sessionsError.set(null);
    try {
        const params = new URLSearchParams();
        if (opts?.limit)
            params.set('limit', String(opts.limit));
        if (opts?.offset)
            params.set('offset', String(opts.offset));
        const qs = params.toString();
        const path = `/sessions${qs ? '?' + qs : ''}`;
        const res = await api.get(path);
        sessions.set(res.data ?? []);
    }
    catch (err) {
        sessionsError.set(err instanceof Error ? err.message : 'Failed to load sessions');
    }
    finally {
        sessionsLoading.set(false);
    }
}
// ---------------------------------------------------------------------------
// Legacy store wrapper — kept so existing components that use
// $sessionsStore.data / sessionsStore.load() continue to work.
// ---------------------------------------------------------------------------
function createSessionsStore() {
    const internal = writable({
        data: [],
        loading: false,
        error: null,
    });
    sessions.subscribe(data => internal.update(s => ({ ...s, data })));
    sessionsLoading.subscribe(loading => internal.update(s => ({ ...s, loading })));
    sessionsError.subscribe(error => internal.update(s => ({ ...s, error })));
    return {
        subscribe: internal.subscribe,
        async load(opts) {
            await loadSessions(opts ?? { limit: 100 });
        },
    };
}
export const sessionsStore = createSessionsStore();
