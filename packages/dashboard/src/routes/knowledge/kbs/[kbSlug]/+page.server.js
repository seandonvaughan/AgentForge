export const load = async ({ params, fetch }) => {
    const slug = params.kbSlug;
    try {
        // KB slug -> KB id by listing and finding match (cheap for v1)
        const listRes = await fetch('/api/v5/kbs?limit=500');
        if (!listRes.ok) {
            return { kb: null, docs: [], error: `HTTP ${listRes.status}` };
        }
        const listJson = (await listRes.json());
        const kb = listJson.data.find((k) => k.slug === slug) ?? null;
        if (!kb) {
            return { kb: null, docs: [], error: 'KB not found' };
        }
        const docsRes = await fetch(`/api/v5/kbs/${kb.id}/docs`);
        if (!docsRes.ok) {
            return { kb, docs: [], error: `HTTP ${docsRes.status}` };
        }
        const docsJson = (await docsRes.json());
        return { kb, docs: docsJson.data, error: null };
    }
    catch (e) {
        return {
            kb: null,
            docs: [],
            error: e instanceof Error ? e.message : 'Failed to load KB',
        };
    }
};
