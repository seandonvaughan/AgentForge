import type { PageServerLoad } from './$types';
import type { KbSSR } from '../../../+page.server.js';
import type { KbDocSSR } from '../../+page.server.js';
import type { KbDocVersionSSR } from '../+page.server.js';

export interface KbDocHistorySSR {
  kb: KbSSR | null;
  doc: KbDocSSR | null;
  versions: KbDocVersionSSR[];
  error: string | null;
}

export const load: PageServerLoad = async ({ params, fetch }) => {
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
      } satisfies KbDocHistorySSR;
    }
    const listJson = (await listRes.json()) as { data: KbSSR[] };
    const kb = listJson.data.find((k) => k.slug === kbSlug) ?? null;
    if (!kb) {
      return { kb: null, doc: null, versions: [], error: 'KB not found' } satisfies KbDocHistorySSR;
    }
    const docRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}`);
    if (!docRes.ok) {
      return { kb, doc: null, versions: [], error: 'Doc not found' } satisfies KbDocHistorySSR;
    }
    const docJson = (await docRes.json()) as { data: KbDocSSR };
    const versRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}/versions`);
    if (!versRes.ok) {
      return {
        kb,
        doc: docJson.data,
        versions: [],
        error: `HTTP ${versRes.status}`,
      } satisfies KbDocHistorySSR;
    }
    const versJson = (await versRes.json()) as { data: KbDocVersionSSR[] };
    return {
      kb,
      doc: docJson.data,
      versions: versJson.data,
      error: null,
    } satisfies KbDocHistorySSR;
  } catch (e) {
    return {
      kb: null,
      doc: null,
      versions: [],
      error: e instanceof Error ? e.message : 'Failed to load history',
    } satisfies KbDocHistorySSR;
  }
};
