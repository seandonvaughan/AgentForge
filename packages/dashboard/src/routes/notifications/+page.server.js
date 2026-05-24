export const load = async ({ fetch }) => {
    try {
        const res = await fetch('/api/v5/notifications?limit=100');
        if (!res.ok)
            return { data: [], meta: { total: 0, unread: 0, limit: 100, timestamp: new Date().toISOString() } };
        return (await res.json());
    }
    catch {
        return { data: [], meta: { total: 0, unread: 0, limit: 100, timestamp: new Date().toISOString() } };
    }
};
