// packages/core/src/autonomous/decompose/decompose-objective.ts
//
// Impure orchestrator: invoke the epic-planner agent, parse its EpicPlan JSON,
// run the pure validate+layer core, and on a cyclic / missing-predecessor /
// invalid-JSON result issue exactly one repair retry before failing.
// (spec 2026-05-30 §6.3 + §9.2 fail-loud-not-silent)

import { EpicPlanSchema, type EpicObjective, type EpicPlan } from './types.js';
import { validateAndLayerEpicPlan } from './validate-and-layer.js';
import type { ValidationReport } from './types.js';

export const EPIC_PLANNER_AGENT_ID = 'epic-planner';

/** Minimal runtime contract this orchestrator needs (satisfied by RuntimeAdapter). */
export interface DecomposeRuntime {
  run(
    agentId: string,
    task: string,
    options?: { allowedTools?: string[] },
  ): Promise<{ output: string; costUsd?: number; model?: string }>;
}

export interface DecomposeResult {
  plan: EpicPlan; // children carry computed `wave`
  report: ValidationReport;
  costUsd: number;
  repaired: boolean;
}

export class DecomposeError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid-json' | 'cycle' | 'missing-predecessors' | 'unknown',
    readonly report?: ValidationReport,
  ) {
    super(message);
    this.name = 'DecomposeError';
  }
}

export function buildEpicPlannerPrompt(objective: EpicObjective): string {
  const constraints = objective.constraints?.length
    ? `\n\nConstraints:\n${objective.constraints.map((c) => `- ${c}`).join('\n')}`
    : '';
  return [
    `Decompose this objective into a dependency-ordered EpicPlan.`,
    ``,
    `epicId: ${objective.id}`,
    `Title: ${objective.title}`,
    `Objective: ${objective.description}${constraints}`,
    ``,
    `Output ONLY the JSON object described in your system prompt (a fenced json block is acceptable).`,
    `Use epicId "${objective.id}" exactly. The predecessor graph must be acyclic and every`,
    `predecessor must reference another child id in this plan.`,
  ].join('\n');
}

export function buildRepairPrompt(
  objective: EpicObjective,
  previousOutput: string,
  reason: DecomposeError['reason'],
  report?: ValidationReport,
): string {
  const detail =
    reason === 'cycle'
      ? `Your previous plan had a dependency CYCLE involving: ${report?.cycle?.join(', ') ?? 'unknown'}. Break the cycle.`
      : reason === 'missing-predecessors'
        ? `Your previous plan referenced predecessor ids that do not exist: ${JSON.stringify(report?.missingPredecessors ?? [])}. Use only ids of children present in the plan.`
        : `Your previous output was not a valid EpicPlan JSON object.`;
  return [
    `Your previous decomposition was invalid. ${detail}`,
    ``,
    `Re-output a corrected EpicPlan JSON object for epicId "${objective.id}".`,
    `Output ONLY the JSON object.`,
    ``,
    `--- your previous output (for reference) ---`,
    previousOutput.slice(0, 4000),
  ].join('\n');
}

/** Pull a JSON object out of an LLM response: strips ```json fences, else first {...last }. */
export function extractEpicPlanJson(output: string): unknown {
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1]! : output;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new DecomposeError('no JSON object found in epic-planner output', 'invalid-json');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new DecomposeError('epic-planner output is not valid JSON', 'invalid-json');
  }
}

interface AttemptResult {
  ok: boolean;
  plan?: EpicPlan;
  report?: ValidationReport;
  reason: DecomposeError['reason'];
}

function attempt(output: string): AttemptResult {
  let raw: unknown;
  try {
    raw = extractEpicPlanJson(output);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const parsed = EpicPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-json' };
  const v = validateAndLayerEpicPlan(parsed.data);
  if (v.ok) return { ok: true, plan: v.plan, report: v.report, reason: 'unknown' };
  return { ok: false, reason: v.reason, report: v.report };
}

export async function decomposeObjective(
  objective: EpicObjective,
  runtime: DecomposeRuntime,
): Promise<DecomposeResult> {
  const r1 = await runtime.run(EPIC_PLANNER_AGENT_ID, buildEpicPlannerPrompt(objective), { allowedTools: [] });
  let costUsd = r1.costUsd ?? 0;
  const a1 = attempt(r1.output);
  if (a1.ok) {
    return { plan: a1.plan!, report: a1.report!, costUsd, repaired: false };
  }

  // One repair retry.
  const r2 = await runtime.run(
    EPIC_PLANNER_AGENT_ID,
    buildRepairPrompt(objective, r1.output, a1.reason, a1.report),
    { allowedTools: [] },
  );
  costUsd += r2.costUsd ?? 0;
  const a2 = attempt(r2.output);
  if (a2.ok) {
    return { plan: a2.plan!, report: a2.report!, costUsd, repaired: true };
  }
  throw new DecomposeError(
    `epic-planner produced an invalid decomposition after one repair retry (reason: ${a2.reason})`,
    a2.reason,
    a2.report,
  );
}
