import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContinuousImprovementEntry {
  cycleId: string;
  totalFailures: number;
  failuresPreventableByPriorLearnings: number;
  preventabilityRatio: number;
  /** File mtime ISO string — when the metric was recorded to disk. */
  recordedAt: string;
}

export type TrendDirection = 'improving' | 'flat' | 'regressing' | 'insufficient-data';

export interface ContinuousImprovementMeta {
  total: number;
  since: string;
  rolling7dAvgRatio: number | null;
  trendVsPrior7d: TrendDirection;
  timestamp: string;
}

export interface ContinuousImprovementResponse {
  data: ContinuousImprovementEntry[];
  meta: ContinuousImprovementMeta;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

const FILE_PREFIX = 'continuous-improvement-';
const FILE_SUFFIX = '.json';

/**
 * Read and parse a single continuous-improvement JSON file.
 * Returns null when the file is absent, unreadable, or malformed.
 */
function readMetricFile(
  filePath: string,
  mtimeIso: string,
): ContinuousImprovementEntry | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cycleId =
      typeof parsed['cycleId'] === 'string' ? parsed['cycleId'] : '';
    const totalFailures =
      typeof parsed['totalFailures'] === 'number' ? parsed['totalFailures'] : 0;
    const failuresPreventableByPriorLearnings =
      typeof parsed['failuresPreventableByPriorLearnings'] === 'number'
        ? parsed['failuresPreventableByPriorLearnings']
        : 0;
    const preventabilityRatio =
      typeof parsed['preventabilityRatio'] === 'number'
        ? parsed['preventabilityRatio']
        : 0;

    if (!cycleId) return null;

    return {
      cycleId,
      totalFailures,
      failuresPreventableByPriorLearnings,
      preventabilityRatio,
      recordedAt: mtimeIso,
    };
  } catch {
    return null;
  }
}

/**
 * Load all continuous-improvement metric files from the flywheel directory.
 * Filters by mtime >= sinceMs. Returns entries sorted newest-first.
 */
export function loadContinuousImprovementMetrics(opts: {
  projectRoot: string;
  sinceMs: number;
  limit: number;
}): ContinuousImprovementEntry[] {
  const { projectRoot, sinceMs, limit } = opts;
  const flywheelDir = join(projectRoot, '.agentforge', 'flywheel');

  if (!existsSync(flywheelDir)) return [];

  let files: string[];
  try {
    files = readdirSync(flywheelDir).filter(
      (f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX),
    );
  } catch {
    return [];
  }

  const entries: ContinuousImprovementEntry[] = [];

  for (const fileName of files) {
    const filePath = join(flywheelDir, fileName);
    let mtimeMs: number;
    let mtimeIso: string;
    try {
      const stat = statSync(filePath);
      mtimeMs = stat.mtimeMs;
      mtimeIso = stat.mtime.toISOString();
    } catch {
      continue;
    }

    if (mtimeMs < sinceMs) continue;

    const entry = readMetricFile(filePath, mtimeIso);
    if (entry !== null) entries.push(entry);
  }

  // Sort newest-first by recordedAt
  entries.sort(
    (a, b) =>
      new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );

  return entries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rolling-window math
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ENTRIES_FOR_ROLLING_AVG = 3;
const FLAT_THRESHOLD = 0.02; // ±2% is considered flat

/**
 * Compute the average preventabilityRatio across the given entries.
 * Returns null when the array is empty.
 */
function avgRatio(entries: ContinuousImprovementEntry[]): number | null {
  if (entries.length === 0) return null;
  const sum = entries.reduce((s, e) => s + e.preventabilityRatio, 0);
  return sum / entries.length;
}

/**
 * Derive rolling-7d average and trend from the full (newest-first) entry list.
 *
 * rolling7dAvgRatio — average ratio of entries within the last 7 days.
 *   null when fewer than MIN_ENTRIES_FOR_ROLLING_AVG entries exist in the window.
 *
 * trendVsPrior7d — compares the current 7d window against the preceding 7d.
 *   "improving"  = current avg < prior avg (ratio decreasing = fewer preventable failures = good)
 *   "regressing" = current avg > prior avg
 *   "flat"       = difference within ±FLAT_THRESHOLD
 *   "insufficient-data" = either window has too few entries
 */
export function computeRollingStats(
  entries: ContinuousImprovementEntry[],
  nowMs: number,
): {
  rolling7dAvgRatio: number | null;
  trendVsPrior7d: TrendDirection;
} {
  const currentWindowStart = nowMs - SEVEN_DAYS_MS;
  const priorWindowStart = nowMs - 2 * SEVEN_DAYS_MS;

  const currentWindow = entries.filter((e) => {
    const ts = new Date(e.recordedAt).getTime();
    return ts >= currentWindowStart && ts <= nowMs;
  });

  const priorWindow = entries.filter((e) => {
    const ts = new Date(e.recordedAt).getTime();
    return ts >= priorWindowStart && ts < currentWindowStart;
  });

  const rolling7dAvgRatio =
    currentWindow.length >= MIN_ENTRIES_FOR_ROLLING_AVG
      ? avgRatio(currentWindow)
      : null;

  // Trend comparison
  if (
    currentWindow.length < MIN_ENTRIES_FOR_ROLLING_AVG ||
    priorWindow.length < MIN_ENTRIES_FOR_ROLLING_AVG
  ) {
    return {
      rolling7dAvgRatio,
      trendVsPrior7d: 'insufficient-data',
    };
  }

  const currentAvg = avgRatio(currentWindow)!;
  const priorAvg = avgRatio(priorWindow)!;
  const delta = currentAvg - priorAvg;

  let trendVsPrior7d: TrendDirection;
  if (Math.abs(delta) <= FLAT_THRESHOLD) {
    trendVsPrior7d = 'flat';
  } else if (delta < 0) {
    // Ratio decreasing = more failures being prevented = improving
    trendVsPrior7d = 'improving';
  } else {
    trendVsPrior7d = 'regressing';
  }

  return { rolling7dAvgRatio, trendVsPrior7d };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface FlywheelContinuousImprovementOpts {
  projectRoot?: string;
}

/**
 * Register GET /api/v5/flywheel/continuous-improvement
 *
 * Query params:
 *   since=<ISO>   — only return entries recorded on/after this timestamp
 *                   (default: 30 days ago)
 *   limit=<n>     — cap number of returned entries (default: 100, max: 500)
 */
export function registerFlywheelContinuousImprovementRoutes(
  app: FastifyInstance,
  opts: FlywheelContinuousImprovementOpts = {},
): void {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/flywheel/continuous-improvement
   *
   * Returns per-cycle preventability metrics from
   * `.agentforge/flywheel/continuous-improvement-<cycleId>.json` files,
   * plus a rolling-7d trend computed server-side.
   *
   * A *decreasing* preventabilityRatio over time is the primary
   * autonomy-improving signal — it means prior learnings are catching
   * more failures before they occur.
   */
  app.get('/api/v5/flywheel/continuous-improvement', async (req, reply) => {
    const q = req.query as { since?: string; limit?: string };

    // Parse `since` — default to 30 days ago
    const nowMs = Date.now();
    const defaultSinceMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    let sinceMs: number;
    let sinceIso: string;

    if (q.since) {
      const d = new Date(q.since);
      if (isNaN(d.getTime())) {
        return reply.status(400).send({
          error: 'Invalid `since` parameter — must be an ISO 8601 date string',
          code: 'INVALID_SINCE',
        });
      }
      sinceMs = d.getTime();
      sinceIso = d.toISOString();
    } else {
      sinceMs = defaultSinceMs;
      sinceIso = new Date(defaultSinceMs).toISOString();
    }

    // Parse `limit` — default 100, max 500
    const rawLimit = parseInt(q.limit ?? '100', 10);
    const limit = isNaN(rawLimit)
      ? 100
      : Math.min(Math.max(1, rawLimit), 500);

    // Load entries from disk
    const entries = loadContinuousImprovementMetrics({
      projectRoot,
      sinceMs,
      limit,
    });

    // Compute rolling-7d stats (load all entries in a 14d window for trend)
    const allRecentEntries = loadContinuousImprovementMetrics({
      projectRoot,
      sinceMs: nowMs - 14 * 24 * 60 * 60 * 1000,
      limit: 500,
    });

    const { rolling7dAvgRatio, trendVsPrior7d } = computeRollingStats(
      allRecentEntries,
      nowMs,
    );

    const response: ContinuousImprovementResponse = {
      data: entries,
      meta: {
        total: entries.length,
        since: sinceIso,
        rolling7dAvgRatio,
        trendVsPrior7d,
        timestamp: new Date(nowMs).toISOString(),
      },
    };

    return reply.send(response);
  });
}
