import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const MEMORY_JSONL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.agentforge/memory'
);
const CYCLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.agentforge/cycles'
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

// ---------------------------------------------------------------------------
// v1 shape — legacy session-level metrics
// ---------------------------------------------------------------------------

interface FlywheelMetrics {
  sessionCount: number;
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number;
  modelBreakdown: Record<string, number>;
  recentTrend: 'improving' | 'stable' | 'declining';
}

// ---------------------------------------------------------------------------
// v5 shape — four flywheel gauge metrics
// ---------------------------------------------------------------------------

interface FlywheelMetric {
  key: string;
  label: string;
  score: number; // 0–100
  description: string;
}

/** Per-cycle entry count for the trend sparkline (last ≤10 cycles). */
interface CycleEntryPoint {
  cycleId: string;
  count: number;
  startedAt: string;
}

/** Memory loop health stats shown in the dedicated flywheel card. */
interface MemoryStats {
  /** Total entries across all JSONL files. */
  totalEntries: number;
  /** Entry counts per cycle, oldest→newest, last ≤10 cycles that have entries. */
  entriesPerCycleTrend: CycleEntryPoint[];
  /**
   * Fraction [0–1] of cycles whose audit phase had at least one prior memory
   * entry available to consume. Computed as: for each cycle after the first
   * ever memory write, did that cycle start after ≥1 entry already existed?
   */
  hitRate: number;
}

interface FlywheelV5Response {
  metrics: FlywheelMetric[];
  overallScore: number;
  updatedAt: string;
  memoryStats: MemoryStats;
}

// ---------------------------------------------------------------------------
// Metric computation helpers
// ---------------------------------------------------------------------------

/**
 * Meta-learning rate: how much is success improving over time?
 * Uses task outcomes (preferred) or session success rates as fallback.
 * Score = recent success rate * 70 + improvement delta * 100, capped 0–100.
 */
function computeMetaLearning(adapter: SqliteAdapter): FlywheelMetric {
  const outcomes = adapter.listTaskOutcomes({ limit: 200 });

  if (outcomes.length >= 4) {
    // listTaskOutcomes returns DESC (newest first); split evenly
    const mid = Math.floor(outcomes.length / 2);
    const recent = outcomes.slice(0, mid);
    const older = outcomes.slice(mid);
    const recentRate = recent.filter(o => o.success === 1).length / recent.length;
    const olderRate = older.filter(o => o.success === 1).length / older.length;
    const delta = recentRate - olderRate;
    const score = Math.round(Math.min(100, Math.max(0, recentRate * 70 + Math.max(0, delta) * 100)));
    const trend = delta > 0.05 ? 'improving' : delta < -0.05 ? 'declining' : 'stable';
    return {
      key: 'meta_learning',
      label: 'Meta-Learning',
      score,
      description: `${(recentRate * 100).toFixed(0)}% recent success · ${trend}`,
    };
  }

  // Fallback: overall session success rate
  const sessions = adapter.listSessions();
  if (sessions.length === 0) {
    return { key: 'meta_learning', label: 'Meta-Learning', score: 0, description: 'No data yet' };
  }
  const successRate =
    sessions.filter(s => s.status === 'completed' || s.status === 'success').length /
    sessions.length;
  return {
    key: 'meta_learning',
    label: 'Meta-Learning',
    score: Math.round(successRate * 65),
    description: `${(successRate * 100).toFixed(0)}% session success rate`,
  };
}

/**
 * Autonomy score: how autonomous are agents becoming?
 * 60 pts from avg autonomy tier of recent sessions (tier 1–4 → 0–60).
 * 40 pts from net promotions (each net promotion = 8 pts, max 40).
 */
function computeAutonomy(adapter: SqliteAdapter): FlywheelMetric {
  const promotions = adapter.listPromotions();
  const sessions = adapter.listSessions({ limit: 100 });

  const netPromotions =
    promotions.filter(p => p.promoted === 1).length -
    promotions.filter(p => p.demoted === 1).length;

  const tieredSessions = sessions.filter(s => (s.autonomy_tier ?? 0) > 0);
  const avgTier =
    tieredSessions.length > 0
      ? tieredSessions.reduce((sum, s) => sum + (s.autonomy_tier ?? 1), 0) / tieredSessions.length
      : 1;

  const tierScore = Math.min(60, ((avgTier - 1) / 3) * 60);
  const promotionScore = Math.min(40, Math.max(0, netPromotions * 8));
  const score = Math.round(tierScore + promotionScore);

  return {
    key: 'autonomy',
    label: 'Autonomy',
    score,
    description: `Avg tier ${avgTier.toFixed(1)} · ${netPromotions >= 0 ? '+' : ''}${netPromotions} net promotions`,
  };
}

/**
 * Capability inheritance score: how rich are agent skill sets?
 * Reads agent YAML files from .agentforge/agents/ and counts skills.
 * Target: 5 skills per agent = 100. Scales linearly below that.
 */
function computeInheritance(): FlywheelMetric {
  const agentsDir = join(PROJECT_ROOT, '.agentforge/agents');
  if (!existsSync(agentsDir)) {
    return { key: 'inheritance', label: 'Inheritance', score: 0, description: 'No agents found' };
  }

  const files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
  if (files.length === 0) {
    return { key: 'inheritance', label: 'Inheritance', score: 0, description: 'No agents found' };
  }

  let totalSkills = 0;
  for (const f of files) {
    try {
      const content = readFileSync(join(agentsDir, f), 'utf-8');
      const parsed = yaml.load(content) as { skills?: string[] } | null;
      totalSkills += Array.isArray(parsed?.skills) ? parsed.skills.length : 0;
    } catch {
      // skip unparseable files
    }
  }

  const avgSkills = totalSkills / files.length;
  const score = Math.round(Math.min(100, (avgSkills / 5) * 100));
  return {
    key: 'inheritance',
    label: 'Inheritance',
    score,
    description: `${totalSkills} skills across ${files.length} agents (avg ${avgSkills.toFixed(1)})`,
  };
}

/**
 * Memory stats: total entries, entries-per-cycle trend, and hit rate.
 *
 * Hit rate = fraction of **completed** cycles that actually had memory available
 * when they ran. Computed in two tiers:
 *   1. Precise signal: if the cycle's audit.json contains `memoriesInjected`,
 *      use that count directly (> 0 = hit).  This field is written by the audit
 *      phase handler since v9.0.x.
 *   2. Timestamp proxy fallback: for cycles that pre-date the `memoriesInjected`
 *      field, a cycle "hit" if it started strictly after the earliest memory
 *      entry already existed on disk.
 * Only completed cycles count so failed/running cycles don't skew the metric.
 */
function computeMemoryStats(): MemoryStats {
  const EMPTY: MemoryStats = { totalEntries: 0, entriesPerCycleTrend: [], hitRate: 0 };

  // ── 1. Read all JSONL memory entries ─────────────────────────────────────
  if (!existsSync(MEMORY_JSONL_DIR)) return EMPTY;

  interface RawEntry { id?: string; type?: string; createdAt?: string; source?: string }
  const allEntries: RawEntry[] = [];

  try {
    const files = readdirSync(MEMORY_JSONL_DIR).filter(f => f.endsWith('.jsonl'));
    for (const filename of files) {
      try {
        const raw = readFileSync(join(MEMORY_JSONL_DIR, filename), 'utf8');
        for (const line of raw.split('\n').filter(l => l.trim())) {
          try {
            const e = JSON.parse(line) as RawEntry;
            if (e.id && e.type) allEntries.push(e);
          } catch { /* skip malformed line */ }
        }
      } catch { /* skip unreadable file */ }
    }
  } catch {
    return EMPTY;
  }

  const totalEntries = allEntries.length;
  if (totalEntries === 0) return EMPTY;

  // ── 2. Build entries-per-cycle trend (last 10 cycles with entries) ────────
  // Group by source (cycleId); entries without a source get bucketed as 'unknown'.
  const countByCycle = new Map<string, number>();
  for (const e of allEntries) {
    const key = e.source ?? 'unknown';
    countByCycle.set(key, (countByCycle.get(key) ?? 0) + 1);
  }

  // Cross-reference with cycle.json to get startedAt timestamps
  const cyclePoints: CycleEntryPoint[] = [];
  for (const [cycleId, count] of countByCycle) {
    let startedAt = '';
    if (existsSync(CYCLES_DIR)) {
      try {
        const cycleFile = join(CYCLES_DIR, cycleId, 'cycle.json');
        if (existsSync(cycleFile)) {
          const c = JSON.parse(readFileSync(cycleFile, 'utf8')) as { startedAt?: string };
          startedAt = c.startedAt ?? '';
        }
      } catch { /* cycle file unreadable — leave startedAt empty */ }
    }
    cyclePoints.push({ cycleId, count, startedAt });
  }

  // Sort oldest → newest; cycles without timestamps sort to the front
  cyclePoints.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const entriesPerCycleTrend = cyclePoints.slice(-10);

  // ── 3. Compute hit rate ────────────────────────────────────────────────────
  // The timestamp proxy needs the earliest entry createdAt for comparison.
  const earliestEntryMs = allEntries
    .map(e => e.createdAt ? new Date(e.createdAt).getTime() : 0)
    .filter(t => t > 0)
    .reduce((min, t) => Math.min(min, t), Infinity);

  let hits = 0;
  let evaluated = 0;

  if (existsSync(CYCLES_DIR)) {
    try {
      for (const dir of readdirSync(CYCLES_DIR)) {
        try {
          const cycleFile = join(CYCLES_DIR, dir, 'cycle.json');
          if (!existsSync(cycleFile)) continue;
          const c = JSON.parse(readFileSync(cycleFile, 'utf8')) as {
            startedAt?: string;
            stage?: string;
          };
          // Only completed cycles count in the denominator — failed/running
          // cycles haven't gone through the full audit phase and cannot have
          // consumed memory in a meaningful sense.
          if (c.stage !== 'completed') continue;
          if (!c.startedAt) continue;

          evaluated++;

          // Tier 1: explicit memoriesInjected field from audit.json (v9.0.x+)
          const auditPath = join(CYCLES_DIR, dir, 'phases', 'audit.json');
          if (existsSync(auditPath)) {
            try {
              const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as {
                memoriesInjected?: number;
              };
              if (typeof audit.memoriesInjected === 'number') {
                if (audit.memoriesInjected > 0) hits++;
                continue; // explicit signal consumed — skip timestamp proxy
              }
            } catch { /* fall through to proxy */ }
          }

          // Tier 2: timestamp proxy — hit if cycle started after earliest entry
          const startMs = new Date(c.startedAt).getTime();
          if (startMs > earliestEntryMs) hits++;
        } catch { /* skip unreadable cycles */ }
      }
    } catch { /* cycles dir unreadable */ }
  }

  const hitRate = evaluated > 0 ? hits / evaluated : 0;

  return { totalEntries, entriesPerCycleTrend, hitRate };
}

interface CycleRecord {
  rate: number;
  startedAt: string;
}

/**
 * Velocity score: are we completing work faster cycle-over-cycle?
 * 60 pts from avg sprint item completion rate.
 * 40 pts from cycle test-pass-rate ratio (recent ÷ previous, targeting ≥1.0).
 */
function computeVelocity(): FlywheelMetric {
  const sprintsDir = join(PROJECT_ROOT, '.agentforge/sprints');
  const cyclesDir = join(PROJECT_ROOT, '.agentforge/cycles');

  // Sprint completion rates
  const sprintRates: number[] = [];
  if (existsSync(sprintsDir)) {
    const files = readdirSync(sprintsDir).filter(f => f.endsWith('.json') && !f.includes('$'));
    for (const f of files) {
      try {
        let raw = JSON.parse(readFileSync(join(sprintsDir, f), 'utf-8'));
        // Handle legacy double-encoded JSON
        if (typeof raw === 'string') raw = JSON.parse(raw);
        const items: { status: string }[] =
          (raw as { sprints?: [{ items?: { status: string }[] }]; items?: { status: string }[] })
            .sprints?.[0]?.items ??
          (raw as { items?: { status: string }[] }).items ??
          [];
        if (items.length > 0) {
          sprintRates.push(items.filter(i => i.status === 'completed').length / items.length);
        }
      } catch {
        // skip unparseable sprint files
      }
    }
  }

  // Cycle test pass rates (sorted oldest → newest for ratio computation)
  const cycleRecords: CycleRecord[] = [];
  if (existsSync(cyclesDir)) {
    for (const dir of readdirSync(cyclesDir)) {
      try {
        const cycleFile = join(cyclesDir, dir, 'cycle.json');
        if (!existsSync(cycleFile)) continue;
        const cycle = JSON.parse(readFileSync(cycleFile, 'utf-8')) as {
          tests?: { passRate?: number };
          startedAt?: string;
        };
        if (cycle.tests?.passRate !== undefined && cycle.startedAt) {
          cycleRecords.push({ rate: cycle.tests.passRate, startedAt: cycle.startedAt });
        }
      } catch {
        // skip unreadable cycles
      }
    }
  }

  cycleRecords.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const velocityRatio =
    cycleRecords.length >= 2
      ? (() => {
          const prev = cycleRecords[cycleRecords.length - 2].rate;
          const curr = cycleRecords[cycleRecords.length - 1].rate;
          return prev > 0 ? curr / prev : 1.0;
        })()
      : 1.0;

  const avgCompletion =
    sprintRates.length > 0
      ? sprintRates.reduce((s, r) => s + r, 0) / sprintRates.length
      : 0;

  const completionComponent = Math.min(60, avgCompletion * 60);
  // ratio of 0.8–1.2 maps to 0–40 pts
  const ratioComponent = Math.min(40, Math.max(0, (velocityRatio - 0.8) * 200));
  const score = Math.round(completionComponent + ratioComponent);

  return {
    key: 'velocity',
    label: 'Velocity',
    score,
    description: `${(avgCompletion * 100).toFixed(0)}% sprint completion · ${velocityRatio.toFixed(2)}x cycle ratio`,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function flywheelRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter }
) {
  const { adapter } = opts;

  // v1: legacy session-level metrics (unchanged for backward compatibility)
  app.get('/api/v1/flywheel', async (_req, reply) => {
    try {
      const sessions = adapter.listSessions();
      const costs = adapter.getAllCosts();

      const sessionCount = sessions.length;

      const successCount = sessions.filter(
        s => s.status === 'completed' || s.status === 'success'
      ).length;
      const successRate = sessionCount > 0 ? successCount / sessionCount : 0;

      const totalCostUsd = costs.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);

      const sessionsWithDuration = sessions.filter(s => s.started_at && s.completed_at);
      const avgDurationMs =
        sessionsWithDuration.length > 0
          ? sessionsWithDuration.reduce((sum, s) => {
              const start = new Date(s.started_at).getTime();
              const end = new Date(s.completed_at!).getTime();
              return sum + (end - start);
            }, 0) / sessionsWithDuration.length
          : 0;

      const modelBreakdown: Record<string, number> = {};
      for (const cost of costs) {
        const model = cost.model ?? 'unknown';
        modelBreakdown[model] = (modelBreakdown[model] ?? 0) + cost.cost_usd;
      }

      let recentTrend: 'improving' | 'stable' | 'declining' = 'stable';
      if (sessions.length >= 20) {
        const sorted = [...sessions].sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        const recent = sorted.slice(0, 10);
        const prior = sorted.slice(10, 20);

        const recentSuccess =
          recent.filter(s => s.status === 'completed' || s.status === 'success').length / 10;
        const priorSuccess =
          prior.filter(s => s.status === 'completed' || s.status === 'success').length / 10;

        if (recentSuccess > priorSuccess + 0.05) recentTrend = 'improving';
        else if (recentSuccess < priorSuccess - 0.05) recentTrend = 'declining';
      }

      const metrics: FlywheelMetrics = {
        sessionCount,
        successRate,
        totalCostUsd,
        avgDurationMs,
        modelBreakdown,
        recentTrend,
      };

      return reply.send({
        data: metrics,
        meta: { computedAt: new Date().toISOString() },
      });
    } catch {
      const metrics: FlywheelMetrics = {
        sessionCount: 0,
        successRate: 0,
        totalCostUsd: 0,
        avgDurationMs: 0,
        modelBreakdown: {},
        recentTrend: 'stable',
      };
      return reply.send({
        data: metrics,
        meta: { computedAt: new Date().toISOString() },
      });
    }
  });

  // v5: rich flywheel gauge metrics for the dashboard
  app.get('/api/v5/flywheel', async (_req, reply) => {
    try {
      const metrics: FlywheelMetric[] = [
        computeMetaLearning(adapter),
        computeAutonomy(adapter),
        computeInheritance(),
        computeVelocity(),
      ];

      const overallScore = Math.round(
        metrics.reduce((sum, m) => sum + m.score, 0) / metrics.length
      );

      const response: FlywheelV5Response = {
        metrics,
        overallScore,
        updatedAt: new Date().toISOString(),
        memoryStats: computeMemoryStats(),
      };

      return reply.send({
        data: response,
        meta: { computedAt: new Date().toISOString() },
      });
    } catch {
      const fallback: FlywheelV5Response = {
        metrics: [
          { key: 'meta_learning', label: 'Meta-Learning', score: 0, description: 'Unavailable' },
          { key: 'autonomy', label: 'Autonomy', score: 0, description: 'Unavailable' },
          { key: 'inheritance', label: 'Inheritance', score: 0, description: 'Unavailable' },
          { key: 'velocity', label: 'Velocity', score: 0, description: 'Unavailable' },
        ],
        overallScore: 0,
        updatedAt: new Date().toISOString(),
        memoryStats: { totalEntries: 0, entriesPerCycleTrend: [], hitRate: 0 },
      };
      return reply.send({
        data: fallback,
        meta: { computedAt: new Date().toISOString() },
      });
    }
  });
}
