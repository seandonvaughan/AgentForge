import type { PageServerLoad } from './$types';

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export interface AuditSSR {
  data: AuditEntry[];
  meta: { total: number; limit: number; timestamp: string };
}

export const load: PageServerLoad = async ({ fetch, url }) => {
  const since = url.searchParams.get('since') ?? undefined;
  const actor = url.searchParams.get('actor') ?? undefined;
  const limit = url.searchParams.get('limit') ?? '100';

  const params = new URLSearchParams({ limit });
  if (since) params.set('since', since);
  if (actor) params.set('actor', actor);

  try {
    const res = await fetch(`/api/v5/audit?${params.toString()}`);
    if (!res.ok) return { data: [], meta: { total: 0, limit: 100, timestamp: new Date().toISOString() } };
    return (await res.json()) as AuditSSR;
  } catch {
    return { data: [], meta: { total: 0, limit: 100, timestamp: new Date().toISOString() } };
  }
};
