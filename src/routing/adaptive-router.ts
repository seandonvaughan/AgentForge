/**
 * AdaptiveRouter — v4.6 P1-3
 *
 * Extends static model routing with feedback-driven learning.
 * Reads FeedbackEntry records for each agent and computes quality scores,
 * success rates, and model mismatch rates to recommend model tier changes.
 */

import { FeedbackProtocol } from "../feedback/feedback-protocol.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AdaptiveRoutingProfile {
  agentId: string;
  recommendedModel: "opus" | "sonnet" | "haiku";
  configuredModel: "opus" | "sonnet" | "haiku";
  successRate: number;       // 0.0–1.0
  avgCostPerTask: number;    // USD
  sampleCount: number;       // number of feedback entries used
  qualityScore: number;      // 0.0–1.0 (composite of success + assessment)
  modelMismatchRate: number; // fraction of entries where modelTierAppropriate=false
  lastUpdated: string;
}

export interface RoutingRecommendation {
  agentId: string;
  currentModel: "opus" | "sonnet" | "haiku";
  recommendedModel: "opus" | "sonnet" | "haiku";
  reason: string;
  confidence: number;             // 0.0–1.0
  costSavingsEstimateUsd?: number; // if downgrade recommended
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ModelTier = "opus" | "sonnet" | "haiku";

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const TIER_BY_RANK: ModelTier[] = ["haiku", "sonnet", "opus"];

/** Assessment → quality score mapping */
const QUALITY_SCORE: Record<string, number> = {
  exceeded: 1.0,
  met: 0.75,
  partial: 0.4,
  failed: 0.0,
};

/** Estimated savings when downgrading opus → sonnet (USD per task) */
const OPUS_TO_SONNET_SAVINGS_PER_TASK = 0.05;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AdaptiveRouterOptions {
  feedbackProtocol?: FeedbackProtocol;
  minSampleCount?: number;
}

// ---------------------------------------------------------------------------
// AdaptiveRouter
// ---------------------------------------------------------------------------

export class AdaptiveRouter {
  private readonly feedbackProtocol: FeedbackProtocol;
  private readonly minSampleCount: number;

  constructor(options?: AdaptiveRouterOptions) {
    this.feedbackProtocol = options?.feedbackProtocol ?? new FeedbackProtocol();
    this.minSampleCount = options?.minSampleCount ?? 3;
  }

  // -------------------------------------------------------------------------
  // buildProfile
  // -------------------------------------------------------------------------

  buildProfile(agentId: string, configuredModel: string): AdaptiveRoutingProfile {
    const normalizedModel = this._normalizeModel(configuredModel);
    const entries = this.feedbackProtocol.getEntries({ agentId });

    const now = new Date().toISOString();

    if (entries.length === 0) {
      return {
        agentId,
        recommendedModel: normalizedModel,
        configuredModel: normalizedModel,
        successRate: 0,
        avgCostPerTask: 0,
        sampleCount: 0,
        qualityScore: 0,
        modelMismatchRate: 0,
        lastUpdated: now,
      };
    }

    // successRate: fraction with selfAssessment = 'exceeded' or 'met'
    const successCount = entries.filter(
      (e) => e.selfAssessment === "exceeded" || e.selfAssessment === "met",
    ).length;
    const successRate = successCount / entries.length;

    // qualityScore: average of mapped assessment scores
    const qualityScore =
      entries.reduce((sum, e) => sum + (QUALITY_SCORE[e.selfAssessment] ?? 0), 0) /
      entries.length;

    // modelMismatchRate: fraction where modelTierAppropriate === false
    const mismatchCount = entries.filter((e) => e.modelTierAppropriate === false).length;
    const modelMismatchRate = mismatchCount / entries.length;

    // avgCostPerTask: average of timeSpentMs converted to rough USD estimate
    // (no real cost data in FeedbackEntry; use 0 as default)
    const avgCostPerTask = 0;

    // Build a partial profile to pass to recommend()
    const partialProfile: AdaptiveRoutingProfile = {
      agentId,
      recommendedModel: normalizedModel, // placeholder, will be replaced
      configuredModel: normalizedModel,
      successRate,
      avgCostPerTask,
      sampleCount: entries.length,
      qualityScore,
      modelMismatchRate,
      lastUpdated: now,
    };

    const recommendation = this.recommend(partialProfile);
    const recommendedModel = recommendation ? recommendation.recommendedModel : normalizedModel;

    return {
      ...partialProfile,
      recommendedModel,
    };
  }

  // -------------------------------------------------------------------------
  // recommend
  // -------------------------------------------------------------------------

  recommend(profile: AdaptiveRoutingProfile): RoutingRecommendation | null {
    if (profile.sampleCount < this.minSampleCount) {
      return null;
    }

    const currentRank = TIER_RANK[profile.configuredModel];
    const { qualityScore, modelMismatchRate, agentId, configuredModel } = profile;

    // Downgrade: agent is over-resourced (high quality, but flags model mismatch)
    if (qualityScore >= 0.8 && modelMismatchRate >= 0.5) {
      const newRank = Math.max(0, currentRank - 1);
      const recommendedModel = TIER_BY_RANK[newRank]!;

      if (recommendedModel === configuredModel) {
        // Already at lowest tier — no change possible
        return {
          agentId,
          currentModel: configuredModel,
          recommendedModel: configuredModel,
          reason: "Already at minimum tier; no downgrade possible.",
          confidence: 0.5,
        };
      }

      const costSavingsEstimateUsd =
        configuredModel === "opus" ? OPUS_TO_SONNET_SAVINGS_PER_TASK : undefined;

      return {
        agentId,
        currentModel: configuredModel,
        recommendedModel,
        reason: `Quality score ${qualityScore.toFixed(2)} >= 0.8 and mismatch rate ${modelMismatchRate.toFixed(2)} >= 0.5 — agent is over-resourced; downgrade recommended.`,
        confidence: Math.min(0.5 + modelMismatchRate * 0.5, 1.0),
        costSavingsEstimateUsd,
      };
    }

    // Upgrade: agent is under-resourced (low quality, flags model mismatch)
    if (qualityScore < 0.5 && modelMismatchRate >= 0.5) {
      const newRank = Math.min(2, currentRank + 1);
      const recommendedModel = TIER_BY_RANK[newRank]!;

      if (recommendedModel === configuredModel) {
        // Already at highest tier — no change possible
        return {
          agentId,
          currentModel: configuredModel,
          recommendedModel: configuredModel,
          reason: "Already at maximum tier; no upgrade possible.",
          confidence: 0.5,
        };
      }

      return {
        agentId,
        currentModel: configuredModel,
        recommendedModel,
        reason: `Quality score ${qualityScore.toFixed(2)} < 0.5 and mismatch rate ${modelMismatchRate.toFixed(2)} >= 0.5 — agent is under-resourced; upgrade recommended.`,
        confidence: Math.min(0.5 + modelMismatchRate * 0.5, 1.0),
      };
    }

    // No change
    return {
      agentId,
      currentModel: configuredModel,
      recommendedModel: configuredModel,
      reason: "Model tier is appropriate based on current feedback.",
      confidence: 0.7,
    };
  }

  // -------------------------------------------------------------------------
  // getAllRecommendations
  // -------------------------------------------------------------------------

  getAllRecommendations(
    agentModelMap: Record<string, string>,
  ): RoutingRecommendation[] {
    const results: RoutingRecommendation[] = [];

    for (const [agentId, model] of Object.entries(agentModelMap)) {
      const profile = this.buildProfile(agentId, model);
      const rec = this.recommend(profile);
      if (rec !== null) {
        results.push(rec);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // getProfile
  // -------------------------------------------------------------------------

  getProfile(agentId: string, configuredModel: string): AdaptiveRoutingProfile {
    return this.buildProfile(agentId, configuredModel);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _normalizeModel(model: string): ModelTier {
    if (model === "opus" || model === "sonnet" || model === "haiku") {
      return model;
    }
    // Fall back to sonnet for unknown models
    return "sonnet";
  }
}
