import type { PageServerLoad } from './$types';

export type InsightKind = 'win' | 'risk' | 'shift';

export interface Insight {
  kind: InsightKind;
  title: string;
  body: string;
  metric?: string;
}

export interface InsightsSSR {
  insights: Insight[];
  derivedFrom: number;
  timestamp: string;
}

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/v5/insights');
    if (!res.ok) return { insights: [], derivedFrom: 0, timestamp: new Date().toISOString() };
    const data = (await res.json()) as InsightsSSR;
    return data;
  } catch {
    return { insights: [], derivedFrom: 0, timestamp: new Date().toISOString() };
  }
};
