export const load = async ({ fetch }) => {
    try {
        const res = await fetch('/api/v5/webhooks');
        if (!res.ok)
            return { data: [], meta: { total: 0, timestamp: new Date().toISOString() } };
        return (await res.json());
    }
    catch {
        return { data: [], meta: { total: 0, timestamp: new Date().toISOString() } };
    }
};
