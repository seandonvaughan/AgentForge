const FALLBACK = {
    data: [],
    meta: {
        total: 0,
        unread: 0,
        recipient: '@user',
        limit: 100,
        offset: 0,
        timestamp: new Date().toISOString(),
    },
};
export const load = async ({ fetch }) => {
    try {
        const res = await fetch('/api/v5/inbox?recipient=%40user&limit=100');
        if (!res.ok)
            return FALLBACK;
        return (await res.json());
    }
    catch {
        return FALLBACK;
    }
};
