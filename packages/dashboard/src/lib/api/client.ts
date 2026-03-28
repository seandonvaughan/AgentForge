const BASE = '/api/v5';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body?.error ?? body?.message ?? message;
    } catch { /* use default */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path);
  },

  post<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  async del(path: string): Promise<void> {
    await request<unknown>(path, { method: 'DELETE' });
  },

  // Convenience namespaced methods kept for backward compat
  sessions: {
    list: (params?: { limit?: number; offset?: number; agentId?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.offset) q.set('offset', String(params.offset));
      if (params?.agentId) q.set('agentId', params.agentId);
      const qs = q.toString();
      return request<{ data: unknown[]; meta?: { total: number } }>(`/sessions${qs ? '?' + qs : ''}`);
    },
  },
  costs: {
    list: () => request<{ data: unknown[] }>('/costs'),
  },
  agents: {
    list: () =>
      request<{ data: unknown[]; meta?: { total: number } }>('/agents').catch(() => ({ data: [] })),
    get: (id: string) =>
      request<{ data: unknown }>(`/agents/${id}`),
  },
  health: {
    get: () => request<{ status: string; version: string }>('/health'),
  },
};
