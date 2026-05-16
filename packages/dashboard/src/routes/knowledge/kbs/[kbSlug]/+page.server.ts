import type { PageServerLoad } from './$types';
import type { KbSSR } from '../+page.server.js';

export interface KbDocSSR {
  id: string;
  kbId: string;
  slug: string;
  title: string;
  currentVersionId: string | null;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbDetailSSR {
  kb: KbSSR | null;
  docs: KbDocSSR[];
  error: string | null;
}

export const load: PageServerLoad = async ({ params, fetch }) => {
  const slug = params.kbSlug;
  try {
    // KB slug -> KB id by listing and finding match (cheap for v1)
    const listRes = await fetch('/api/v5/kbs?limit=500');
    if (!listRes.ok) {
      return { kb: null, docs: [], error: `HTTP ${listRes.status}` } satisfies KbDetailSSR;
    }
    const listJson = (await listRes.json()) as { data: KbSSR[] };
    const kb = listJson.data.find((k) => k.slug === slug) ?? null;
    if (!kb) {
      return { kb: null, docs: [], error: 'KB not found' } satisfies KbDetailSSR;
    }
    const docsRes = await fetch(`/api/v5/kbs/${kb.id}/docs`);
    if (!docsRes.ok) {
      return { kb, docs: [], error: `HTTP ${docsRes.status}` } satisfies KbDetailSSR;
    }
    const docsJson = (await docsRes.json()) as { data: KbDocSSR[] };
    return { kb, docs: docsJson.data, error: null } satisfies KbDetailSSR;
  } catch (e) {
    return {
      kb: null,
      docs: [],
      error: e instanceof Error ? e.message : 'Failed to load KB',
    } satisfies KbDetailSSR;
  }
};
