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
import {
  resolveJobRouting,
  DEFAULT_JOB_ROUTING_POLICY,
  type RoutableJob,
} from '../routing/job-router.js';
import { getProviderAvailability } from '../../runtime/provider-availability.js';
import type { ProviderAvailabilityMap } from '../../runtime/provider-availability.js';
import type { ExecutionProviderKind, RuntimeMode } from '../../runtime/types.js';

interface AssignmentHint {
  agent_id: string;
  model: string;
  skill_ids: string[];
  confidence: number;
}

interface SprintItem {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  tags?: string[];
  files?: string[];
  estimatedComplexity?: 'high' | 'medium' | 'low';
  priorFailureCount?: number;
  assignment_hint?: AssignmentHint;
  // Per-job routing decision written by the assign phase; read by execute.
  preferredProvider?: ExecutionProviderKind;
  runtimeMode?: RuntimeMode;
  tier?: string;
  effort?: string;
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
 * Priority order:
 *   1. Quality-bias hint (from plan-phase pre-hook) — respected UNLESS the
 *      suggested agent's owns_subsystems doesn't intersect the item's touched
 *      paths. Uses String.includes() for capability-tag checks.
 *   2. Capability-tag router (routing-index.json).
 *   3. Legacy 5-keyword fallback.
 *
 * The optional projectRoot keeps backward compat with callers that pass only
 * an item.
 */
export function inferAssignee(item: SprintItem, projectRoot?: string): string {
  // Priority 1: respect quality-bias hint if present and not disabled
  if (
    item.assignment_hint &&
    process.env['AGENTFORGE_NO_QUALITY_BIAS'] !== '1'
  ) {
    const hintAgentId = item.assignment_hint.agent_id;
    // Validate that the suggested agent's subsystems intersect item's touched paths.
    // If no routing index is available we accept the hint unconditionally.
    if (projectRoot) {
      const index = loadRoutingIndex(projectRoot);
      if (index) {
        const agentEntry = index.agents.find((a) => a.id === hintAgentId);
        if (agentEntry) {
          // Use String.includes() for path-prefix checks (no regex on user input)
          const itemText = [item.title ?? '', item.description ?? '', ...(item.tags ?? [])].join(' ');
          const subsystemsIntersect = agentEntry.owns_subsystems.some((subsystem) =>
            itemText.includes(subsystem),
          );
          if (subsystemsIntersect || agentEntry.owns_subsystems.length === 0) {
            return hintAgentId;
          }
          // Hint agent's subsystems don't intersect — fall through to normal routing
        } else {
          // Agent not in index — still accept the hint (forward-compat)
          return hintAgentId;
        }
      } else {
        // No routing index — accept hint unconditionally
        return hintAgentId;
      }
    } else {
      // No projectRoot — accept hint unconditionally
      return hintAgentId;
    }
  }

  // Priority 2: capability-tag router
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

/**
 * Compute and write the per-job routing decision onto a sprint item.
 *
 * Calls the pure `resolveJobRouting` with the supplied availability snapshot
 * and copies the returned fields onto the item so the execute phase reads
 * `item.preferredProvider` / `item.runtimeMode` directly. Existing
 * preferredProvider/runtimeMode hints already on the item (e.g. from scoring)
 * are preserved — routing only fills fields that are not already set.
 */
export function applyJobRouting(
  item: SprintItem,
  availability?: ProviderAvailabilityMap,
): void {
  const job: RoutableJob = {
    id: item.id,
    itemId: item.id,
    title: item.title,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.tags !== undefined ? { tags: item.tags } : {}),
    ...(item.files !== undefined ? { files: item.files } : {}),
    ...(item.estimatedComplexity !== undefined
      ? { estimatedComplexity: item.estimatedComplexity }
      : {}),
    ...(item.priorFailureCount !== undefined
      ? { priorFailureCount: item.priorFailureCount }
      : {}),
  };

  const decision = resolveJobRouting(job, DEFAULT_JOB_ROUTING_POLICY, availability);

  // Preserve any explicit upstream hint; otherwise write the routed decision.
  if (item.preferredProvider === undefined) {
    item.preferredProvider = decision.preferredProvider;
  }
  if (item.runtimeMode === undefined) {
    item.runtimeMode = decision.runtimeMode;
  }
  // tier/effort are audit/metadata fields; always record the routed values.
  item.tier = decision.tier;
  item.effort = decision.effort;
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

    // Per-job routing: derive the best provider/model/effort PER ITEM from the
    // item's own characteristics. Read the availability snapshot once so all
    // items in this plan are routed against the same view; a provider that is
    // down causes the affected items to fall back to their configured
    // alternate rather than the whole cycle picking one global runtime.
    let availability: ProviderAvailabilityMap | undefined;
    try {
      availability = getProviderAvailability();
    } catch {
      // Backward-compatible: if probing fails, route as if all available.
      availability = undefined;
    }

    for (const item of items) {
      if (!item.assignee || item.assignee.trim() === '') {
        item.assignee = inferAssignee(item, ctx.projectRoot);
        assignmentCount += 1;
      }
      applyJobRouting(item, availability);
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
