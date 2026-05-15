import type { PageServerLoad } from './$types';

export type DeliveryStatus = 'success' | 'failure';

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  enabled: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: DeliveryStatus | null;
  createdAt: string;
}

export interface WebhooksSSR {
  data: Webhook[];
  meta: { total: number; timestamp: string };
}

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/v5/webhooks');
    if (!res.ok) return { data: [], meta: { total: 0, timestamp: new Date().toISOString() } };
    return (await res.json()) as WebhooksSSR;
  } catch {
    return { data: [], meta: { total: 0, timestamp: new Date().toISOString() } };
  }
};
