/**
 * src/flywheel/memory-stats.ts
 *
 * Standalone, testable implementation of memory loop health computation.
 * Accepts a `projectRoot` parameter so the logic can be unit-tested with
 * temporary fixture directories rather than relying on the real .agentforge/
 * tree. The server route imports this and passes its own PROJECT_ROOT.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-cycle entry count used for the sparkline trend (last ≤10 cycles). */
export interface CycleEntryPoint {
  cycleId: string;
  count: number;
  /** ISO-8601 timestamp from cycle.json; empty string when unreadable. */
  startedAt: string;
}

/** Memory loop health stats rendered in the flywheel dashboard card. */
export interface MemoryStats {
  /** Total JSONL entries across all memory files. */
  totalEntries: number;
  /**
   * Per-cycle entry counts for the last ≤10 cycles that have at least one
   * entry, sorted oldest→newest.
   */
  entriesPerCycleTrend: CycleEntryPoint[];
  /**
   * Fraction [0–1] of *completed* cycles where memory was available to the
   * audit phase.
   *
   * Two-tier computation:
   *   Tier 1 (preferred): audit.json `memoriesInjected` field (written by the
   *     audit phase handler in v9.0.x+). Positive = hit; zero = miss; absent
   *     = fall through to tier 2.
   *   Tier 2 (fallback): timestamp proxy — a cycle "hit" if it started after
   *     the earliest memory entry existed.
   *
   * Only `stage === 'completed'` cycles are included in the denominator so
   * failed or in-flight cycles do not skew the metric.
   */
  hitRate: number;
}

// ---------------------------------------------------------------------------
// Internal shape of raw JSONL entries
// ---------------------------------------------------------------------------

interface RawMemoryEntry {
  id?: string;
  type?: string;
  createdAt?: string;
  /** CycleId of the cycle that wrote this entry. */
  source?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of cycles shown in the sparkline trend. */
const TREND_LIMIT = 10;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute memory loop health statistics from the filesystem under `projectRoot`.
 *
 * @param projectRoot  Absolute path to the project root (the directory that
 *                     contains `.agentforge/`).  Defaults to the repo root
 *                     derived from this file's location so existing callers
 *                     that pass no argument continue to work.
 */
export function computeMemoryStats(projectRoot: string): MemoryStats {
  const EMPTY: MemoryStats = { totalEntries: 0, entriesPerCycleTrend: [], hitRate: 0 };

  const memoryDir = join(projectRoot, '.agentforge/memory');
  const cyclesDir = join(projectRoot, '.agentforge/cycles');

  // ── 1. Read all JSONL memory entries ─────────────────────────────────────
  if (!existsSync(memoryDir)) return EMPTY;

  const allEntries: RawMemoryEntry[] = [];

  try {
    const files = readdirSync(memoryDir).filter(f => f.endsWith('.jsonl'));
    for (const filename of files) {
      try {
        const raw = readFileSync(join(memoryDir, filename), 'utf8');
        for (const line of raw.split('\n').filter(l => l.trim())) {
          try {
            const entry = JSON.parse(line) as RawMemoryEntry;
            if (entry.id && entry.type) allEntries.push(entry);
          } catch { /* skip malformed line */ }
        }
      } catch { /* skip unreadable file */ }
    }
  } catch {
    return EMPTY;
  }

  const totalEntries = allEntries.length;
  if (totalEntries === 0) return EMPTY;

  // ── 2. Build entries-per-cycle trend ─────────────────────────────────────
  // Group entries by source cycleId (entries without a source → 'unknown').
  const countByCycle = new Map<string, number>();
  for (const e of allEntries) {
    const key = e.source ?? 'unknown';
    countByCycle.set(key, (countByCycle.get(key) ?? 0) + 1);
  }

  // Enrich with startedAt from cycle.json for chronological sorting.
  const cyclePoints: CycleEntryPoint[] = [];
  for (const [cycleId, count] of countByCycle) {
    let startedAt = '';
    if (existsSync(cyclesDir)) {
      try {
        const cycleFile = join(cyclesDir, cycleId, 'cycle.json');
        if (existsSync(cycleFile)) {
          const c = JSON.parse(readFileSync(cycleFile, 'utf8')) as { startedAt?: string };
          startedAt = c.startedAt ?? '';
        }
      } catch { /* leave startedAt empty */ }
    }
    cyclePoints.push({ cycleId, count, startedAt });
  }

  // Sort oldest → newest (ISO strings compare lexicographically correctly).
  cyclePoints.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const entriesPerCycleTrend = cyclePoints.slice(-TREND_LIMIT);

  // ── 3. Compute two-tier hit rate ─────────────────────────────────────────
  // Tier 2 needs the timestamp of the earliest ever memory entry.
  const earliestEntryMs = allEntries
    .map(e => (e.createdAt ? new Date(e.createdAt).getTime() : 0))
    .filter(t => t > 0)
    .reduce((min, t) => Math.min(min, t), Infinity);

  let hits = 0;
  let evaluated = 0;

  if (existsSync(cyclesDir)) {
    try {
      for (const dir of readdirSync(cyclesDir)) {
        try {
          const cycleFile = join(cyclesDir, dir, 'cycle.json');
          if (!existsSync(cycleFile)) continue;

          const c = JSON.parse(readFileSync(cycleFile, 'utf8')) as {
            startedAt?: string;
            stage?: string;
          };

          // Only completed cycles count — failed/running cycles haven't gone
          // through the full audit phase and cannot have consumed memory.
          if (c.stage !== 'completed') continue;
          if (!c.startedAt) continue;

          evaluated++;

          // ── Tier 1: explicit memoriesInjected count (v9.0.x+) ──────────
          const auditPath = join(cyclesDir, dir, 'phases', 'audit.json');
          if (existsSync(auditPath)) {
            try {
              const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as {
                memoriesInjected?: number;
              };
              if (typeof audit.memoriesInjected === 'number') {
                if (audit.memoriesInjected > 0) hits++;
                // Explicit signal consumed — skip timestamp proxy.
                continue;
              }
            } catch { /* fall through to tier 2 */ }
          }

          // ── Tier 2: timestamp proxy ─────────────────────────────────────
          // A cycle "hit" if it started after at least one memory entry
          // already existed, meaning the audit phase had context available.
          const startMs = new Date(c.startedAt).getTime();
          if (startMs > earliestEntryMs) hits++;
        } catch { /* skip unreadable cycle dirs */ }
      }
    } catch { /* cyclesDir not iterable */ }
  }

  const hitRate = evaluated > 0 ? hits / evaluated : 0;

  return { totalEntries, entriesPerCycleTrend, hitRate };
}
