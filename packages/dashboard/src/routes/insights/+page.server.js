export const load = async ({ fetch }) => {
    try {
        const res = await fetch('/api/v5/insights');
        if (!res.ok)
            return { insights: [], derivedFrom: 0, timestamp: new Date().toISOString() };
        const data = (await res.json());
        return data;
    }
    catch {
        return { insights: [], derivedFrom: 0, timestamp: new Date().toISOString() };
    }
};
