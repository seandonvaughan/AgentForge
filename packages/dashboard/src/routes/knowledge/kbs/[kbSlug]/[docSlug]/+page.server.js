export const load = async ({ params, fetch }) => {
    const kbSlug = params.kbSlug;
    const docSlug = params.docSlug;
    try {
        const listRes = await fetch('/api/v5/kbs?limit=500');
        if (!listRes.ok) {
            return { kb: null, doc: null, error: `HTTP ${listRes.status}` };
        }
        const listJson = (await listRes.json());
        const kb = listJson.data.find((k) => k.slug === kbSlug) ?? null;
        if (!kb)
            return { kb: null, doc: null, error: 'KB not found' };
        const docRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}`);
        if (!docRes.ok) {
            if (docRes.status === 404) {
                return { kb, doc: null, error: 'Doc not found' };
            }
            return { kb, doc: null, error: `HTTP ${docRes.status}` };
        }
        const docJson = (await docRes.json());
        return { kb, doc: docJson.data, error: null };
    }
    catch (e) {
        return {
            kb: null,
            doc: null,
            error: e instanceof Error ? e.message : 'Failed to load doc',
        };
    }
};
