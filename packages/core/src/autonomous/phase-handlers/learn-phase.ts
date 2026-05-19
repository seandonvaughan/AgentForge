// packages/core/src/autonomous/phase-handlers/learn-phase.ts
//
// v6.5.2 — Real learn phase handler. data-analyst writes a retrospective.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

export const LEARN_PHASE_DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];

export interface LearnPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeLearnPhaseHandler(options: LearnPhaseOptions = {}) {
  return (ctx: PhaseContext) => runLearnPhase(ctx, options);
}

function tryReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function runLearnPhase(
  ctx: PhaseContext,
  options: LearnPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'learn' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? LEARN_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'data-analyst';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Build a cycle data summary from whatever phase JSONs exist
  const summary: Record<string, unknown> = {};
  if (ctx.cycleId) {
    const phasesDir = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
    );
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate']) {
      const j = tryReadJson(join(phasesDir, `${name}.json`));
      if (j) {
        summary[name] = {
          status: j.status ?? 'unknown',
          costUsd: j.costUsd ?? 0,
          durationMs: j.durationMs ?? 0,
        };
      }
    }
    const cycleJson = tryReadJson(
      join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'cycle.json'),
    );
    if (cycleJson) summary.cycle = { stage: cycleJson.stage };
  }

  const task = `You are the data-analyst for AgentForge. Sprint v${ctx.sprintVersion} has completed. Return a retrospective (markdown, ~400 words) covering:

1. What went well (specific items, specific agents)
2. What failed or underperformed (with root cause guesses)
3. Cost vs. expected — were estimates accurate?
4. Test results — any flaky or concerning tests?
5. Recommendations for the next cycle (concrete items to add to the backlog)

Return the markdown as your final answer only. Do not create, edit, delete, or append any files; AgentForge persists your response into cycle artifacts.

Cycle data summary:
${JSON.stringify(summary, null, 2)}

Format as markdown with section headers.`;

  let retrospective = '';
  let costUsd = 0;
  let model: string | undefined;
  let effort: string | undefined;
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, {
      allowedTools,
      codexSandbox: 'read-only',
    });
    retrospective = typeof result?.output === 'string' ? result.output : '';
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
    agentRuns: [{ agentId, costUsd, durationMs, response: retrospective, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(error ? { error } : {}) }],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'learn.json',
    );
    try {
      mkdirSync(dirname(phaseJsonPath), { recursive: true });
      const retrospectivePath = join(
        ctx.projectRoot,
        '.agentforge',
        'cycles',
        ctx.cycleId,
        'retrospective.md',
      );
      writeFileSync(retrospectivePath, retrospective, 'utf8');
      writeFileSync(
        phaseJsonPath,
        JSON.stringify(
          {
            phase,
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            agentId,
            retrospectivePath,
            retrospective,
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
