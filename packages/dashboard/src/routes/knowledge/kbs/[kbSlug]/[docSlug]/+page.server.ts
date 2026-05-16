import type { PageServerLoad } from './$types';
import type { KbSSR } from '../../+page.server.js';
import type { KbDocSSR } from '../+page.server.js';

export interface KbDocVersionSSR {
  id: string;
  docId: string;
  version: number;
  bodyMd: string;
  authoredBy: string;
  authoredAt: string;
  commitMessage: string | null;
}

export interface KbDocViewSSR {
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
      return { kb: null, doc: null, error: `HTTP ${listRes.status}` } satisfies KbDocViewSSR;
    }
    const listJson = (await listRes.json()) as { data: KbSSR[] };
    const kb = listJson.data.find((k) => k.slug === kbSlug) ?? null;
    if (!kb) return { kb: null, doc: null, error: 'KB not found' } satisfies KbDocViewSSR;
    const docRes = await fetch(`/api/v5/kbs/${kb.id}/docs/${docSlug}`);
    if (!docRes.ok) {
      if (docRes.status === 404) {
        return { kb, doc: null, error: 'Doc not found' } satisfies KbDocViewSSR;
      }
      return { kb, doc: null, error: `HTTP ${docRes.status}` } satisfies KbDocViewSSR;
    }
    const docJson = (await docRes.json()) as {
      data: KbDocSSR & { body: KbDocVersionSSR | null };
    };
    return { kb, doc: docJson.data, error: null } satisfies KbDocViewSSR;
  } catch (e) {
    return {
      kb: null,
      doc: null,
      error: e instanceof Error ? e.message : 'Failed to load doc',
    } satisfies KbDocViewSSR;
  }
};
