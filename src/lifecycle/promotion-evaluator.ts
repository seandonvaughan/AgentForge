/**
 * PromotionEvaluator — P1-6: Agent Promotion Pipeline
 *
 * Evaluates which agents are ready for a seniority promotion based on
 * skill levels, recent success rate, and autonomy tier, then applies
 * auto-approved promotions via CareerStore.promote().
 */

import type { CareerStore } from "./career-store.js";
import type { SeniorityLevel } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotionCandidate {
  agentId: string;
  currentSeniority: SeniorityLevel;
  recommendedSeniority: SeniorityLevel;
  reason: string;
  /** When true, promotion will be applied automatically without human review. */
  autoApprove: boolean;
}

// ---------------------------------------------------------------------------
// Promotion ladder
// ---------------------------------------------------------------------------

const SENIORITY_LADDER: SeniorityLevel[] = ["junior", "mid", "senior", "lead", "principal"];

function nextSeniority(current: SeniorityLevel): SeniorityLevel | null {
  const idx = SENIORITY_LADDER.indexOf(current);
  if (idx === -1 || idx === SENIORITY_LADDER.length - 1) return null;
  return SENIORITY_LADDER[idx + 1];
}

// ---------------------------------------------------------------------------
// Criteria constants
// ---------------------------------------------------------------------------

/** Min skills at Level 3+ needed to become eligible for senior. */
const MIN_SENIOR_SKILLS_AT_L3 = 3;
/** Minimum success rate over the last N tasks for auto-approval. */
const MIN_SUCCESS_RATE = 0.85;
/** How many recent tasks to consider for success rate. */
const SUCCESS_WINDOW = 20;
/** Minimum autonomy tier for auto-approval (tier 3 = "supervised"). */
const MIN_AUTONOMY_FOR_AUTO = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate which agents are ready for promotion.
 *
 * @param careerStore - Source of skill profiles and task history.
 * @param agentIds    - Agent IDs to evaluate.
 * @returns Candidates sorted by agentId; excludes agents already at principal.
 */
export function evaluatePromotions(
  careerStore: CareerStore,
  agentIds: string[],
): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];

  for (const agentId of agentIds) {
    const record = careerStore.getCareerRecord(agentId);

    // Fall back to skill profile when a DB-backed record is unavailable
    const currentSeniority: SeniorityLevel = record?.seniority ?? "junior";
    const next = nextSeniority(currentSeniority);
    if (!next) continue; // already at principal

    const skillProfile = careerStore.getSkillProfile(agentId);
    const skillsAtL3OrAbove = Object.values(skillProfile.skills)
      .filter((s) => s.level >= 3).length;

    // Compute recent success rate from task history
    const recentHistory = careerStore.getTaskHistory(agentId, SUCCESS_WINDOW);
    const successRate =
      recentHistory.length === 0
        ? 0
        : recentHistory.filter((m) => m.outcome === "success").length /
          recentHistory.length;

    const autonomyTier = record?.autonomyTier ?? 0;

    // Eligibility gate: 3+ skills at L3 AND success rate > 85%
    if (skillsAtL3OrAbove < MIN_SENIOR_SKILLS_AT_L3 || successRate < MIN_SUCCESS_RATE) {
      continue;
    }

    const reason = buildReason(skillsAtL3OrAbove, successRate, recentHistory.length, next);

    // Auto-approve only when autonomy tier is high enough
    const autoApprove = autonomyTier >= MIN_AUTONOMY_FOR_AUTO;

    candidates.push({
      agentId,
      currentSeniority,
      recommendedSeniority: next,
      reason,
      autoApprove,
    });
  }

  return candidates.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Apply auto-approved promotions from the candidate list.
 *
 * @param candidates  - Candidates returned by evaluatePromotions.
 * @param careerStore - Store to persist the promotion events.
 */
export function applyPromotions(
  candidates: PromotionCandidate[],
  careerStore: CareerStore,
): void {
  for (const candidate of candidates) {
    if (!candidate.autoApprove) continue;
    careerStore.promote(candidate.agentId, candidate.recommendedSeniority, "promotion-evaluator");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReason(
  skillsAtL3: number,
  successRate: number,
  windowSize: number,
  next: SeniorityLevel,
): string {
  const pct = (successRate * 100).toFixed(1);
  return (
    `${skillsAtL3} skill(s) at Level 3+; ` +
    `${pct}% success rate over last ${windowSize} task(s); ` +
    `eligible for promotion to ${next}`
  );
}
