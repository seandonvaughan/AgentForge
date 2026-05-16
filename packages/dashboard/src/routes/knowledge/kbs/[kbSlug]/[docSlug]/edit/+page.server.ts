import type { PageServerLoad } from './$types';
import type { KbSSR } from '../../../+page.server.js';
import type { KbDocSSR } from '../../+page.server.js';
import type { KbDocVersionSSR } from '../+page.server.js';

export interface KbDocEditSSR {
  kb: KbSSR | null;
  doc: (KbDocSSR & { body: KbDocVersionSSR | null }) | null;
  error: string | null;
}

export const load: PageServerLoad = async ({ params, fetch }) => {
  const kbSlug = params.kbSlug;
  const docSlug = params.docSlug;
  try {
    const listRes = await fetch('/api/v5/kbs?limit=500');
    if (!listRes.ok) {
      return { kb: null, doc: null, error: `HTTP ${listRes.status}` } satisfies KbDocEditSSR;
    }
    const listJson = (await listRes.json()) as { data: KbSSR[] };
    const kb = listJson.data.find((k) => k.slug === kbSlug) ?? null;
    if (!kb) return { kb: null, doc: null, error: 'KB not found' } satisfies KbDocEditSSR;
    const docRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}`);
    if (!docRes.ok) {
      return { kb, doc: null, error: 'Doc not found' } satisfies KbDocEditSSR;
    }
    const docJson = (await docRes.json()) as {
      data: KbDocSSR & { body: KbDocVersionSSR | null };
    };
    return { kb, doc: docJson.data, error: null } satisfies KbDocEditSSR;
  } catch (e) {
    return {
      kb: null,
      doc: null,
      error: e instanceof Error ? e.message : 'Failed to load doc',
    } satisfies KbDocEditSSR;
  }
};
