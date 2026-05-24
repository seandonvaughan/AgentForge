const FALLBACK = {
    data: [],
    meta: {
        total: 0,
        limit: 200,
        offset: 0,
        timestamp: new Date().toISOString(),
    },
};
export const load = async ({ fetch }) => {
    try {
        const res = await fetch('/api/v5/kbs?limit=200');
        if (!res.ok)
            return FALLBACK;
        return (await res.json());
    }
    catch {
        return FALLBACK;
    }
};
