// packages/core/src/autonomous/decompose/decompose-objective.ts
//
// Impure orchestrator: invoke the epic-planner agent, parse its EpicPlan JSON,
// run the pure validate+layer core, and on a cyclic / missing-predecessor /
// invalid-JSON result issue exactly one repair retry before failing.
// (spec 2026-05-30 §6.3 + §9.2 fail-loud-not-silent)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EpicPlanSchema, type EpicObjective, type EpicPlan } from './types.js';
import { validateAndLayerEpicPlan } from './validate-and-layer.js';
import type { ValidationReport } from './types.js';
import type { AgentOutputSchema } from '../../runtime/types.js';

export const EPIC_PLANNER_AGENT_ID = 'epic-planner';

/**
 * Structured-output contract for the decomposition (mirrors EpicPlanSchema).
 * Threaded through runtime.run so the SDK transport validates + retries once
 * and the CLI transport bakes "You MUST return a JSON object matching: <schema>"
 * into the system prompt. This is what keeps the plan parseable even when the
 * provider falls back to a smaller model under plan-capacity pressure — the
 * $50 acceptance run failed exactly here when opus→haiku fallback produced
 * unparseable output twice (cycle 441c037f, reason: invalid-json).
 *
 * `files`/`capabilityTags`/`predecessors` are zod-defaulted so they are not
 * required here; `wave` is layering-internal and deliberately absent (the
 * schemas are .strict(), so a model emitting it would fail validation).
 */
export const EPIC_PLAN_OUTPUT_SCHEMA: AgentOutputSchema = {
  name: 'epic_plan',
  description: 'Dependency-ordered decomposition of one operator objective into child work items.',
  schema: {
    type: 'object',
    properties: {
      epicId: { type: 'string' },
      rationale: { type: 'string' },
      children: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            capabilityTags: { type: 'array', items: { type: 'string' } },
            suggestedAssignee: { type: 'string' },
            estimatedCostUsd: { type: 'number' },
            estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'] },
            predecessors: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'title', 'description', 'suggestedAssignee', 'estimatedCostUsd', 'estimatedComplexity'],
          additionalProperties: false,
        },
      },
    },
    required: ['epicId', 'rationale', 'children'],
    additionalProperties: false,
  },
  strict: true,
};

/** Minimal runtime contract this orchestrator needs (satisfied by RuntimeAdapter). */
export interface DecomposeRuntime {
  run(
    agentId: string,
    task: string,
    options?: {
      allowedTools?: string[];
      outputSchema?: AgentOutputSchema;
      /** Codex sandbox hint — the planner only ever explores read-only. */
      codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    },
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
    readonly reason: 'invalid-json' | 'cycle' | 'missing-predecessors' | 'budget' | 'unknown',
    readonly report?: ValidationReport,
    /** LLM spend already incurred before the failure (both planner calls). */
    readonly costUsd?: number,
  ) {
    super(message);
    this.name = 'DecomposeError';
  }
}

/**
 * Pure budget math (P0.3). Spendable funds, after carving out judgment overhead
 * and a fix-up reserve, is what the planner's children may sum to:
 *
 *   spendable = (budgetUsd − 6) / 1.2
 *
 * The $6 is fixed gate/judgment overhead; dividing by 1.2 reserves 20% of the
 * remaining funds for fix-up work. Always returns a non-negative number.
 */
export function computeSpendableUsd(budgetUsd: number): number {
  return Math.max(0, (budgetUsd - 6) / 1.2);
}

export function buildEpicPlannerPrompt(
  objective: EpicObjective,
  observed?: ObservedChildCosts | null,
): string {
  const constraints = objective.constraints?.length
    ? `\n\nConstraints:\n${objective.constraints.map((c) => `- ${c}`).join('\n')}`
    : '';
  const budget =
    objective.budgetUsd !== undefined
      ? buildBudgetPromptBlock(objective.budgetUsd, observed)
      : '';
  return [
    `Decompose this objective into a dependency-ordered EpicPlan.`,
    ``,
    `epicId: ${objective.id}`,
    `Title: ${objective.title}`,
    `Objective: ${objective.description}${constraints}`,
    ``,
    // The exact output contract lives HERE in the task (not only in the agent
    // YAML) so decomposition works on fresh repos whose forged epic-planner
    // prompt was never hand-tuned, and under provider model fallback. The
    // outputSchema threaded via runtime.run enforces the same shape at the
    // transport layer.
    `Output ONLY a JSON object of this exact shape (a fenced json block is acceptable):`,
    `{`,
    `  "epicId": "${objective.id}",`,
    `  "rationale": "<2-4 sentences on how you split the work>",`,
    `  "children": [`,
    `    {`,
    `      "id": "child-1",`,
    `      "title": "<imperative, specific>",`,
    `      "description": "<what to build + acceptance criteria + the CONSUMER that exercises it>",`,
    `      "files": ["src/.../file.ts"],`,
    `      "capabilityTags": ["<specific tag>"],`,
    `      "suggestedAssignee": "<an agent id, e.g. coder>",`,
    `      "estimatedCostUsd": 5,`,
    `      "estimatedComplexity": "low|medium|high",`,
    `      "predecessors": ["<child ids this depends on>"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Use epicId "${objective.id}" exactly. The predecessor graph must be acyclic and every`,
    `predecessor must reference another child id in this plan.`,
    ``,
    // Scope discipline: the per-child verifier (P0.5) auto-fails any child that
    // edits a file missing from its files[] — including innocent shared-barrel
    // updates (src/index.ts), which failed 4/4 children on cycle 11955f95.
    `files[] is an ENFORCED contract: each child may edit ONLY the files it declares, and a`,
    `deterministic verifier fails any child that touches an undeclared file. Therefore declare`,
    `EVERY file the child will edit — including shared barrel/index export files (e.g.`,
    `src/index.ts), config, and README updates. When several children would all touch the same`,
    `shared file (a barrel, a CLI dispatcher), do NOT have them race on it: leave it out of the`,
    `parallel children and route ALL shared-file edits to one later integration child that`,
    `depends on them.`,
    ``,
    // Path grounding (cycle c5e6efb9): a planner that guesses paths produces
    // children that honor the scope contract by REFUSING to work. Ground every
    // declared path in the actual tree before emitting the plan.
    `GROUND EVERY PATH: use your Read/Glob/Grep tools to explore the repository BEFORE`,
    `planning, and verify that EVERY existing file you put in files[] actually exists at that`,
    `exact path. A child told to edit a nonexistent file will refuse and fail. Files a child`,
    `will CREATE are allowed only when the description explicitly says the file is new and its`,
    `parent directory exists. Do not guess paths from convention — check them.${budget}`,
  ].join('\n');
}

/**
 * Per-repo observed child costs, read from prior cycles' spend-report.json
 * artifacts (P0.8 writes one per completed cycle). This is the calibration
 * flywheel's read side: the $50 acceptance run measured actual gpt-5.5
 * children at $2.13–4.49 against a $7–11 planned table (codex-era forensics),
 * i.e. ~3× over-estimation → 30% budget utilization. When observations exist
 * for THIS repo they are surfaced to the planner alongside the static table.
 */
export interface ObservedChildCosts {
  /** Number of completed child items with a positive recorded actual. */
  count: number;
  medianUsd: number;
  meanUsd: number;
}

export function loadObservedChildCosts(projectRoot: string): ObservedChildCosts | null {
  const actuals: number[] = [];
  try {
    const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
    for (const entry of readdirSync(cyclesDir)) {
      try {
        const report = JSON.parse(
          readFileSync(join(cyclesDir, entry, 'spend-report.json'), 'utf8'),
        ) as { perItem?: Array<{ actualUsd?: unknown; status?: unknown }> };
        for (const item of report.perItem ?? []) {
          if (
            item &&
            item.status === 'completed' &&
            typeof item.actualUsd === 'number' &&
            item.actualUsd > 0
          ) {
            actuals.push(item.actualUsd);
          }
        }
      } catch {
        // cycle without a spend report (failed/legacy) — skip
      }
    }
  } catch {
    return null; // no cycles dir — fresh repo
  }
  if (actuals.length === 0) return null;
  actuals.sort((a, b) => a - b);
  const mid = Math.floor(actuals.length / 2);
  const medianUsd =
    actuals.length % 2 === 1 ? actuals[mid]! : (actuals[mid - 1]! + actuals[mid]!) / 2;
  const meanUsd = actuals.reduce((s, v) => s + v, 0) / actuals.length;
  return { count: actuals.length, medianUsd, meanUsd };
}

/**
 * Budget-sizing addendum for the planner prompt (P0.3). Returned as a leading-
 * newline block so it can be appended to the final prompt line without altering
 * the no-budget output (which never calls this). Shows the computed spendable
 * number, the calibrated cost table, per-repo observed actuals when available,
 * the spend band, and the consumer rule.
 */
function buildBudgetPromptBlock(budgetUsd: number, observed?: ObservedChildCosts | null): string {
  const spendable = computeSpendableUsd(budgetUsd);
  const lower = 0.7 * spendable;
  const upper = 1.0 * spendable;
  // Static table re-fit 2026-06-06 from the $50 acceptance run: gpt-5.5
  // children on a small repo ran $2.13–4.49 actual vs the codex-era $7.30
  // medium / $15–30 feature predictions. Large-monorepo children carry more
  // context, so the feature ceiling stays conservative rather than scaled
  // fully down. Per-repo observations (below) override this table over time.
  const observedLines =
    observed && observed.count > 0
      ? [
          ``,
          `OBSERVED in this repository (${observed.count} completed child item(s) from prior cycles): ` +
            `median $${observed.medianUsd.toFixed(2)}, mean $${observed.meanUsd.toFixed(2)} per child. ` +
            `Weight these observed actuals OVER the static table when estimating.`,
        ]
      : [];
  return [
    ``,
    ``,
    `BUDGET — size this plan to fill the money it is given.`,
    `Cycle budget: $${budgetUsd.toFixed(2)}.`,
    `Spendable = (budget − 6 judgment overhead) / 1.2 (20% fix-up reserve) = $${spendable.toFixed(2)}.`,
    ``,
    `Calibrated child cost table (re-fit 2026-06-06 from measured epic cycles — use these to estimate estimatedCostUsd):`,
    `- small (tests / wiring / docs): ~$1.50, ~2 min.`,
    `- medium (one module + its tests): ~$3.50, ~8 min.`,
    `- feature-child (multi-file + tests): $5–12, 20–40 min; large-monorepo children trend toward the top of this range.`,
    ...observedLines,
    ``,
    `The sum of every child's estimatedCostUsd MUST land between ` +
      `$${lower.toFixed(2)} (0.7 × spendable) and $${upper.toFixed(2)} (1.0 × spendable). ` +
      `An undersized plan wastes the cycle; an oversized plan blows the cap.`,
    `Fill the band with SCOPE (more independent children), never by inflating per-child estimates.`,
    `EVERY child's description MUST name a concrete CONSUMER of what it builds — a caller, ` +
      `a route, or a UI surface that uses it. No API nothing calls, no class nothing instantiates.`,
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
        : reason === 'budget'
          ? report?.budget
            ? `Your previous plan's cost sum $${report.budget.sumUsd.toFixed(2)} was outside the required band ` +
              `[$${report.budget.lowerUsd.toFixed(2)}, $${report.budget.upperUsd.toFixed(2)}] ` +
              `(0.7–1.0 × spendable $${report.budget.spendableUsd.toFixed(2)}). ` +
              `Resize the children so their estimatedCostUsd sum lands inside that band.`
            : `Your previous plan's total estimatedCostUsd was outside the required budget band. Resize the children to fit.`
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
  /** Failure detail, currently populated for budget-band violations. */
  message?: string;
}

function attempt(output: string, budgetUsd?: number): AttemptResult {
  let raw: unknown;
  try {
    raw = extractEpicPlanJson(output);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const parsed = EpicPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-json' };
  const v = validateAndLayerEpicPlan(parsed.data, budgetUsd);
  if (v.ok) return { ok: true, plan: v.plan, report: v.report, reason: 'unknown' };
  return {
    ok: false,
    reason: v.reason,
    report: v.report,
    ...(v.message !== undefined ? { message: v.message } : {}),
  };
}

export interface DecomposeObjectiveOptions {
  /**
   * Project root for per-repo cost calibration: when set, prior cycles'
   * spend-report.json actuals are surfaced to the planner alongside the
   * static cost table (loadObservedChildCosts). Absent → static table only.
   */
  projectRoot?: string;
}

export async function decomposeObjective(
  objective: EpicObjective,
  runtime: DecomposeRuntime,
  opts: DecomposeObjectiveOptions = {},
): Promise<DecomposeResult> {
  const observed =
    opts.projectRoot !== undefined ? loadObservedChildCosts(opts.projectRoot) : null;
  // Read-only repo exploration tools (cycle c5e6efb9 fix): a tool-less planner
  // has never SEEN the repository and hallucinates plausible-but-wrong file
  // paths on large codebases (declared packages/core/src/phases/… when the
  // real tree is …/autonomous/phase-handlers/…). Children then honor the
  // scope contract and report honest blockers — the plan, not the agents, is
  // wrong. The prompt requires every declared path to be verified with these
  // tools; this is the redesign's "grounded digest" realized as exploration.
  const r1 = await runtime.run(
    EPIC_PLANNER_AGENT_ID,
    buildEpicPlannerPrompt(objective, observed),
    {
      allowedTools: ['Read', 'Glob', 'Grep'],
      codexSandbox: 'read-only',
      outputSchema: EPIC_PLAN_OUTPUT_SCHEMA,
    },
  );
  let costUsd = r1.costUsd ?? 0;
  const a1 = attempt(r1.output, objective.budgetUsd);
  if (a1.ok) {
    return { plan: a1.plan!, report: a1.report!, costUsd, repaired: false };
  }

  // One repair retry.
  const r2 = await runtime.run(
    EPIC_PLANNER_AGENT_ID,
    buildRepairPrompt(objective, r1.output, a1.reason, a1.report),
    {
      allowedTools: ['Read', 'Glob', 'Grep'],
      codexSandbox: 'read-only',
      outputSchema: EPIC_PLAN_OUTPUT_SCHEMA,
    },
  );
  costUsd += r2.costUsd ?? 0;
  const a2 = attempt(r2.output, objective.budgetUsd);
  if (a2.ok) {
    return { plan: a2.plan!, report: a2.report!, costUsd, repaired: true };
  }
  throw new DecomposeError(
    a2.message ??
      `epic-planner produced an invalid decomposition after one repair retry (reason: ${a2.reason})`,
    a2.reason,
    a2.report,
    costUsd,
  );
}
