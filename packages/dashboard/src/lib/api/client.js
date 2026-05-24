const BASE = '/api/v5';
async function request(path, options) {
    const res = await fetch(`${BASE}${path}`, options);
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            message = body?.error ?? body?.message ?? message;
        }
        catch { /* use default */ }
        throw new Error(message);
    }
    return res.json();
}
export const api = {
    get(path) {
        return request(path);
    },
    post(path, body) {
        return request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    },
    async del(path) {
        await request(path, { method: 'DELETE' });
    },
    // Convenience namespaced methods kept for backward compat
    sessions: {
        list: (params) => {
            const q = new URLSearchParams();
            if (params?.limit)
                q.set('limit', String(params.limit));
            if (params?.offset)
                q.set('offset', String(params.offset));
            if (params?.agentId)
                q.set('agentId', params.agentId);
            const qs = q.toString();
            return request(`/sessions${qs ? '?' + qs : ''}`);
        },
    },
    costs: {
        list: () => request('/costs'),
    },
    agents: {
        list: () => request('/agents').catch(() => ({ data: [] })),
        get: (id) => request(`/agents/${id}`),
    },
    health: {
        get: () => request('/health'),
    },
};
