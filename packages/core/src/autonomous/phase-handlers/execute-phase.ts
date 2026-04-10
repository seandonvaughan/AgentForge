// packages/core/src/autonomous/phase-handlers/execute-phase.ts
//
// v6.5.1 — Real execute phase handler.
//
// Reads the sprint JSON written by the plan phase, then dispatches each
// sprint item sequentially to its assignee agent via the RuntimeAdapter.
// Each agent runs `claude -p` with Read/Write/Edit/Bash/Glob/Grep tools
// enabled so it can actually modify files in the working tree. The
// cycle's git stage later picks up those modifications via
// `collectChangedFiles` and commits them.
//
// Per-item failures are tolerated: an individual agent throw marks that
// item failed and the phase moves on. The phase only returns 'failed'
// when more than `config.limits.maxExecutePhaseFailureRate` (default 0.5)
// of items fail. All-failures returns 'blocked'.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

// ---- Memory injection ----
// Reads tag-filtered past failure entries from .agentforge/memory/*.jsonl so
// each agent can avoid mistakes made on similar work in prior cycles.

/**
 * Memory entry shape used by the execute phase for prompt injection.
 *
 * Intentionally broader than `CycleMemoryEntry` from memory/types.ts:
 *  - `id`  — canonical UUID written by writeMemoryEntry / cycle-logger
 *  - `key` — short human-readable slug used in backlog JSONL files and
 *             legacy test data (e.g. 'guard-sprint-items')
 *
 * Both fields are optional so that entries written with either convention
 * parse cleanly. `formatMemorySection` uses `key ?? id ?? type` as the
 * label, ensuring whichever identifier is present appears in the prompt.
 *
 * We keep this type local (rather than re-exporting CycleMemoryEntry)
 * because CycleMemoryEntry has `id: string` as a required field, which
 * would make test entries that only supply `key` fail strict type checks.
 */
export interface MemoryEntry {
  /** UUID produced by writeMemoryEntry (canonical). */
  id?: string;
  /** Short slug used by backlog generators and test fixtures. */
  key?: string;
  type: string;
  value: string;
  createdAt?: string;
  tags?: string[];
  source?: string;
}

/** Types we prioritise when selecting entries to inject into a prompt.
 *  cycle-outcome is skipped — it's high-level and less actionable. */
const PRIORITY_TYPES = new Set(['failure-pattern', 'review-finding', 'gate-verdict', 'learned-fact']);

/**
 * Reads .agentforge/memory/*.jsonl, parses each JSONL line, filters to
 * entries whose tags overlap with `itemTags`, and returns up to `maxEntries`
 * of the most-recent, highest-priority results.
 *
 * Failures are silently tolerated — a missing or corrupt memory dir must
 * never block an execute phase run.
 */
export function readRelevantMemoryEntries(
  projectRoot: string,
  itemTags: string[],
  maxEntries: number = 5,
): MemoryEntry[] {
  const memoryDir = join(projectRoot, '.agentforge', 'memory');
  let files: string[];
  try {
    files = readdirSync(memoryDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // Memory directory doesn't exist yet — that's fine.
    return [];
  }

  const tagSet = new Set(itemTags.map((t) => t.toLowerCase()));
  const all: MemoryEntry[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(memoryDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as MemoryEntry;
        // Only include entries that share at least one tag with the item.
        const entryTags = (entry.tags ?? []).map((t: string) => t.toLowerCase());
        if (tagSet.size > 0 && !entryTags.some((t) => tagSet.has(t))) continue;
        all.push(entry);
      } catch {
        // Malformed line — skip.
      }
    }
  }

  // Prioritize failure-related types, then sort by recency (most recent first).
  all.sort((a, b) => {
    const aPriority = PRIORITY_TYPES.has(a.type) ? 0 : 1;
    const bPriority = PRIORITY_TYPES.has(b.type) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });

  return all.slice(0, maxEntries);
}

/** Formats a list of memory entries as a markdown section suitable for
 *  inclusion in an agent prompt.  Returns an empty string when the list
 *  is empty so callers can safely concatenate without extra whitespace. */
export function formatMemorySection(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    // Value may be a raw string or a JSON-stringified object — normalise to string.
    const value = typeof e.value === 'string' ? e.value : JSON.stringify(e.value, null, 2);
    // Prefer the human-readable `key` slug (used by backlog generators and
    // test fixtures), then fall back to the canonical UUID `id`, then to the
    // entry type so the label is always non-empty.
    const label = e.key ?? e.id ?? e.type;
    return `- [${e.type}] **${label}**: ${value}`;
  });
  return `\n## Memory: Past Failures on Similar Work\n\nThe following entries from prior cycles matched this item's tags. Use them to avoid repeating past mistakes:\n\n${lines.join('\n')}\n`;
}

/** Default tools enabled for execute-phase agent runs. Task is intentionally
 *  excluded to prevent recursive subagent dispatch from burning quota. */
export const EXECUTE_PHASE_DEFAULT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
];

interface SprintItem {
  id: string;
  title: string;
  description?: string;
  assignee: string;
  status: string;
  source?: string;
  tags?: string[];
  /** v6.6.0 — Optional declared file paths the item will touch. If absent,
   *  the FileLockManager falls back to a heuristic regex over title +
   *  description, then to "empty" (conservative — serializes against all). */
  files?: string[];
}

/** v6.6.0 — File-aware lock manager used by the execute-phase dispatch loop.
 *  Items with overlapping file declarations serialize; disjoint items still
 *  run in parallel up to the numeric concurrency cap. Items with no declared
 *  or inferred files are conservative — they only run when nothing else is
 *  in flight. */
export class FileLockManager {
  private readonly heldFiles = new Map<string, string>(); // file → itemId
  private readonly itemsHoldingEmpty = new Set<string>();
  /**
   * v6.7.4: when true, items with no declared files run unconstrained
   * (no lock acquired) so they don't serialize against each other. The
   * old conservative behavior treated empty-files items as "could touch
   * anything", which serialized the entire execute phase down to 1
   * concurrent agent because the scoring agent rarely populates the
   * `files` field on backlog items. This was the root cause of cycles
   * showing only 1-2 active agents even with maxParallelism: 10.
   *
   * Trade-off: file conflicts between unconstrained items are now
   * possible. They surface as git stage failures or test failures and
   * the loop's retry/gate logic catches them. Worth the 5-10x speedup.
   */
  constructor(private readonly optimistic = true) {}

  canAcquire(_itemId: string, files: string[]): boolean {
    if (files.length === 0) {
      if (this.optimistic) return true;
      // Conservative fallback: empty files = "could touch anything" —
      // only run when nothing else is in flight.
      return this.heldFiles.size === 0 && this.itemsHoldingEmpty.size === 0;
    }
    // If any item is currently holding an empty (unknown-files) lock, we
    // must wait — that item could touch any file.
    if (!this.optimistic && this.itemsHoldingEmpty.size > 0) return false;
    return !files.some((f) => this.heldFiles.has(f));
  }

  acquire(itemId: string, files: string[]): void {
    if (files.length === 0) {
      // In optimistic mode, don't track empty-file items at all so they
      // never block other items.
      if (!this.optimistic) this.itemsHoldingEmpty.add(itemId);
      return;
    }
    for (const f of files) this.heldFiles.set(f, itemId);
  }

  release(itemId: string): void {
    this.itemsHoldingEmpty.delete(itemId);
    for (const [f, id] of this.heldFiles.entries()) {
      if (id === itemId) this.heldFiles.delete(f);
    }
  }

  pendingForItem(files: string[]): string[] {
    return files.filter((f) => this.heldFiles.has(f));
  }

  get inFlightCount(): number {
    // For introspection in tests.
    return this.itemsHoldingEmpty.size + new Set(this.heldFiles.values()).size;
  }
}

/** v6.6.0 — Heuristic file extraction. Scans title + description for tokens
 *  that look like file paths with common code/doc extensions. Returns an
 *  empty array if nothing matches. */
export function extractFilesFromItem(item: {
  files?: string[];
  title?: string;
  description?: string;
}): string[] {
  if (item.files && item.files.length > 0) return item.files;
  const haystack = `${item.title ?? ''}\n${item.description ?? ''}`;
  const regex = /[\w\-./]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|ya?ml|json|svelte|css|scss|html)/g;
  const matches = haystack.match(regex);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

interface SprintFile {
  version?: string;
  items?: SprintItem[];
  // Newer wrapped format from sprint-generator: { sprints: [{...}] }
  sprints?: Array<{ version?: string; items?: SprintItem[] } & Record<string, unknown>>;
  [key: string]: unknown;
}

interface ItemResult {
  itemId: string;
  status: 'completed' | 'failed';
  costUsd: number;
  durationMs: number;
  response: string;
  attempts: number;
  error?: string;
}

export interface ExecutePhaseOptions {
  /** Override the default Read/Write/Edit/Bash/Glob/Grep tool list. */
  allowedTools?: string[];
  /** Failure-rate threshold above which the phase returns 'failed'.
   *  Default 0.5. */
  maxFailureRate?: number;
  /** Max concurrent item dispatches. Default 3. */
  maxParallelism?: number;
  /** Max retries per failing item (additional attempts beyond the first).
   *  Default 1 (so each item gets up to 2 total tries). */
  maxItemRetries?: number;
}

export function makeExecutePhaseHandler(options: ExecutePhaseOptions = {}) {
  return (ctx: PhaseContext) => runExecutePhase(ctx, options);
}

export async function runExecutePhase(
  ctx: PhaseContext,
  options: ExecutePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'execute' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? EXECUTE_PHASE_DEFAULT_TOOLS;
  const maxFailureRate = options.maxFailureRate ?? 0.5;
  const ceilingParallelism = Math.max(1, options.maxParallelism ?? 3);
  const maxItemRetries = Math.max(0, options.maxItemRetries ?? 1);

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // ---- Read sprint JSON ----
  const sprintPath = join(
    ctx.projectRoot,
    '.agentforge',
    'sprints',
    `v${ctx.sprintVersion}.json`,
  );

  let raw: string;
  try {
    raw = readFileSync(sprintPath, 'utf8');
  } catch (err) {
    const message = `execute phase: failed to read sprint file at ${sprintPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }

  let sprintFile: SprintFile;
  try {
    sprintFile = JSON.parse(raw) as SprintFile;
  } catch (err) {
    const message = `execute phase: sprint JSON parse error at ${sprintPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }

  // Locate items array (supports both flat and wrapped { sprints: [...] }).
  const sprintObj =
    sprintFile.items
      ? sprintFile
      : sprintFile.sprints && sprintFile.sprints.length > 0
        ? sprintFile.sprints[0]!
        : null;
  const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];

  // ── v6.7.4 Load Assessment ──────────────────────────────────────────────
  // Pick a parallelism that respects BOTH the configured ceiling and the
  // sprint's actual workload. The "team should assess the load" — instead
  // of blindly running at the ceiling, look at item count, declared file
  // overlap, and complexity tags to pick a smarter starting parallelism.
  // Also wires a runtime circuit breaker that halves parallelism mid-phase
  // if items start failing with the rate-limit fingerprint.
  function assessLoad(): { initial: number; rationale: string } {
    const itemCount = items.length;
    if (itemCount === 0) return { initial: 1, rationale: 'no items' };

    // Cap A: never exceed item count
    let cap = Math.min(ceilingParallelism, itemCount);

    // Cap B: complex / heavy items need lower parallelism. Tags like
    // "heavy", "compute", "long-running", "p0" reduce the cap.
    const heavyTags = new Set(['heavy', 'compute', 'long-running', 'architecture']);
    const heavyCount = items.filter((i: any) =>
      Array.isArray(i.tags) && i.tags.some((t: string) => heavyTags.has(t))
    ).length;
    if (heavyCount > itemCount / 2) cap = Math.max(2, Math.floor(cap / 2));

    // Cap C: if MOST items declare overlapping files, dispatch fewer at once
    // (the FileLockManager would serialize them anyway). Cheap heuristic:
    // if every item touches the same directory, lower the cap.
    const allFiles = items.flatMap((i: any) => Array.isArray(i.files) ? i.files : []);
    if (allFiles.length > 0) {
      const dirs = new Set(allFiles.map((f: string) => f.split('/').slice(0, 2).join('/')));
      if (dirs.size <= 2) cap = Math.max(2, Math.min(cap, 3));
    }

    // Cap D: if there are fewer items than the ceiling, no point running at
    // a lower parallelism than item count — but never exceed the configured
    // ceiling (ceilingParallelism). Without the ceiling guard, a user-set
    // maxParallelism: 1 would be silently overridden for ≤3-item sprints.
    if (itemCount <= 3) cap = Math.min(ceilingParallelism, itemCount);

    const rationale = `${itemCount} items, ceiling ${ceilingParallelism}, ${heavyCount} heavy → ${cap} parallel`;
    return { initial: cap, rationale };
  }

  const loadAssessment = assessLoad();
  let maxParallelism = loadAssessment.initial;
  // eslint-disable-next-line no-console
  console.log(`[execute] load assessment: ${loadAssessment.rationale}`);

  // Circuit breaker: track consecutive rate-limit-style failures.
  // If we see N in a row, halve parallelism (down to floor of 1).
  let consecutiveRateLimitFails = 0;
  const RATE_LIMIT_TRIP_THRESHOLD = 3;
  function looksLikeRateLimit(err: string): boolean {
    const lower = err.toLowerCase();
    return lower.includes('rate') || lower.includes('quota') ||
           lower.includes('429') || lower.includes('exited with code 1');
  }
  function recordItemResult(success: boolean, errStr?: string): void {
    if (success) {
      consecutiveRateLimitFails = 0;
      return;
    }
    if (errStr && looksLikeRateLimit(errStr)) {
      consecutiveRateLimitFails++;
      if (consecutiveRateLimitFails >= RATE_LIMIT_TRIP_THRESHOLD && maxParallelism > 1) {
        const newCap = Math.max(1, Math.floor(maxParallelism / 2));
        // eslint-disable-next-line no-console
        console.warn(`[execute] circuit breaker tripped: ${consecutiveRateLimitFails} rate-limit failures in a row, halving parallelism ${maxParallelism} → ${newCap}`);
        maxParallelism = newCap;
        consecutiveRateLimitFails = 0;
      }
    } else {
      consecutiveRateLimitFails = 0;
    }
  }

  let totalCost = 0;
  const liveResults = new Map<string, ItemResult>();

  // Write an incremental execute.json snapshot so the dashboard can show
  // live cost + agent runs during the (long) execute phase instead of
  // waiting until every item finishes. Without this, the cycle detail
  // page's Cost stat stays frozen at ~$0.20 for 20-40 minutes while
  // execute is in flight. Called from the dispatchItem finally block.
  function snapshotExecuteProgress(): void {
    if (!ctx.cycleId) return;
    const snapshotPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
    );
    try {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      const runs = Array.from(liveResults.values());
      writeFileSync(
        snapshotPath,
        JSON.stringify(
          {
            phase: 'execute',
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            status: 'in_progress',
            totalItems: items.length,
            completedItems: runs.filter((r) => r.status === 'completed').length,
            failedItems: runs.filter((r) => r.status === 'failed').length,
            costUsd: totalCost,
            agentRuns: runs,
            itemResults: runs,
            snapshotAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch { /* non-fatal */ }
  }

  // ---- Dispatch items in parallel with numeric + file-lock concurrency ----
  // v6.6.0 — FileLockManager serializes items whose declared (or inferred)
  // files overlap, while still running disjoint items in parallel up to
  // maxParallelism.
  const lockMgr = new FileLockManager();
  const itemFiles = new Map<string, string[]>();
  for (const it of items) itemFiles.set(it.id, extractFilesFromItem(it));

  const dispatchItem = async (item: SprintItem): Promise<ItemResult> => {
    const itemStartedAt = Date.now();
    let lastError: string | undefined;
    let attempts = 0;
    // Mark the item as in_progress and persist immediately so the dashboard
    // Items kanban shows it moving from Planned → In Progress the moment
    // the agent starts. Without this, items jump straight from planned to
    // completed and the "In Progress" column always looks empty even when
    // multiple agents are actively working.
    item.status = 'in_progress';
    try {
      writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
    } catch { /* non-fatal */ }
    try {
      // Read tag-filtered memory entries once per item (before retry loop) so
      // every attempt benefits from the same historical context.
      const memoryEntries = readRelevantMemoryEntries(
        ctx.projectRoot,
        item.tags ?? [],
      );
      for (let attempt = 0; attempt <= maxItemRetries; attempt++) {
        attempts = attempt + 1;
        const task = buildItemPrompt(item, ctx.projectRoot, attempt, lastError, memoryEntries);
        try {
          const result = await ctx.runtime.run(item.assignee, task, {
            allowedTools,
          });
          const durationMs = Date.now() - itemStartedAt;
          const costUsd =
            typeof result?.costUsd === 'number' ? result.costUsd : 0;
          totalCost += costUsd;
          item.status = 'completed';
          const completedResult = {
            itemId: item.id,
            status: 'completed' as const,
            costUsd,
            durationMs,
            response: typeof result?.output === 'string' ? result.output : '',
            attempts,
            agentId: item.assignee,
            // v6.7.4: surface model + effort to the Agents tab
            model: typeof (result as any)?.model === 'string' ? (result as any).model : undefined,
            effort: typeof (result as any)?.effort === 'string' ? (result as any).effort : 'high',
          };
          liveResults.set(item.id, completedResult as ItemResult);
          return completedResult;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt >= maxItemRetries) {
            const durationMs = Date.now() - itemStartedAt;
            item.status = 'failed';
            const failedResult = {
              itemId: item.id,
              status: 'failed' as const,
              costUsd: 0,
              durationMs,
              response: '',
              attempts,
              error: lastError,
              agentId: item.assignee,
            };
            liveResults.set(item.id, failedResult as ItemResult);
            return failedResult;
          }
        }
      }
      // unreachable
      const durationMs = Date.now() - itemStartedAt;
      item.status = 'failed';
      const fallthroughResult = {
        itemId: item.id,
        status: 'failed' as const,
        costUsd: 0,
        durationMs,
        response: '',
        attempts,
        error: lastError ?? 'unknown',
        agentId: item.assignee,
      };
      liveResults.set(item.id, fallthroughResult as ItemResult);
      return fallthroughResult;
    } finally {
      ctx.bus.publish('sprint.phase.item.completed', {
        sprintId: ctx.sprintId,
        phase,
        cycleId: ctx.cycleId,
        itemId: item.id,
        status: item.status,
        completedAt: new Date().toISOString(),
      });
      try {
        writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
      } catch {
        // Non-fatal
      }
      // Update the live execute.json snapshot so the dashboard sees
      // real-time cost + per-agent activity as items complete.
      snapshotExecuteProgress();
      // v6.7.4: feed result into the circuit breaker so a streak of
      // rate-limit failures dynamically halves parallelism.
      const liveResult = liveResults.get(item.id);
      recordItemResult(
        liveResult?.status === 'completed',
        liveResult?.error ?? lastError,
      );
    }
  };

  // Scheduling loop: for each item, wait until both numeric capacity AND
  // the file-lock manager allow dispatch, then launch.
  const inFlight = new Map<Promise<unknown>, string>();
  const settledResults: Array<PromiseSettledResult<ItemResult>> = [];
  const indexById = new Map<string, number>();
  items.forEach((it, idx) => indexById.set(it.id, idx));

  for (const item of items) {
    const files = itemFiles.get(item.id) ?? [];
    while (
      inFlight.size >= maxParallelism ||
      !lockMgr.canAcquire(item.id, files)
    ) {
      await Promise.race(inFlight.keys());
    }
    lockMgr.acquire(item.id, files);
    const p: Promise<unknown> = dispatchItem(item).then(
      (value) => {
        settledResults[indexById.get(item.id)!] = { status: 'fulfilled', value };
        lockMgr.release(item.id);
        inFlight.delete(p);
      },
      (reason) => {
        settledResults[indexById.get(item.id)!] = { status: 'rejected', reason };
        lockMgr.release(item.id);
        inFlight.delete(p);
      },
    );
    inFlight.set(p, item.id);
  }
  await Promise.allSettled(inFlight.keys());
  const settled = settledResults;
  const itemResults: ItemResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const item = items[i]!;
    item.status = 'failed';
    return {
      itemId: item.id,
      status: 'failed',
      costUsd: 0,
      durationMs: 0,
      response: '',
      attempts: 0,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  // ---- Compute phase status ----
  const total = itemResults.length;
  const failed = itemResults.filter((r) => r.status === 'failed').length;
  const completed = total - failed;
  let status: PhaseResult['status'];
  if (total === 0) {
    status = 'completed';
  } else if (failed === total) {
    status = 'blocked';
  } else if (failed / total > maxFailureRate) {
    status = 'failed';
  } else {
    status = 'completed';
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd: totalCost,
    agentRuns: itemResults,
    itemResults,
  };

  // ---- Write phase JSON to cycle log dir ----
  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
    );
    try {
      mkdirSync(dirname(phaseJsonPath), { recursive: true });
      writeFileSync(
        phaseJsonPath,
        JSON.stringify(
          {
            phase,
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            status,
            totalItems: total,
            completedItems: completed,
            failedItems: failed,
            costUsd: totalCost,
            durationMs,
            itemResults,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // Non-fatal — phase result is still emitted via the bus.
    }
  }
  // Suppress unused-import warning for existsSync — kept for future use.
  void existsSync;

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}

function buildItemPrompt(
  item: SprintItem,
  cwd: string,
  attempt: number = 0,
  lastError?: string,
  memoryEntries: MemoryEntry[] = [],
): string {
  const tags =
    item.tags && item.tags.length > 0 ? item.tags.join(', ') : 'none';
  const description = item.description || item.title;
  const source = item.source || 'manual';
  const memorySec = formatMemorySection(memoryEntries);
  const base = `You are working on sprint item "${item.title}" in the AgentForge repository at ${cwd}.

Description: ${description}
Source: ${source} (e.g., TODO(autonomous) marker)
Tags: ${tags}
${memorySec}
Your job: use the Read, Write, Edit, Bash, Glob, and Grep tools to make the code change required to resolve this item. Do NOT commit anything — the autonomous cycle's Git stage will commit everything that changed in the working tree after all items are done.

Work efficiently. Report what you changed when done.`;

  if (attempt > 0 && lastError) {
    return `${base}

PREVIOUS ATTEMPT FAILED:
${lastError}

Please take a different approach. Read the relevant files carefully before making changes.`;
  }
  return base;
}
