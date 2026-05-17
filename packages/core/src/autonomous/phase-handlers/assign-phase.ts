// packages/core/src/autonomous/phase-handlers/assign-phase.ts
//
// v18.0.0 — Phase D routing layer. Capability-tag-aware assignment pass.
//
// When a routing-index.json is present under .agentforge/, inferAssignee()
// calls pickAgent() from the routing layer. If the index is absent or
// corrupt, it falls back to the original 5-keyword logic so old cycles
// continue to work unchanged.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { pickAgent } from '../routing/router.js';
import type { RoutingIndex } from '../routing/routing-index.js';

interface SprintItem {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface SprintFile {
  items?: SprintItem[];
  sprints?: Array<{ items?: SprintItem[] } & Record<string, unknown>>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Per-cycle routing index cache (cleared between cycles via clearRoutingIndexCache)
// ---------------------------------------------------------------------------

let _cachedIndexPath: string | null = null;
let _cachedIndex: RoutingIndex | null = null;

/** Clear the routing index cache — call between cycles or in tests. */
export function clearRoutingIndexCache(): void {
  _cachedIndexPath = null;
  _cachedIndex = null;
}

function loadRoutingIndex(projectRoot: string): RoutingIndex | null {
  const indexPath = join(projectRoot, '.agentforge', 'routing-index.json');
  if (indexPath === _cachedIndexPath && _cachedIndex !== null) {
    return _cachedIndex;
  }
  try {
    const raw = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as RoutingIndex;
    _cachedIndexPath = indexPath;
    _cachedIndex = parsed;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Map a single tag to a candidate assignee, or null. (Unchanged — used as priority-3 fallback.) */
export function inferAssigneeFromTag(tag: string): string | null {
  const t = tag.toLowerCase();
  if (t === 'fix' || t === 'bug' || t === 'security') return 'coder';
  if (t === 'feature' || t === 'new' || t === 'enhancement') return 'coder';
  if (t === 'docs' || t === 'documentation') return 'backend-tech-writer';
  if (t === 'breaking' || t === 'architecture' || t === 'rewrite') return 'architect';
  if (t === 'test' || t === 'qa') return 'backend-qa';
  return null;
}

/**
 * Infer the assignee for a sprint item.
 *
 * When projectRoot is supplied and a routing-index.json exists, delegates to
 * the capability-tag router. Otherwise falls back to 5-keyword logic.
 * The optional projectRoot keeps backward compat with callers that pass only
 * an item.
 */
export function inferAssignee(item: SprintItem, projectRoot?: string): string {
  if (projectRoot) {
    const index = loadRoutingIndex(projectRoot);
    if (index) {
      const result = pickAgent(item, index);
      return result.agentId;
    }
  }
  // Legacy path
  for (const tag of item.tags ?? []) {
    const candidate = inferAssigneeFromTag(tag);
    if (candidate) return candidate;
  }
  return 'coder';
}

export function makeAssignPhaseHandler() {
  return (ctx: PhaseContext) => runAssignPhase(ctx);
}

export async function runAssignPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const phase = 'assign' as const;
  const startedAt = Date.now();

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // New cycles: plan.json in cycle dir. Legacy: .agentforge/sprints/v{N}.json.
  const sprintPath = ctx.cycleId
    ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'plan.json')
    : join(ctx.projectRoot, '.agentforge', 'sprints', `v${ctx.sprintVersion}.json`);

  let assignmentCount = 0;
  const byAgent: Record<string, number> = {};
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const raw = readFileSync(sprintPath, 'utf8');
    const sprintFile = JSON.parse(raw) as SprintFile;
    const sprintObj = sprintFile.items
      ? sprintFile
      : sprintFile.sprints && sprintFile.sprints.length > 0
        ? sprintFile.sprints[0]!
        : null;
    const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];

    // Clear per-cycle cache so each cycle loads a fresh routing index
    clearRoutingIndexCache();

    for (const item of items) {
      if (!item.assignee || item.assignee.trim() === '') {
        item.assignee = inferAssignee(item, ctx.projectRoot);
        assignmentCount += 1;
      }
      byAgent[item.assignee] = (byAgent[item.assignee] ?? 0) + 1;
    }

    writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd: 0,
    agentRuns: [],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'assign.json',
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
            assignmentCount,
            byAgent,
            costUsd: 0,
            durationMs,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // non-fatal
    }
  }

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}
