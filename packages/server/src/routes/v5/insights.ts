import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { nowIso } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InsightKind = 'win' | 'risk' | 'shift';

export interface Insight {
  kind: InsightKind;
  title: string;
  body: string;
  metric?: string;
}

export interface InsightsResponse {
  insights: Insight[];
  derivedFrom: number;
  timestamp: string;
}

export interface InsightsOptions {
  adapter?: WorkspaceAdapter;
}

// ---------------------------------------------------------------------------
// Heuristics — derive 3-4 observations from the last N cycles
// ---------------------------------------------------------------------------

interface CycleLike {
  costUsd?: number | null;
  verdict?: string | null;
  model?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
}

function deriveInsights(cycles: CycleLike[]): Insight[] {
  const insights: Insight[] = [];
  if (cycles.length === 0) return insights;

  const recent = cycles.slice(0, 14);

  // ── Cost trend ─────────────────────────────────────────────────────────────
  const withCost = recent.filter(c => typeof c.costUsd === 'number' && c.costUsd !== null) as (CycleLike & { costUsd: number })[];
  if (withCost.length >= 2) {
    const half = Math.floor(withCost.length / 2);
    const avgNew = withCost.slice(0, half).reduce((s, c) => s + c.costUsd, 0) / half;
    const avgOld = withCost.slice(half).reduce((s, c) => s + c.costUsd, 0) / (withCost.length - half);
    const pct = avgOld > 0 ? ((avgNew - avgOld) / avgOld) * 100 : 0;
    if (Math.abs(pct) >= 10) {
      insights.push(
        pct > 0
          ? {
              kind: 'risk',
              title: 'Cost trending up',
              body: `Average cycle cost rose ${pct.toFixed(0)}% over the last ${withCost.length} cycles.`,
              metric: `+${pct.toFixed(1)}%`,
            }
          : {
              kind: 'win',
              title: 'Cost trending down',
              body: `Average cycle cost fell ${Math.abs(pct).toFixed(0)}% over the last ${withCost.length} cycles.`,
              metric: `${pct.toFixed(1)}%`,
            },
      );
    }
  }

  // ── Latest verdict ──────────────────────────────────────────────────────────
  const verdicts = recent.filter(c => c.verdict).map(c => c.verdict as string);
  if (verdicts.length > 0) {
    const latest = verdicts[0];
    const passCount = verdicts.filter(v => v === 'pass' || v === 'approved').length;
    const passRate = verdicts.length > 0 ? (passCount / verdicts.length) * 100 : 0;
    if (passRate >= 80) {
      insights.push({
        kind: 'win',
        title: 'High pass rate',
        body: `${passRate.toFixed(0)}% of recent cycles passed review. Latest: ${latest}.`,
        metric: `${passRate.toFixed(0)}%`,
      });
    } else if (passRate < 50) {
      insights.push({
        kind: 'risk',
        title: 'Low pass rate',
        body: `Only ${passRate.toFixed(0)}% of recent cycles passed. Latest verdict: ${latest}.`,
        metric: `${passRate.toFixed(0)}%`,
      });
    }
  }

  // ── Model mix shift ─────────────────────────────────────────────────────────
  const withModel = recent.filter(c => c.model);
  if (withModel.length >= 4) {
    const half = Math.floor(withModel.length / 2);
    const countOpus = (slice: CycleLike[]) =>
      slice.filter(c => typeof c.model === 'string' && c.model.toLowerCase().includes('opus')).length;
    const opusNew = countOpus(withModel.slice(0, half));
    const opusOld = countOpus(withModel.slice(half));
    if (opusNew > opusOld) {
      insights.push({
        kind: 'shift',
        title: 'Opus usage increasing',
        body: `Opus was used in ${opusNew}/${half} recent cycles vs ${opusOld}/${withModel.length - half} earlier — expect higher costs.`,
        metric: `+${opusNew - opusOld}`,
      });
    } else if (opusNew < opusOld) {
      insights.push({
        kind: 'shift',
        title: 'Opus usage decreasing',
        body: `Opus usage dropped (${opusNew}/${half} recent vs ${opusOld}/${withModel.length - half} earlier) — costs may fall.`,
        metric: `${opusNew - opusOld}`,
      });
    }
  }

  // ── Throughput ──────────────────────────────────────────────────────────────
  if (recent.length >= 7) {
    insights.push({
      kind: 'shift',
      title: 'Cycle volume',
      body: `${recent.length} cycles in view. Steady throughput supports pipeline health.`,
      metric: `${recent.length} cycles`,
    });
  }

  return insights.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function insightsRoutes(
  app: FastifyInstance,
  opts: InsightsOptions = {},
): Promise<void> {
  const { adapter } = opts;

  // GET /api/v5/insights
  app.get('/api/v5/insights', async (_req, reply) => {
    let cycles: CycleLike[] = [];

    if (adapter) {
      try {
        // Best-effort: use adapter to list recent cycles if the method exists
        const raw = (adapter as unknown as { listCycles?: (o: { limit: number }) => CycleLike[] }).listCycles?.({ limit: 14 }) ?? [];
        cycles = raw;
      } catch {
        // adapter may not expose listCycles yet — return empty insights gracefully
      }
    }

    const insights = deriveInsights(cycles);

    const body: InsightsResponse = {
      insights,
      derivedFrom: cycles.length,
      timestamp: nowIso(),
    };

    return reply.send(body);
  });
}
