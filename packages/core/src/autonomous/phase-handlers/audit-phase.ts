// packages/core/src/autonomous/phase-handlers/audit-phase.ts
//
// v6.5.2 — Real audit phase handler. Dispatches the researcher agent to
// scan the repo and produce an executive summary + findings list.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

export const AUDIT_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

export interface AuditPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeAuditPhaseHandler(options: AuditPhaseOptions = {}) {
  return (ctx: PhaseContext) => runAuditPhase(ctx, options);
}

export async function runAuditPhase(
  ctx: PhaseContext,
  options: AuditPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'audit' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? AUDIT_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'researcher';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  const task = `You are auditing the AgentForge repository at ${ctx.projectRoot} at the start of sprint v${ctx.sprintVersion}.

Use Read/Glob/Grep/Bash to scan the codebase. Identify:
1. Recent commits (git log --oneline -20)
2. Files with TODO(autonomous) / FIXME(autonomous) markers
3. Tests that are failing (look at recent test output if available)
4. Any cost/performance concerns in the autonomous cycle logs

Produce a 1-paragraph executive summary + a bulleted list of 5-10 concrete findings that should inform sprint planning. Format as markdown.`;

  let findings = '';
  let costUsd = 0;
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    findings = typeof result?.output === 'string' ? result.output : '';
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
    agentRuns: [{ agentId, costUsd, durationMs, response: findings, ...(error ? { error } : {}) }],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'audit.json',
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
            findings,
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
