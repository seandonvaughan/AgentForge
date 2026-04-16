import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { computeMemoryStats, type MemoryStats } from '../../flywheel/memory-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');
const CYCLES_DIR = join(PROJECT_ROOT, '.agentforge/cycles');

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
  /** Trend direction for meta_learning, derived from test pass-rate history. */
  trend?: 'improving' | 'stable' | 'declining';
}

/** Raw aggregate counts surfaced in the dashboard "Loop Data" panel. */
interface FlywheelDebugStats {
  cycleCount: number;
  completedCycleCount: number;
  /** Cycles that started and have a stage field (excludes bare/empty dirs). */
  meaningfulCycleCount: number;
  sprintCount: number;
  totalItems: number;
  completedItems: number;
  agentCount: number;
  sessionCount: number;
  /** Sessions with status 'completed' or 'success'. */
  satisfiedSessionCount: number;
}

/**
 * One data point in the per-cycle trajectory sent to the flywheel dashboard.
 * Exposes the raw signals that drive autonomy and velocity scores so the UI
 * can render sparklines proving the flywheel is self-improving over time.
 */
interface CycleHistoryPoint {
  cycleId: string;
  sprintVersion: string | null;
  startedAt: string;
  stage: string;
  testPassRate: number | null;
  testsTotal: number | null;
  costUsd: number | null;
  durationMs: number | null;
  hasPr: boolean;
}

interface FlywheelV5Response {
  metrics: FlywheelMetric[];
  overallScore: number;
  updatedAt: string;
  memoryStats: MemoryStats;
  debug: FlywheelDebugStats;
  /** Per-cycle raw signals for the score trajectory sparklines. */
  cycleHistory: CycleHistoryPoint[];
}

// ---------------------------------------------------------------------------
// Full cycle record shape (filesystem)
// ---------------------------------------------------------------------------

interface FullCycleRecord {
  cycleId: string;
  sprintVersion?: string;
  stage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  tests?: { passed?: number; failed?: number; total?: number; passRate?: number };
  cost?: { totalUsd?: number };
  git?: { filesChanged?: string[] };
  pr?: { number?: number | null; url?: string | null };
}

// ---------------------------------------------------------------------------
// Filesystem session record (supplements DB adapter data)
// ---------------------------------------------------------------------------

interface FsSessionRecord {
  task_id?: string;
  is_request_satisfied?: boolean;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Cycle history computation
// ---------------------------------------------------------------------------

/**
 * Reads .agentforge/cycles/ to build a chronological list of cycle
 * data-points for the trajectory sparkline panel in the dashboard.
 * This is filesystem-only so it works regardless of DB adapter state.
 */
function computeCycleHistory(cyclesDir: string, limit = 20): {
  cycles: FullCycleRecord[];
  history: CycleHistoryPoint[];
} {
  const cycles: FullCycleRecord[] = [];
  if (existsSync(cyclesDir)) {
    for (const entry of readdirSync(cyclesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cycleFile = join(cyclesDir, entry.name, 'cycle.json');
      if (!existsSync(cycleFile)) continue;
      try {
        cycles.push(JSON.parse(readFileSync(cycleFile, 'utf-8')) as FullCycleRecord);
      } catch { /* skip malformed */ }
    }
  }

  // Sort chronologically (oldest → newest) for trend math
  cycles.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return ta - tb;
  });

  const history: CycleHistoryPoint[] = cycles.slice(-limit).map(c => ({
    cycleId: c.cycleId,
    sprintVersion: c.sprintVersion ?? null,
    startedAt: c.startedAt ?? new Date().toISOString(),
    stage: c.stage ?? 'unknown',
    testPassRate: c.tests?.passRate ?? null,
    testsTotal: (c.tests?.passed != null && c.tests?.failed != null)
      ? (c.tests.passed + c.tests.failed)
      : (c.tests?.total ?? null),
    costUsd: c.cost?.totalUsd ?? null,
    durationMs: c.durationMs ?? null,
    hasPr: c.pr?.number != null,
  }));

  return { cycles, history };
}

// ---------------------------------------------------------------------------
// Filesystem session reader (supplements DB adapter data)
// ---------------------------------------------------------------------------

/**
 * Reads .agentforge/sessions/*.json to provide a session-level success signal
 * when the DB adapter has limited data or hasn't been populated yet.
 */
function readFsSessions(sessionsDir: string): FsSessionRecord[] {
  const sessions: FsSessionRecord[] = [];
  if (!existsSync(sessionsDir)) return sessions;
  for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8')) as FsSessionRecord;
      if (raw.task_id) sessions.push(raw);
    } catch { /* skip malformed */ }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Metric computation helpers
// ---------------------------------------------------------------------------

/**
 * Meta-learning rate: how much is success improving over time?
 *
 * Primary signal (when available): test pass-rate trend across cycles read
 * from the filesystem — the same algorithm used in dashboard-stubs.ts so
 * both API endpoints give consistent numbers.
 *
 * Secondary signal: DB task outcomes (if ≥4 exist).
 * Fallback: overall session success rate from DB or filesystem.
 */
function computeMetaLearning(adapter: SqliteAdapter, projectRoot: string): FlywheelMetric {
  // ── Primary: cycle pass-rate trend (filesystem) ──────────────────────────
  const { cycles: fsCycles } = computeCycleHistory(join(projectRoot, '.agentforge/cycles'), 100);
  const ratedCycles = fsCycles.filter(c => (c.tests?.passRate ?? 0) > 0);

  if (ratedCycles.length >= 2) {
    const half = Math.floor(ratedCycles.length / 2);
    const earlyAvg =
      ratedCycles.slice(0, half).reduce((s, c) => s + (c.tests?.passRate ?? 0), 0) / half;
    const lateAvg =
      ratedCycles.slice(-half).reduce((s, c) => s + (c.tests?.passRate ?? 0), 0) / half;
    const trendBonus = Math.max(-20, Math.min(40, Math.round((lateAvg - earlyAvg) * 400)));
    const sprintCount = (() => {
      const dir = join(projectRoot, '.agentforge/sprints');
      return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).length : 0;
    })();
    const iterationBase = Math.min(100, Math.round((sprintCount / 32) * 60));
    const score = Math.max(0, Math.min(100, iterationBase + trendBonus));
    const trend: 'improving' | 'stable' | 'declining' =
      trendBonus >= 20 ? 'improving' : trendBonus <= -20 ? 'declining' : 'stable';
    return {
      key: 'meta_learning',
      label: 'Meta-Learning',
      score,
      trend,
      description: `${sprintCount} sprint iterations; pass-rate ${trend} across ${ratedCycles.length} cycles`,
    };
  }

  // ── Secondary: DB task outcomes ──────────────────────────────────────────
  try {
    const outcomes = adapter.listTaskOutcomes({ limit: 200 });
    if (outcomes.length >= 4) {
      const mid = Math.floor(outcomes.length / 2);
      const recent = outcomes.slice(0, mid);
      const older = outcomes.slice(mid);
      const recentRate = recent.filter(o => o.success === 1).length / recent.length;
      const olderRate = older.filter(o => o.success === 1).length / older.length;
      const delta = recentRate - olderRate;
      const score = Math.round(Math.min(100, Math.max(0, recentRate * 70 + Math.max(0, delta) * 100)));
      const trend: 'improving' | 'stable' | 'declining' =
        delta > 0.05 ? 'improving' : delta < -0.05 ? 'declining' : 'stable';
      return {
        key: 'meta_learning',
        label: 'Meta-Learning',
        score,
        trend,
        description: `${(recentRate * 100).toFixed(0)}% recent success · ${trend}`,
      };
    }
  } catch { /* adapter unavailable — fall through */ }

  // ── Fallback: session success rate (DB then filesystem) ──────────────────
  let fsSuccessRate: number | null = null;
  const fsSessions = readFsSessions(join(projectRoot, '.agentforge/sessions'));
  if (fsSessions.length > 0) {
    fsSuccessRate = fsSessions.filter(s => s.is_request_satisfied === true).length / fsSessions.length;
  }

  try {
    const sessions = adapter.listSessions();
    if (sessions.length > 0) {
      const successRate =
        sessions.filter(s => s.status === 'completed' || s.status === 'success').length /
        sessions.length;
      // Blend DB rate with filesystem rate when both are available
      const blended = fsSuccessRate !== null ? (successRate + fsSuccessRate) / 2 : successRate;
      return {
        key: 'meta_learning',
        label: 'Meta-Learning',
        score: Math.round(blended * 65),
        description: `${(blended * 100).toFixed(0)}% session success rate`,
      };
    }
  } catch { /* adapter unavailable */ }

  if (fsSuccessRate !== null) {
    return {
      key: 'meta_learning',
      label: 'Meta-Learning',
      score: Math.round(fsSuccessRate * 65),
      description: `${(fsSuccessRate * 100).toFixed(0)}% session success rate (fs)`,
    };
  }

  return { key: 'meta_learning', label: 'Meta-Learning', score: 0, description: 'No data yet' };
}

/**
 * Autonomy score: how autonomous is the loop becoming?
 *
 * Primary signal (filesystem): completed cycles / meaningful cycles — the
 * same algorithm as dashboard-stubs.ts so both endpoints are consistent.
 *
 * Secondary signal (DB): autonomy tier and promotion history from the adapter.
 * Blended 60/40 (cycle signal dominant) when both are available.
 */
function computeAutonomy(adapter: SqliteAdapter, projectRoot: string): FlywheelMetric {
  // ── Primary: cycle completion rate (filesystem) ──────────────────────────
  const { cycles: fsCycles } = computeCycleHistory(join(projectRoot, '.agentforge/cycles'), 100);
  const meaningfulCycles = fsCycles.filter(
    c => c.stage === 'completed' || (c.tests?.passRate ?? 0) > 0,
  );
  const completedCycles = fsCycles.filter(c => c.stage === 'completed');

  // Check filesystem sessions for a sub-cycle autonomy signal
  const fsSessions = readFsSessions(join(projectRoot, '.agentforge/sessions'));
  const fsSatisfied = fsSessions.filter(s => s.is_request_satisfied === true).length;
  const fsSessionRate = fsSessions.length > 0 ? fsSatisfied / fsSessions.length : null;

  if (meaningfulCycles.length > 0) {
    const cycleSuccessRate = completedCycles.length / meaningfulCycles.length;
    const prBonus = completedCycles.some(c => c.pr?.number != null) ? 10 : 0;
    const blendedRate = fsSessionRate !== null
      ? cycleSuccessRate * 0.6 + fsSessionRate * 0.4
      : cycleSuccessRate;
    const score = Math.min(100, Math.round(blendedRate * 90 + prBonus));
    return {
      key: 'autonomy',
      label: 'Autonomy',
      score,
      description: `${completedCycles.length}/${meaningfulCycles.length} cycles; ${fsSatisfied}/${fsSessions.length} sessions satisfied`,
    };
  }

  // ── Secondary: DB promotions + session tiers ─────────────────────────────
  try {
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
    if (score > 0) {
      return {
        key: 'autonomy',
        label: 'Autonomy',
        score,
        description: `Avg tier ${avgTier.toFixed(1)} · ${netPromotions >= 0 ? '+' : ''}${netPromotions} net promotions`,
      };
    }
  } catch { /* adapter unavailable */ }

  // ── Fallback: filesystem sessions only ───────────────────────────────────
  if (fsSessionRate !== null && fsSessions.length >= 3) {
    return {
      key: 'autonomy',
      label: 'Autonomy',
      score: Math.min(40, Math.round(fsSessionRate * 40)),
      description: `${fsSatisfied}/${fsSessions.length} sessions satisfied`,
    };
  }

  return { key: 'autonomy', label: 'Autonomy', score: 0, description: 'No cycle data yet' };
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
// Debug stats computation
// ---------------------------------------------------------------------------

/**
 * Aggregates raw loop counts into the FlywheelDebugStats shape consumed by
 * the dashboard "Loop Data" panel.  All reads are best-effort; failures for
 * any individual source are swallowed and that counter defaults to 0.
 *
 * Accepts projectRoot so it respects workspace routing.
 */
function computeDebugStats(adapter: SqliteAdapter, projectRoot = PROJECT_ROOT): FlywheelDebugStats {
  const cyclesDir = join(projectRoot, '.agentforge/cycles');
  const stats: FlywheelDebugStats = {
    cycleCount: 0,
    completedCycleCount: 0,
    meaningfulCycleCount: 0,
    sprintCount: 0,
    totalItems: 0,
    completedItems: 0,
    agentCount: 0,
    sessionCount: 0,
    satisfiedSessionCount: 0,
  };

  // ── Cycles ────────────────────────────────────────────────────────────────
  if (existsSync(cyclesDir)) {
    try {
      for (const dir of readdirSync(cyclesDir)) {
        try {
          const cycleFile = join(cyclesDir, dir, 'cycle.json');
          if (!existsSync(cycleFile)) continue;
          const c = JSON.parse(readFileSync(cycleFile, 'utf-8')) as { stage?: string };
          stats.cycleCount++;
          if (c.stage) stats.meaningfulCycleCount++;
          if (c.stage === 'completed') stats.completedCycleCount++;
        } catch { /* skip unreadable cycle */ }
      }
    } catch { /* cycles dir unreadable */ }
  }

  // ── Sprints ───────────────────────────────────────────────────────────────
  const sprintsDir = join(projectRoot, '.agentforge/sprints');
  if (existsSync(sprintsDir)) {
    try {
      const files = readdirSync(sprintsDir).filter(f => f.endsWith('.json') && !f.includes('$'));
      stats.sprintCount = files.length;
      for (const f of files) {
        try {
          let raw = JSON.parse(readFileSync(join(sprintsDir, f), 'utf-8'));
          if (typeof raw === 'string') raw = JSON.parse(raw);
          const items: { status: string }[] =
            (raw as { sprints?: [{ items?: { status: string }[] }]; items?: { status: string }[] })
              .sprints?.[0]?.items ??
            (raw as { items?: { status: string }[] }).items ??
            [];
          stats.totalItems += items.length;
          stats.completedItems += items.filter(i => i.status === 'completed').length;
        } catch { /* skip unparseable sprint */ }
      }
    } catch { /* sprints dir unreadable */ }
  }

  // ── Agents ────────────────────────────────────────────────────────────────
  const agentsDir = join(projectRoot, '.agentforge/agents');
  if (existsSync(agentsDir)) {
    try {
      stats.agentCount = readdirSync(agentsDir).filter(f => f.endsWith('.yaml')).length;
    } catch { /* agents dir unreadable */ }
  }

  // ── Sessions — prefer filesystem data; supplement with DB ────────────────
  const fsSessions = readFsSessions(join(projectRoot, '.agentforge/sessions'));
  if (fsSessions.length > 0) {
    stats.sessionCount = fsSessions.length;
    stats.satisfiedSessionCount = fsSessions.filter(s => s.is_request_satisfied === true).length;
  } else {
    try {
      const dbSessions = adapter.listSessions();
      stats.sessionCount = dbSessions.length;
      stats.satisfiedSessionCount = dbSessions.filter(
        s => s.status === 'completed' || s.status === 'success'
      ).length;
    } catch { /* adapter unavailable */ }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function flywheelRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter; projectRoot?: string }
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

  // Resolve the project root for a request — honours ?workspaceId= param so
  // operators can query a non-default workspace from the dashboard dropdown.
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;

  // v5: rich flywheel gauge metrics for the dashboard
  app.get('/api/v5/flywheel', async (_req, reply) => {
    const root = projectRoot;

    try {
      const { history: cycleHistory } = computeCycleHistory(join(root, '.agentforge/cycles'));

      const metrics: FlywheelMetric[] = [
        computeMetaLearning(adapter, root),
        computeAutonomy(adapter, root),
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
        memoryStats: computeMemoryStats(root),
        debug: computeDebugStats(adapter, root),
        cycleHistory,
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
        debug: {
          cycleCount: 0,
          completedCycleCount: 0,
          meaningfulCycleCount: 0,
          sprintCount: 0,
          totalItems: 0,
          completedItems: 0,
          agentCount: 0,
          sessionCount: 0,
          satisfiedSessionCount: 0,
        },
        cycleHistory: [],
      };
      return reply.send({
        data: fallback,
        meta: { computedAt: new Date().toISOString() },
      });
    }
  });
}
