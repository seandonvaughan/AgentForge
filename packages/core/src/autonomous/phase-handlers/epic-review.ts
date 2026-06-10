// packages/core/src/autonomous/phase-handlers/epic-review.ts
//
// P0.6 — Epic review via structured outputs + funded fix-up loop.
//
// On the objective/epic path the legacy CEO gate (gate-phase.ts) is replaced by
// ONE strong-model (opus) structured review of the WHOLE integration branch as a
// single coherent feature. The verdict is requested via an AgentOutputSchema so
// the transport validates the JSON; the parse chain NEVER auto-REJECTs on a parse
// failure (that false-reject class is exactly what this wave kills). When the
// model cannot produce parseable JSON even after one cheap triage re-ask, we emit
// a TRIAGE verdict and APPROVE — the deterministic VERIFY stage remains the
// executable release authority.
//
// REQUEST_CHANGES drives the existing cycle-runner gate-retry loop (it throws the
// same GateRejectedError the legacy gate throws), but only after writing
// phases/epic-review.json with the exact faultedItems so buildGateRetryContext can
// route the fix-up to precisely those plan items.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import type { AgentOutputSchema } from '../../runtime/types.js';
import { writeMemoryEntry, type GateVerdictMetadata } from '../../memory/types.js';
import { collectSprintItemTags } from './sprint-utils.js';
import {
  GateRejectedError,
  GATE_ASSERTION_DEFERRAL_GUIDANCE,
  GATE_PHASE_DEFAULT_TOOLS,
  extractBalancedJson,
  type GatePhaseOptions,
} from './gate-phase.js';

/**
 * The structured-output contract for the epic review. The AgentOutputSchema
 * shape is `{name, description?, schema:{type:'object',properties,required?,
 * additionalProperties?}, strict?}` (runtime/types.ts) — the JSON Schema enum
 * lives INSIDE `properties.verdict`.
 */
export const EPIC_REVIEW_SCHEMA: AgentOutputSchema = {
  name: 'epic_review',
  description:
    'Structured verdict for an epic integration branch reviewed as one coherent feature.',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'] },
      rationale: { type: 'string' },
      faultedItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            reason: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
          },
          required: ['itemId', 'reason', 'files'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict', 'rationale', 'faultedItems'],
    additionalProperties: false,
  },
  strict: true,
};

/** A single faulted child item the reviewer wants fixed before approval. */
export interface EpicReviewFaultedItem {
  itemId: string;
  reason: string;
  files: string[];
}

/** Parsed epic-review verdict. TRIAGE is the unparseable-output safe state. */
export interface EpicReviewVerdict {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';
  rationale: string;
  faultedItems: EpicReviewFaultedItem[];
}

/** Persisted shape of phases/epic-review.json. */
export interface EpicReviewArtifact {
  phase: 'gate';
  mode: 'epic-review';
  cycleId: string;
  attempt: number;
  verdict: EpicReviewVerdict['verdict'];
  rationale: string;
  faultedItems: EpicReviewFaultedItem[];
  schemaValidationOk: boolean;
  triageUsed: boolean;
  costUsd: number;
  durationMs: number;
  completedAt: string;
}

const TRIAGE_PREFIX =
  '[TRIAGE — review output unparseable; deterministic VERIFY remains the release authority]';

interface PlanItemLite {
  id: string;
  title: string;
  description: string;
  files: string[];
  estimatedCostUsd: number | null;
}

function tryReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load the plan items relevant to the review prompt. Robust to estimatedCostUsd
 * being absent on any item and to a missing/legacy plan shape.
 */
function loadPlanItems(projectRoot: string, cycleId: string | undefined): PlanItemLite[] {
  if (!cycleId) return [];
  const planPath = join(projectRoot, '.agentforge', 'cycles', cycleId, 'plan.json');
  const parsed = tryReadJson(planPath);
  const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  return rawItems
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => ({
      id: i.id as string,
      title: typeof i.title === 'string' ? i.title : '(untitled)',
      description:
        typeof i.description === 'string' && i.description.trim().length > 0
          ? i.description.trim()
          : '(no description provided)',
      files: Array.isArray(i.files) ? i.files.filter((f: unknown) => typeof f === 'string') : [],
      estimatedCostUsd:
        typeof i.estimatedCostUsd === 'number' ? i.estimatedCostUsd : null,
    }));
}

/**
 * Read the epic integration signal from phases/execute.json. Absent on a legacy
 * (non-epic) execute — the caller guards on ctx.objective, but we stay defensive.
 */
function loadEpicIntegration(
  projectRoot: string,
  cycleId: string | undefined,
): { branch: string; epicId: string } | null {
  if (!cycleId) return null;
  const executePath = join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases', 'execute.json');
  const parsed = tryReadJson(executePath);
  const integ = parsed?.epicIntegration;
  if (integ && typeof integ.branch === 'string' && typeof integ.epicId === 'string') {
    return { branch: integ.branch, epicId: integ.epicId };
  }
  return null;
}

/**
 * Attempt to coerce raw model output into an EpicReviewVerdict WITHOUT any
 * network call. Mirrors the gate-phase salvage chain: strict JSON → fenced
 * ```json block → balanced-brace walk. Returns null when nothing parseable with
 * a recognised verdict is found.
 */
export function salvageEpicReview(text: string): EpicReviewVerdict | null {
  if (!text) return null;

  // 1. Whole-text strict JSON.
  const direct = coerceVerdict(text);
  if (direct) return direct;

  // 2. ```json fenced blocks (LLMs often wrap structured output in them).
  const fencedRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  for (const m of text.matchAll(fencedRe)) {
    const body = (m[1] ?? '').trim();
    if (!body.includes('"verdict"')) continue;
    const inFenced = coerceVerdict(body);
    if (inFenced) return inFenced;
    const openIdx = body.indexOf('{');
    if (openIdx >= 0) {
      const balanced = extractBalancedJson(body, openIdx);
      if (balanced) {
        const fromBalanced = coerceVerdict(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
  }

  // 3. Inline balanced-brace walk from every `{` that precedes a "verdict" key.
  let idx = text.indexOf('{');
  while (idx >= 0) {
    const nextChunk = text.slice(idx, idx + 8192);
    if (nextChunk.includes('"verdict"')) {
      const balanced = extractBalancedJson(text, idx);
      if (balanced) {
        const fromBalanced = coerceVerdict(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
    idx = text.indexOf('{', idx + 1);
  }

  return null;
}

/**
 * Parse a single JSON fragment into an EpicReviewVerdict. Returns null when the
 * fragment is not valid JSON or carries no recognised verdict. APPROVE and
 * REQUEST_CHANGES are the only model-emitted verdicts; TRIAGE is internal-only
 * and never produced here.
 */
function coerceVerdict(fragment: string): EpicReviewVerdict | null {
  let parsed: any;
  try {
    parsed = JSON.parse(fragment);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('verdict' in parsed)) return null;
  const v = String(parsed.verdict).toUpperCase();
  if (v !== 'APPROVE' && v !== 'REQUEST_CHANGES') return null;
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
  const faultedItems = normalizeFaultedItems(parsed.faultedItems);
  return { verdict: v, rationale, faultedItems };
}

/** Coerce an arbitrary faultedItems payload into typed, well-formed entries. */
function normalizeFaultedItems(raw: unknown): EpicReviewFaultedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EpicReviewFaultedItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.itemId !== 'string' || e.itemId.length === 0) continue;
    out.push({
      itemId: e.itemId,
      reason: typeof e.reason === 'string' ? e.reason : '',
      files: Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string') : [],
    });
  }
  return out;
}

function formatItemTable(items: PlanItemLite[]): string {
  if (items.length === 0) return '(no plan items recorded)';
  return items
    .map((i) => {
      const filesStr = i.files.length > 0 ? i.files.join(', ') : '(none declared)';
      const estStr = i.estimatedCostUsd !== null ? `$${i.estimatedCostUsd.toFixed(2)}` : 'n/a';
      return [
        `- [${i.id}] ${i.title}`,
        `  Acceptance / description: ${i.description}`,
        `  Declared files: ${filesStr}`,
        `  Estimated cost: ${estStr}`,
      ].join('\n');
    })
    .join('\n');
}

/**
 * Build the single epic-review prompt. The reviewer inspects the integration
 * branch as one coherent feature via read-only git/Bash and approves unless a
 * child is broken or missing vs the operator objective. Every fault MUST name an
 * exact itemId from the plan.
 */
function buildReviewTask(
  objective: string,
  baseBranch: string,
  branch: string,
  epicId: string,
  items: PlanItemLite[],
): string {
  const itemTable = formatItemTable(items);
  return `You are the CEO of AgentForge reviewing a completed epic as ONE coherent feature for release.

## Operator objective
${objective}

## Epic
Epic id: ${epicId}
Integration branch: ${branch}
Base branch: ${baseBranch}

## Plan items (every fault you raise MUST name one of these exact itemIds)
${itemTable}

## How to review
This epic accumulated every child's work onto the single integration branch \`${branch}\`. Review the WHOLE branch as one feature against the operator objective above — not each item in isolation.

Inspect the branch read-only with the Bash tool:
- Full diff vs the merge base:  \`git diff $(git merge-base ${baseBranch} ${branch})...${branch}\`
- A file's branch contents:      \`git show ${branch}:<path>\`
- Search:                        \`git grep <pattern> ${branch}\` or Read/Grep against listed files.

Do not modify any files. Do not push, commit, or switch branches.

## Verdict rules
- APPROVE when the integration branch, taken as a whole, satisfies the operator objective — even if individual files could be polished. Polish is not a release blocker.
- REQUEST_CHANGES only when a specific child item is broken or missing relative to the objective: a required behavior is unimplemented, a child's work is absent from the branch, or the branch contains a concrete defect that breaks the feature.
- Every entry in faultedItems MUST carry an exact \`itemId\` from the plan table above plus a concrete \`reason\` and the \`files\` involved. A fault you cannot tie to a specific plan itemId is not actionable — do not raise it; prefer APPROVE and note the concern in the rationale.

${GATE_ASSERTION_DEFERRAL_GUIDANCE}

In your rationale, state which parts of the branch you inspected and why each child either satisfies or fails the objective.

Respond with the structured object: { "verdict": "APPROVE" | "REQUEST_CHANGES", "rationale": "...", "faultedItems": [ { "itemId": "...", "reason": "...", "files": ["..."] } ] }. An APPROVE carries an empty faultedItems array.`;
}

/**
 * P0.6 — the epic-path gate. Delegated to from runGatePhase when ctx.objective
 * is set. Returns a completed PhaseResult on APPROVE/TRIAGE; throws
 * GateRejectedError on an actionable REQUEST_CHANGES so the cycle-runner retry
 * loop re-runs the faulted items.
 */
export async function runEpicReview(
  ctx: PhaseContext,
  options: GatePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'gate' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? GATE_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'ceo';
  const attempt = ctx.retryAttempt ?? 0;

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  const objective = ctx.objective ?? '';
  const baseBranch = ctx.baseBranch ?? 'main';
  const items = loadPlanItems(ctx.projectRoot, ctx.cycleId);
  const planItemIds = new Set(items.map((i) => i.id));
  const integration = loadEpicIntegration(ctx.projectRoot, ctx.cycleId);
  const branch = integration?.branch ?? `codex/${ctx.cycleId ?? 'epic'}`;
  const epicId = integration?.epicId ?? (ctx.cycleId ?? 'unknown');

  const task = buildReviewTask(objective, baseBranch, branch, epicId, items);

  let firstOutput = '';
  let schemaValidationOk = false;
  let triageUsed = false;
  let costUsd = 0;
  let verdict: EpicReviewVerdict | null = null;

  // ── Primary review call (fable, structured output) ─────────────────────────
  // The epic review is one of exactly two strong-model calls per epic cycle;
  // planning/review quality is the leverage point (run 3 lost a full budget to
  // an ungrounded plan), so it rides the top tier. modelCap still caps it down.
  try {
    const result = await ctx.runtime.run(agentId, task, {
      allowedTools,
      codexSandbox: 'read-only',
      capabilityTier: 'fable',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      outputSchema: EPIC_REVIEW_SCHEMA,
    });
    firstOutput = typeof result?.output === 'string' ? result.output : '';
    costUsd += typeof result?.costUsd === 'number' ? result.costUsd : 0;
    schemaValidationOk = result?.schemaValidation?.ok === true;

    // 1. Transport validated the schema → parse directly.
    if (schemaValidationOk) {
      try {
        verdict = coerceVerdict(firstOutput);
      } catch {
        verdict = null;
      }
    }
    // 2. Salvage chain (strict → fenced → balanced-brace) without any re-ask.
    if (!verdict) {
      verdict = salvageEpicReview(firstOutput);
    }
  } catch (err) {
    // An agent transport error is NOT a REJECT on the epic path — the
    // deterministic VERIFY stage is the release authority. Fall through to the
    // triage re-ask, then TRIAGE.
    firstOutput = `Agent error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 3. One cheap triage re-ask (sonnet) when still unparseable.
  if (!verdict) {
    triageUsed = true;
    const triageTask = `Return ONLY the JSON object matching this schema — no prose, no code fence:\n${JSON.stringify(
      EPIC_REVIEW_SCHEMA.schema,
    )}\n\nYour previous review was:\n${firstOutput.slice(0, 4000)}`;
    try {
      const triageResult = await ctx.runtime.run(agentId, triageTask, {
        allowedTools: ['Read'],
        codexSandbox: 'read-only',
        capabilityTier: 'sonnet',
        outputSchema: EPIC_REVIEW_SCHEMA,
      });
      const triageOutput = typeof triageResult?.output === 'string' ? triageResult.output : '';
      costUsd += typeof triageResult?.costUsd === 'number' ? triageResult.costUsd : 0;
      verdict =
        triageResult?.schemaValidation?.ok === true
          ? coerceVerdict(triageOutput) ?? salvageEpicReview(triageOutput)
          : salvageEpicReview(triageOutput);
    } catch {
      verdict = null;
    }
  }

  // ── Resolve the final verdict + rationale ──────────────────────────────────
  let finalVerdict: EpicReviewVerdict['verdict'];
  let rationale: string;
  let faultedItems: EpicReviewFaultedItem[];

  if (!verdict) {
    // 4. Unparseable even after triage → TRIAGE (APPROVE-equivalent for release).
    finalVerdict = 'TRIAGE';
    rationale = `${TRIAGE_PREFIX} The epic reviewer did not return a parseable verdict.`;
    faultedItems = [];
  } else if (verdict.verdict === 'APPROVE') {
    finalVerdict = 'APPROVE';
    rationale = verdict.rationale || 'Epic approved.';
    faultedItems = [];
  } else {
    // REQUEST_CHANGES — filter faults to itemIds that exist in the plan. Drop
    // unknown ids; if ALL are unknown, the rejection is unactionable → TRIAGE
    // (an unactionable rejection must not loop the cycle forever).
    const known = verdict.faultedItems.filter((f) => planItemIds.has(f.itemId));
    if (known.length === 0) {
      finalVerdict = 'TRIAGE';
      rationale = `${TRIAGE_PREFIX} REQUEST_CHANGES carried no faultedItems matching the plan; treating as non-actionable. Original rationale: ${verdict.rationale}`;
      faultedItems = [];
    } else {
      finalVerdict = 'REQUEST_CHANGES';
      rationale = verdict.rationale || 'Epic requires changes.';
      faultedItems = known;
    }
  }

  const durationMs = Date.now() - startedAt;

  // ── Write artifacts (ALWAYS before any throw) ──────────────────────────────
  writeEpicReviewArtifact(ctx, {
    phase: 'gate',
    mode: 'epic-review',
    cycleId: ctx.cycleId ?? '',
    attempt,
    verdict: finalVerdict,
    rationale,
    faultedItems,
    schemaValidationOk,
    triageUsed,
    costUsd,
    durationMs,
    completedAt: new Date().toISOString(),
  });

  // Keep writing a legacy-shaped gate.json so the dashboard keeps working.
  // TRIAGE is recorded as APPROVE (release proceeds) with the [TRIAGE] rationale.
  const legacyVerdict: 'APPROVE' | 'REJECT' =
    finalVerdict === 'REQUEST_CHANGES' ? 'REJECT' : 'APPROVE';
  writeLegacyGateJson(ctx, {
    verdict: legacyVerdict,
    rationale,
    costUsd,
    durationMs,
    startedAt,
  });

  // Gate-verdict memory entry (same store the legacy gate writes). TRIAGE→pending.
  const memVerdict: GateVerdictMetadata['verdict'] =
    finalVerdict === 'APPROVE'
      ? 'approved'
      : finalVerdict === 'REQUEST_CHANGES'
        ? 'rejected'
        : 'pending';
  writeGateVerdictMemory(ctx, memVerdict, rationale, faultedItems);

  const phaseResult: PhaseResult = {
    phase,
    status: finalVerdict === 'REQUEST_CHANGES' ? 'failed' : 'completed',
    durationMs,
    costUsd,
    agentRuns: [
      {
        agentId,
        costUsd,
        durationMs,
        response: firstOutput,
        verdict: finalVerdict,
        ...(triageUsed ? { triageUsed: true } : {}),
      },
    ],
    ...(finalVerdict === 'REQUEST_CHANGES' ? { error: rationale } : {}),
  };

  if (finalVerdict === 'REQUEST_CHANGES') {
    // Artifacts are already on disk; throw so the cycle-runner retry loop fires
    // and re-executes ONLY the faulted plan items (via buildGateRetryContext).
    throw new GateRejectedError(rationale);
  }

  if (finalVerdict === 'TRIAGE') {
    // eslint-disable-next-line no-console
    console.warn(
      `[epic-review] cycle ${ctx.cycleId ?? '(unknown)'} produced an unparseable verdict — TRIAGE; deterministic VERIFY is the release authority.`,
    );
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

/** Write phases/epic-review.json (best-effort; never throws). */
function writeEpicReviewArtifact(ctx: PhaseContext, artifact: EpicReviewArtifact): void {
  if (!ctx.cycleId) return;
  const path = join(
    ctx.projectRoot,
    '.agentforge',
    'cycles',
    ctx.cycleId,
    'phases',
    'epic-review.json',
  );
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(artifact, null, 2));
  } catch {
    // non-fatal
  }
}

/**
 * Write phases/gate.json in the legacy shape so the dashboard / downstream
 * consumers (which read gate.json) keep working unchanged. Best-effort.
 */
function writeLegacyGateJson(
  ctx: PhaseContext,
  args: {
    verdict: 'APPROVE' | 'REJECT';
    rationale: string;
    costUsd: number;
    durationMs: number;
    startedAt: number;
  },
): void {
  if (!ctx.cycleId) return;
  const path = join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'phases', 'gate.json');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          phase: 'gate',
          mode: 'epic-review',
          sprintId: ctx.sprintId,
          sprintVersion: ctx.sprintVersion,
          cycleId: ctx.cycleId,
          agentId: 'ceo',
          verdict: args.verdict,
          rationale: args.rationale,
          costUsd: args.costUsd,
          durationMs: args.durationMs,
          startedAt: new Date(args.startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          knownDebt: [],
        },
        null,
        2,
      ),
    );
  } catch {
    // non-fatal
  }
}

/**
 * Write a gate-verdict memory entry mirroring the legacy gate's pattern
 * (gate-phase.ts:716-752). faultedItems are surfaced in the value string and as
 * structured criticalFindings so the next cycle's audit has signal.
 */
function writeGateVerdictMemory(
  ctx: PhaseContext,
  verdict: GateVerdictMetadata['verdict'],
  rationale: string,
  faultedItems: EpicReviewFaultedItem[],
): void {
  const findingLines = faultedItems.map((f) => `[${f.itemId}] ${f.reason}`);
  const sprintDomainTags = collectSprintItemTags(ctx.projectRoot, ctx.sprintVersion, ctx.cycleId);
  const metadata: GateVerdictMetadata = {
    cycleId: ctx.cycleId ?? '',
    verdict,
    rationale,
    criticalFindings: findingLines,
    majorFindings: [],
  };
  const summaryParts: string[] = [`Epic review ${verdict}: ${rationale}`];
  if (findingLines.length > 0) {
    summaryParts.push(`Faulted items: ${findingLines.join('; ')}`);
  }
  writeMemoryEntry(ctx.projectRoot, {
    type: 'gate-verdict',
    value: summaryParts.join('. '),
    metadata,
    ...(ctx.cycleId ? { source: ctx.cycleId } : {}),
    tags: [`verdict:${verdict}`, `sprint:v${ctx.sprintVersion}`, 'epic-review', ...sprintDomainTags],
  });
}
