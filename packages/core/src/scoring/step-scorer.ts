// packages/core/src/scoring/step-scorer.ts
//
// StepScorer engine — combines deterministic rubric signals with an optional
// LLM grader to produce a StepScore for each phase step in an autonomous cycle.
//
// LLM grader fires when:
//   - Math.random() < 0.10 (10% sample), OR
//   - deterministic-only quality < 0.6, OR
//   - force_llm_grade === true

import { randomUUID } from 'node:crypto';
import type { ValidatedJsonOutput } from '../autonomous/phase-handlers/execute-phase.js';
import { computeDeterministicSignals, type DeterministicInput } from './deterministic-signals.js';
// T5's LlmGrader uses a different (batched/queued) interface than T1's stub.
// Step-scorer takes an OPTIONAL inline grader fn (caller-provided) so the
// scorer module stays decoupled from grader plumbing. The Wave 4 T5 grader is
// wired in via a thin adapter at the execute-phase callsite.
type InlineGraderFn = (input: {
  agentId: string;
  phase: string;
  raw: string;
  parsed: unknown;
  capabilityTags: string[];
  skillIds: string[];
}) => Promise<{ quality: number; signals: Signal[] }>;
import { RUBRIC_VERSION, type Signal } from './rubric-v1.js';

// Re-export Signal for consumers that import from step-scorer
export type { Signal };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CyclePhase =
  | 'audit'
  | 'plan'
  | 'assign'
  | 'execute'
  | 'test'
  | 'review'
  | 'gate'
  | 'release'
  | 'learn';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface StepScore {
  step_score_id: string;
  cycle_id: string;
  phase: CyclePhase;
  item_id: string | null;
  agent_id: string;
  model: ModelTier;
  capability_tags: string[];
  skill_ids: string[];
  output_schema_id: string | null;
  quality: number;        // 0..1 weighted aggregate
  rubric_version: string;
  signals: Signal[];
  cost_usd: number;
  latency_ms: number;
  tokens: TokenUsage;
  llm_graded: boolean;
  created_at: string;
}

export interface ScoreInput {
  cycle_id: string;
  phase: CyclePhase;
  item_id: string | null;
  agent_id: string;
  model: ModelTier;
  capability_tags: string[];
  skill_ids: string[];
  validated_output: ValidatedJsonOutput;
  cost_usd: number;
  latency_ms: number;
  tokens: TokenUsage;
  cycle_artifacts_dir: string;
  owns_subsystems: string[];
  force_llm_grade?: boolean;
}

// ---------------------------------------------------------------------------
// Quality aggregate
// ---------------------------------------------------------------------------

/**
 * Weighted mean of all signal values, clamped to [0, 1].
 * Signals with weight === 0 are excluded from the aggregate.
 */
function weightedMean(signals: Signal[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const s of signals) {
    if (s.weight > 0) {
      numerator += s.value * s.weight;
      denominator += s.weight;
    }
  }
  if (denominator === 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

// ---------------------------------------------------------------------------
// scoreStep
// ---------------------------------------------------------------------------

/**
 * Score a single phase step.
 *
 * @param input - ScoreInput describing the step execution context.
 * @param grader - Optional LLM grader override (defaults to stub).
 */
export async function scoreStep(
  input: ScoreInput,
  grader?: InlineGraderFn,
): Promise<StepScore> {
  const deterministicInput: DeterministicInput = {
    validatedOutput: input.validated_output,
    cycleArtifactsDir: input.cycle_artifacts_dir,
    ownsSubsystems: input.owns_subsystems,
    capabilityTags: input.capability_tags,
    skillIds: input.skill_ids,
    cycleId: input.cycle_id,
  };

  // 1. Compute deterministic signals
  const detSignals = computeDeterministicSignals(deterministicInput);
  const deterministicQuality = weightedMean(detSignals);

  // 2. Decide whether to invoke LLM grader
  const shouldGrade =
    input.force_llm_grade === true ||
    deterministicQuality < 0.6 ||
    Math.random() < 0.10;

  let allSignals: Signal[] = detSignals;
  let llmGraded = false;

  if (shouldGrade && grader) {
    const llmResult = await grader({
      agentId: input.agent_id,
      phase: input.phase,
      raw: input.validated_output.raw,
      parsed: input.validated_output.parsed,
      capabilityTags: input.capability_tags,
      skillIds: input.skill_ids,
    });

    allSignals = [...detSignals, ...llmResult.signals];
    llmGraded = true;
  }

  // 3. Compute final quality
  const quality = weightedMean(allSignals);

  return {
    step_score_id: randomUUID(),
    cycle_id: input.cycle_id,
    phase: input.phase,
    item_id: input.item_id,
    agent_id: input.agent_id,
    model: input.model,
    capability_tags: input.capability_tags,
    skill_ids: input.skill_ids,
    output_schema_id: null,
    quality,
    rubric_version: RUBRIC_VERSION,
    signals: allSignals,
    cost_usd: input.cost_usd,
    latency_ms: input.latency_ms,
    tokens: input.tokens,
    llm_graded: llmGraded,
    created_at: new Date().toISOString(),
  };
}
