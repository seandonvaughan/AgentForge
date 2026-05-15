import type { PageServerLoad } from './$types';

export type NotificationKind = 'info' | 'warning' | 'action_required';

export interface Notification {
  id: string;
  ts: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationsSSR {
  data: Notification[];
  meta: { total: number; unread: number; limit: number; timestamp: string };
}

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/v5/notifications?limit=100');
    if (!res.ok) return { data: [], meta: { total: 0, unread: 0, limit: 100, timestamp: new Date().toISOString() } };
    return (await res.json()) as NotificationsSSR;
  } catch {
    return { data: [], meta: { total: 0, unread: 0, limit: 100, timestamp: new Date().toISOString() } };
  }
};
