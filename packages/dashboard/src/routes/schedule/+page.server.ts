import type { PageServerLoad } from './$types';

export interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  cycleConfig: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface SchedulesSSR {
  data: Schedule[];
  meta: { total: number; timestamp: string };
}

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/v5/schedules');
    if (!res.ok) return { data: [], meta: { total: 0, timestamp: new Date().toISOString() } };
    return (await res.json()) as SchedulesSSR;
  } catch {
    return { data: [], meta: { total: 0, timestamp: new Date().toISOString() } };
  }
};
