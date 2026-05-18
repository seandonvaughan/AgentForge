// packages/core/src/autonomous/phase-handlers/plan-phase.ts
//
// v6.5.2 — Real plan phase handler. CTO agent reads audit findings and
// the sprint items, produces a technical plan.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { historicalQuality } from '../../scoring/historical-quality.js';

export const PLAN_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

export interface PlanPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
  /** When true, skip the quality-bias pre-hook. Also gated by AGENTFORGE_NO_QUALITY_BIAS=1. */
  noQualityBias?: boolean;
}

export interface AssignmentHint {
  agent_id: string;
  model: string;
  skill_ids: string[];
  confidence: number;
}

interface SprintItem {
  id: string;
  title: string;
  assignee?: string;
  tags?: string[];
  /** Populated by the quality-bias pre-hook when history is available. */
  assignment_hint?: AssignmentHint;
  /** Free-form kind for routing (e.g. 'feature', 'fix', 'docs'). */
  kind?: string;
  /** Capability tags for routing. */
  capabilityTags?: string[];
}

export function makePlanPhaseHandler(options: PlanPhaseOptions = {}) {
  return (ctx: PhaseContext) => runPlanPhase(ctx, options);
}

/**
 * Returns true when the quality-bias pre-hook should run.
 * Disabled by: options.noQualityBias=true OR env AGENTFORGE_NO_QUALITY_BIAS=1.
 */
function isQualityBiasEnabled(options: PlanPhaseOptions): boolean {
  if (options.noQualityBias === true) return false;
  if (process.env['AGENTFORGE_NO_QUALITY_BIAS'] === '1') return false;
  return true;
}

/**
 * preAssignByQualityHistory — pre-hook that annotates sprint items with
 * assignment_hint from historical step-scores before the LLM plan runs.
 *
 * Mutates items in-place. No-op when history is empty or bias is disabled.
 */
export function preAssignByQualityHistory(
  items: SprintItem[],
  projectRoot: string,
  options: PlanPhaseOptions = {},
): void {
  if (!isQualityBiasEnabled(options)) return;

  for (const item of items) {
    const itemKind = item.kind ?? deriveItemKind(item.tags ?? []);
    const capabilityTags = item.capabilityTags ?? item.tags ?? [];

    const suggestions = historicalQuality(projectRoot, itemKind, capabilityTags, 3);
    if (suggestions.length > 0) {
      const top = suggestions[0]!;
      item.assignment_hint = {
        agent_id: top.agent_id,
        model: top.model,
        skill_ids: top.skill_ids,
        confidence: top.confidence,
      };
    }
  }
}

/**
 * Derive a canonical item kind from item tags for history lookup.
 * Uses String.includes() — no regex on user-controlled input.
 */
function deriveItemKind(tags: string[]): string {
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t.includes('fix') || t.includes('bug')) return 'fix';
    if (t.includes('feature') || t.includes('new') || t.includes('enhancement')) return 'feature';
    if (t.includes('test') || t.includes('qa')) return 'test';
    if (t.includes('docs') || t.includes('documentation')) return 'docs';
    if (t.includes('refactor')) return 'refactor';
    if (t.includes('security')) return 'security';
  }
  return 'feature';
}

export async function runPlanPhase(
  ctx: PhaseContext,
  options: PlanPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'plan' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? PLAN_PHASE_DEFAULT_TOOLS;
  // v15.0.0: Planning belongs to the architect, not the CTO. The CTO YAML
  // explicitly states "you do NOT design systems at the implementation level
  // — delegate to the architect." Architect owns system_design + api_design
  // + task_decomposition + dependency_analysis — exactly what plan-phase
  // produces. Override via options.agentId if you want sprint-planner instead.
  const agentId = options.agentId ?? 'architect';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Read audit findings if present
  let auditFindings = '(no audit findings available)';
  if (ctx.cycleId) {
    const auditPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'audit.json',
    );
    try {
      const raw = readFileSync(auditPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.findings === 'string' && parsed.findings.length > 0) {
        auditFindings = parsed.findings;
      }
    } catch {
      // ignore — phase works without audit
    }
  }

  // Read sprint items
  let itemsList = '(no items)';
  try {
    // New cycles: plan.json in cycle dir. Legacy: .agentforge/sprints/v{N}.json.
    const sprintPath = ctx.cycleId
      ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'plan.json')
      : join(ctx.projectRoot, '.agentforge', 'sprints', `v${ctx.sprintVersion}.json`);
    const raw = readFileSync(sprintPath, 'utf8');
    const parsed = JSON.parse(raw);
    const sprintObj = parsed.items
      ? parsed
      : parsed.sprints && parsed.sprints.length > 0
        ? parsed.sprints[0]
        : null;
    const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];
    if (items.length > 0) {
      // Pre-hook: annotate items with quality-biased assignment hints before
      // the LLM plan runs. Mutates items in-place; no-op on empty history.
      preAssignByQualityHistory(items, ctx.projectRoot, options);

      itemsList = items
        .map(
          (i, idx) =>
            `${idx + 1}. [${i.id}] ${i.title} (assignee: ${i.assignee ?? 'unassigned'}, tags: ${(i.tags ?? []).join(',') || 'none'}${i.assignment_hint ? `, hint: ${i.assignment_hint.agent_id} (conf=${i.assignment_hint.confidence.toFixed(2)})` : ''})`,
        )
        .join('\n');

      // Write hints back to plan.json so assign-phase can read them.
      if (sprintObj) {
        try {
          if (sprintObj.items) {
            sprintObj.items = items;
          } else if (parsed.sprints && parsed.sprints.length > 0) {
            parsed.sprints[0].items = items;
          }
          writeFileSync(sprintPath, JSON.stringify(parsed, null, 2));
        } catch {
          // non-fatal — hints not persisted but cycle continues
        }
      }
    }
  } catch {
    // ignore
  }

  const task = `You are the CTO for AgentForge. Sprint v${ctx.sprintVersion} has these candidate items:
${itemsList}

Audit findings (from researcher):
${auditFindings}

Produce a technical plan (markdown, ~300 words) covering:
- Execution order and dependencies between items
- Risk assessment (which items touch core safety paths)
- Team allocation recommendations
- Testing strategy

Do not write code. Plan only.`;

  let plan = '';
  let costUsd = 0;
  let model: string | undefined;
  let effort: string | undefined;
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    plan = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
    if (typeof (result as any)?.model === 'string') model = (result as any).model;
    if (typeof (result as any)?.effort === 'string') effort = (result as any).effort;
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [{ agentId, costUsd, durationMs, response: plan, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(error ? { error } : {}) }],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'plan.json',
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
            agentId,
            plan,
            costUsd,
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
