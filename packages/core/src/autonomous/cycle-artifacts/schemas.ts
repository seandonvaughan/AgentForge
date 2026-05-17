// packages/core/src/autonomous/cycle-artifacts/schemas.ts
//
// Zod schemas for cycle artifact files written under
//   .agentforge/cycles/<cycleId>/{cycle,plan,scoring}.json
//   .agentforge/cycles/<cycleId>/phases/{gate,review,execute}.json
//
// Design principles:
//   1. CONSERVATIVE nullish() — real data has nulls (v22.1 lesson)
//   2. .passthrough() on all top-level objects — forward-compat; unknown
//      fields added by future agents must not break existing consumers
//   3. Warning-only at write sites — never throw; schemas surface drift quickly
//      without ever stopping a cycle

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ISO-8601 datetime string (non-exhaustive — keeps schema lightweight) */
const IsoDatetime = z.string().datetime({ offset: true });

/** Positive or zero number */
const NonNegative = z.number().min(0);

// ---------------------------------------------------------------------------
// 1. CycleJsonSchema
// ---------------------------------------------------------------------------

const CostSchema = z
  .object({
    totalUsd: NonNegative,
    budgetUsd: NonNegative.nullish(),
    byAgent: z.record(z.string(), z.number()).nullish(),
    byPhase: z.record(z.string(), z.number()).nullish(),
  })
  .passthrough();

const TestsSchema = z
  .object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0).nullish(),
    total: z.number().int().min(0).nullish(),
    passRate: z.number().min(0).max(1).nullish(),
    newFailures: z.array(z.string()).nullish(),
  })
  .passthrough();

const GitSchema = z
  .object({
    branch: z.string().nullish(),
    commitSha: z.string().nullish(),
    filesChanged: z.array(z.string()).nullish(),
  })
  .passthrough();

const PrSchema = z
  .object({
    url: z.string().url().nullish(),
    number: z.number().int().positive().nullish(),
    draft: z.boolean().nullish(),
  })
  .passthrough();

export const CycleJsonSchema = z
  .object({
    cycleId: z.string().uuid(),
    sprintVersion: z.string(),
    stage: z.enum(['run', 'completed', 'failed', 'killed', 'aborted']),
    startedAt: IsoDatetime.nullish(),
    completedAt: IsoDatetime.nullish(),
    durationMs: NonNegative.nullish(),
    cost: CostSchema,
    tests: TestsSchema,
    git: GitSchema.nullish(),
    pr: PrSchema.nullish(),
    gateVerdict: z.enum(['APPROVE', 'REJECT']).nullish(),
  })
  .passthrough();

export type CycleJson = z.infer<typeof CycleJsonSchema>;

// ---------------------------------------------------------------------------
// 2. PlanJsonSchema
// ---------------------------------------------------------------------------

const PlanItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullish(),
    assignee: z.string().nullish(),
    status: z
      .enum(['pending', 'in_progress', 'completed', 'skipped', 'failed'])
      .nullish(),
    estimatedCostUsd: NonNegative.nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .passthrough();

export const PlanJsonSchema = z
  .object({
    version: z.string().nullish(),
    sprintId: z.string().nullish(),
    title: z.string().nullish(),
    createdAt: IsoDatetime.nullish(),
    phase: z.string().nullish(),
    items: z.array(PlanItemSchema),
    budget: NonNegative.nullish(),
    teamSize: z.number().int().positive().nullish(),
    successCriteria: z.array(z.string()).nullish(),
    versionDecision: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export type PlanJson = z.infer<typeof PlanJsonSchema>;

// ---------------------------------------------------------------------------
// 3. GateJsonSchema
// ---------------------------------------------------------------------------

const GateFindingSchema = z
  .object({
    severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'INFO']).nullish(),
    message: z.string().nullish(),
    file: z.string().nullish(),
    line: z.number().int().positive().nullish(),
  })
  .passthrough();

export const GateJsonSchema = z
  .object({
    phase: z.literal('gate'),
    verdict: z.enum(['APPROVE', 'REJECT']).nullish(),
    rationale: z.string().nullish(),
    findings: z.array(GateFindingSchema).nullish(),
    // Failed gate has error + status instead of verdict
    error: z.string().nullish(),
    status: z.enum(['completed', 'failed']).nullish(),
    durationMs: NonNegative.nullish(),
    costUsd: NonNegative.nullish(),
  })
  .passthrough();

export type GateJson = z.infer<typeof GateJsonSchema>;

// ---------------------------------------------------------------------------
// 4. ReviewJsonSchema
// ---------------------------------------------------------------------------

const ReviewFindingSchema = z
  .object({
    severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'INFO']).nullish(),
    message: z.string().nullish(),
    file: z.string().nullish(),
    line: z.number().int().positive().nullish(),
    fixSuggestion: z.string().nullish(),
  })
  .passthrough();

const ReviewAgentRunSchema = z
  .object({
    agentId: z.string().nullish(),
    costUsd: NonNegative.nullish(),
    durationMs: NonNegative.nullish(),
    response: z.string().nullish(),
    findings: z.array(ReviewFindingSchema).nullish(),
  })
  .passthrough();

export const ReviewJsonSchema = z
  .object({
    phase: z.literal('review'),
    status: z.enum(['completed', 'failed', 'pending']).nullish(),
    durationMs: NonNegative.nullish(),
    costUsd: NonNegative.nullish(),
    agentRuns: z.array(ReviewAgentRunSchema).nullish(),
    findings: z.array(ReviewFindingSchema).nullish(),
    error: z.string().nullish(),
  })
  .passthrough();

export type ReviewJson = z.infer<typeof ReviewJsonSchema>;

// ---------------------------------------------------------------------------
// 5. ScoringJsonSchema
// ---------------------------------------------------------------------------

const ScoringRankingSchema = z
  .object({
    itemId: z.string(),
    title: z.string().nullish(),
    rank: z.number().int().positive().nullish(),
    score: z.number().min(0).max(1).nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    estimatedCostUsd: NonNegative.nullish(),
    estimatedDurationMinutes: NonNegative.nullish(),
    rationale: z.string().nullish(),
    dependencies: z.array(z.string()).nullish(),
    suggestedAssignee: z.string().nullish(),
    suggestedTags: z.array(z.string()).nullish(),
    withinBudget: z.boolean().nullish(),
  })
  .passthrough();

const ScoringResultSchema = z
  .object({
    rankings: z.array(ScoringRankingSchema).nullish(),
    totalEstimatedCostUsd: NonNegative.nullish(),
    budgetOverflowUsd: NonNegative.nullish(),
    summary: z.string().nullish(),
    warnings: z.array(z.string()).nullish(),
  })
  .passthrough();

const ScoringGroundingSchema = z
  .object({
    history: z.array(z.unknown()).nullish(),
    costMedians: z.record(z.string(), z.number()).nullish(),
    teamState: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const ScoringJsonSchema = z
  .object({
    result: ScoringResultSchema,
    grounding: ScoringGroundingSchema.nullish(),
    at: IsoDatetime.nullish(),
  })
  .passthrough();

export type ScoringJson = z.infer<typeof ScoringJsonSchema>;

// ---------------------------------------------------------------------------
// 6. ExecutePhaseSchema
// ---------------------------------------------------------------------------

const ExecuteAgentRunSchema = z
  .object({
    itemId: z.string().nullish(),
    status: z.enum(['completed', 'failed', 'skipped', 'pending']).nullish(),
    costUsd: NonNegative.nullish(),
    durationMs: NonNegative.nullish(),
    response: z.string().nullish(),
    attempts: z.number().int().positive().nullish(),
    agentId: z.string().nullish(),
    model: z.string().nullish(),
    effort: z.enum(['low', 'medium', 'high', 'max']).nullish(),
    error: z.string().nullish(),
  })
  .passthrough();

export const ExecutePhaseSchema = z
  .object({
    phase: z.literal('execute'),
    status: z.enum(['completed', 'failed', 'pending']).nullish(),
    durationMs: NonNegative.nullish(),
    costUsd: NonNegative.nullish(),
    agentRuns: z.array(ExecuteAgentRunSchema).nullish(),
    itemResults: z.array(z.unknown()).nullish(),
    error: z.string().nullish(),
  })
  .passthrough();

export type ExecutePhase = z.infer<typeof ExecutePhaseSchema>;

// ---------------------------------------------------------------------------
// Typed parse helpers — warn on failure, never throw
// ---------------------------------------------------------------------------

type ParseSuccess<T> = { ok: true; data: T };
type ParseFailure = { ok: false; errors: z.ZodError['issues'] };
type ParseResult<T> = ParseSuccess<T> | ParseFailure;

function makeSafeParser<T>(schema: z.ZodType<T>) {
  return (raw: unknown): ParseResult<T> => {
    const result = schema.safeParse(raw);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, errors: result.error.issues };
  };
}

export const parseCycleJson = makeSafeParser(CycleJsonSchema);
export const parsePlanJson = makeSafeParser(PlanJsonSchema);
export const parseGateJson = makeSafeParser(GateJsonSchema);
export const parseReviewJson = makeSafeParser(ReviewJsonSchema);
export const parseScoringJson = makeSafeParser(ScoringJsonSchema);
export const parseExecutePhase = makeSafeParser(ExecutePhaseSchema);

/**
 * Convenience: run a schema parse and emit a structured console.warn if it
 * fails. Returns undefined on failure so callers can use a `?? fallback`.
 * Never throws — schemas are warning-only at write time.
 */
export function validateCycleJson(raw: unknown): CycleJson | undefined {
  const r = parseCycleJson(raw);
  if (r.ok) return r.data;
  console.warn('[cycle-artifacts] cycle.json schema mismatch', r.errors);
  return undefined;
}

export function validatePlanJson(raw: unknown): PlanJson | undefined {
  const r = parsePlanJson(raw);
  if (r.ok) return r.data;
  console.warn('[cycle-artifacts] plan.json schema mismatch', r.errors);
  return undefined;
}

export function validateGateJson(raw: unknown): GateJson | undefined {
  const r = parseGateJson(raw);
  if (r.ok) return r.data;
  console.warn('[cycle-artifacts] gate.json schema mismatch', r.errors);
  return undefined;
}

export function validateReviewJson(raw: unknown): ReviewJson | undefined {
  const r = parseReviewJson(raw);
  if (r.ok) return r.data;
  console.warn('[cycle-artifacts] review.json schema mismatch', r.errors);
  return undefined;
}

export function validateScoringJson(raw: unknown): ScoringJson | undefined {
  const r = parseScoringJson(raw);
  if (r.ok) return r.data;
  console.warn('[cycle-artifacts] scoring.json schema mismatch', r.errors);
  return undefined;
}

export function validateExecutePhase(raw: unknown): ExecutePhase | undefined {
  const r = parseExecutePhase(raw);
  if (r.ok) return r.data;
  console.warn('[cycle-artifacts] execute.json schema mismatch', r.errors);
  return undefined;
}
