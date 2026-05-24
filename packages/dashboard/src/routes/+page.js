async function jsonOrThrow(fetch, url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`${url} → ${res.status}`);
    return (await res.json());
}
async function safe(fetch, url) {
    try {
        const data = await jsonOrThrow(fetch, url);
        return { data, error: null };
    }
    catch (err) {
        return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
}
// ── Load ──────────────────────────────────────────────────────────────────
export const load = async ({ fetch }) => {
    // Run all top-level fetches in parallel so SSR cost is one round-trip.
    const [cyclesRes, countersRes, agentsRes, sessionsRes, costsRes, memoryRes,] = await Promise.all([
        safe(fetch, '/api/v5/cycles?limit=8'),
        safe(fetch, '/api/v5/counters'),
        safe(fetch, '/api/v5/agents'),
        safe(fetch, '/api/v5/sessions?limit=100'),
        safe(fetch, '/api/v5/costs/summary'),
        safe(fetch, '/api/v5/memory'),
    ]);
    return {
        cycles: cyclesRes.data?.cycles ?? [],
        counters: countersRes.data,
        agents: agentsRes.data?.data ?? [],
        sessions: sessionsRes.data?.data ?? [],
        costs: costsRes.data?.data ?? null,
        memoryTotal: memoryRes.data?.meta?.total ?? null,
        errors: {
            cycles: cyclesRes.error,
            counters: countersRes.error,
            agents: agentsRes.error,
            sessions: sessionsRes.error,
            costs: costsRes.error,
            memory: memoryRes.error,
        },
    };
};
