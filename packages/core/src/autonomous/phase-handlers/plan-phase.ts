// packages/core/src/autonomous/phase-handlers/plan-phase.ts
//
// v6.5.2 — Real plan phase handler. CTO agent reads audit findings and
// the sprint items, produces a technical plan.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

export const PLAN_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

export interface PlanPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

interface SprintItem {
  id: string;
  title: string;
  assignee?: string;
  tags?: string[];
}

export function makePlanPhaseHandler(options: PlanPhaseOptions = {}) {
  return (ctx: PhaseContext) => runPlanPhase(ctx, options);
}

export async function runPlanPhase(
  ctx: PhaseContext,
  options: PlanPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'plan' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? PLAN_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'cto';

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
    const sprintPath = join(
      ctx.projectRoot,
      '.agentforge',
      'sprints',
      `v${ctx.sprintVersion}.json`,
    );
    const raw = readFileSync(sprintPath, 'utf8');
    const parsed = JSON.parse(raw);
    const sprintObj = parsed.items
      ? parsed
      : parsed.sprints && parsed.sprints.length > 0
        ? parsed.sprints[0]
        : null;
    const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];
    if (items.length > 0) {
      itemsList = items
        .map(
          (i, idx) =>
            `${idx + 1}. [${i.id}] ${i.title} (assignee: ${i.assignee ?? 'unassigned'}, tags: ${(i.tags ?? []).join(',') || 'none'})`,
        )
        .join('\n');
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
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    plan = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
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
    agentRuns: [{ agentId, costUsd, durationMs, response: plan, ...(error ? { error } : {}) }],
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
