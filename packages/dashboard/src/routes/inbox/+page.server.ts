import type { PageServerLoad } from './$types';

export type InboxKind = 'info' | 'warning' | 'action_required';
export type InboxStatus = 'unread' | 'read' | 'archived';

export interface InboxRowSSR {
  id: string;
  body: string;
  kind: InboxKind;
  sourceId: string | null;
  sourceType: string | null;
  threadId: string | null;
  createdAt: string;
  status: InboxStatus;
  readAt: string | null;
}

export interface InboxSSR {
  data: InboxRowSSR[];
  meta: {
    total: number;
    unread: number;
    recipient: string;
    limit: number;
    offset: number;
    timestamp: string;
  };
}

const FALLBACK: InboxSSR = {
  data: [],
  meta: {
    total: 0,
    unread: 0,
    recipient: '@user',
    limit: 100,
    offset: 0,
    timestamp: new Date().toISOString(),
  },
};

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/v5/inbox?recipient=%40user&limit=100');
    if (!res.ok) return FALLBACK;
    return (await res.json()) as InboxSSR;
  } catch {
    return FALLBACK;
  }
};
