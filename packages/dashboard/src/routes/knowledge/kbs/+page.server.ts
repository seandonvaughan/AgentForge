import type { PageServerLoad } from './$types';

export type KbVisibility = 'private' | 'workspace' | 'public';

export interface KbSSR {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  owner: string;
  visibility: KbVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface KbListSSR {
  data: KbSSR[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    timestamp: string;
  };
}

const FALLBACK: KbListSSR = {
  data: [],
  meta: {
    total: 0,
    limit: 200,
    offset: 0,
    timestamp: new Date().toISOString(),
  },
};

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/v5/kbs?limit=200');
    if (!res.ok) return FALLBACK;
    return (await res.json()) as KbListSSR;
  } catch {
    return FALLBACK;
  }
};
