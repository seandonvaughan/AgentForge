export const load = async ({ params, fetch }) => {
    const kbSlug = params.kbSlug;
    const docSlug = params.docSlug;
    try {
        const listRes = await fetch('/api/v5/kbs?limit=500');
        if (!listRes.ok) {
            return {
                kb: null,
                doc: null,
                versions: [],
                error: `HTTP ${listRes.status}`,
            };
        }
        const listJson = (await listRes.json());
        const kb = listJson.data.find((k) => k.slug === kbSlug) ?? null;
        if (!kb) {
            return { kb: null, doc: null, versions: [], error: 'KB not found' };
        }
        const docRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}`);
        if (!docRes.ok) {
            return { kb, doc: null, versions: [], error: 'Doc not found' };
        }
        const docJson = (await docRes.json());
        const versRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}/versions`);
        if (!versRes.ok) {
            return {
                kb,
                doc: docJson.data,
                versions: [],
                error: `HTTP ${versRes.status}`,
            };
        }
        const versJson = (await versRes.json());
        return {
            kb,
            doc: docJson.data,
            versions: versJson.data,
            error: null,
        };
    }
    catch (e) {
        return {
            kb: null,
            doc: null,
            versions: [],
            error: e instanceof Error ? e.message : 'Failed to load history',
        };
    }
};
