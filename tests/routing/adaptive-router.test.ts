import { describe, it, expect, beforeEach } from "vitest";
import { AdaptiveRouter } from "../../src/routing/adaptive-router.js";
import { FeedbackProtocol } from "../../src/feedback/feedback-protocol.js";
import { InMemoryFeedbackFileAdapter } from "../../src/feedback/feedback-protocol.js";
import type { FeedbackEntry } from "../../src/feedback/feedback-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    agentId: "agent-alpha",
    taskId: "task-001",
    sprintId: "v4.6",
    timestamp: new Date().toISOString(),
    whatWorked: [],
    whatDidnt: [],
    recommendations: [],
    timeSpentMs: 1000,
    blockers: [],
    selfAssessment: "met",
    modelTierAppropriate: true,
    ...overrides,
  };
}

function makeProtocol(entries: FeedbackEntry[] = []): FeedbackProtocol {
  const adapter = new InMemoryFeedbackFileAdapter();
  const fp = new FeedbackProtocol({ fileAdapter: adapter });
  for (const e of entries) fp.recordEntry(e);
  return fp;
}

// ---------------------------------------------------------------------------
// buildProfile — empty / default
// ---------------------------------------------------------------------------

describe("buildProfile — no entries", () => {
  it("returns default profile when no entries exist", () => {
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol() });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.agentId).toBe("agent-alpha");
    expect(profile.sampleCount).toBe(0);
    expect(profile.successRate).toBe(0);
    expect(profile.qualityScore).toBe(0);
    expect(profile.modelMismatchRate).toBe(0);
    expect(profile.configuredModel).toBe("sonnet");
    expect(profile.recommendedModel).toBe("sonnet"); // no data → keep configured
  });

  it("preserves configuredModel in default profile", () => {
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol() });
    const profile = router.buildProfile("no-data-agent", "opus");
    expect(profile.configuredModel).toBe("opus");
    expect(profile.recommendedModel).toBe("opus");
  });
});

// ---------------------------------------------------------------------------
// buildProfile — successRate
// ---------------------------------------------------------------------------

describe("buildProfile — successRate", () => {
  it("computes 1.0 when all entries are exceeded or met", () => {
    const entries = [
      makeEntry({ selfAssessment: "exceeded" }),
      makeEntry({ selfAssessment: "met" }),
      makeEntry({ selfAssessment: "met" }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.successRate).toBe(1.0);
  });

  it("computes 0.0 when all entries are partial or failed", () => {
    const entries = [
      makeEntry({ selfAssessment: "partial" }),
      makeEntry({ selfAssessment: "failed" }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.successRate).toBe(0);
  });

  it("computes correct mixed successRate (2/4 = 0.5)", () => {
    const entries = [
      makeEntry({ selfAssessment: "exceeded" }),
      makeEntry({ selfAssessment: "met" }),
      makeEntry({ selfAssessment: "partial" }),
      makeEntry({ selfAssessment: "failed" }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.successRate).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// buildProfile — qualityScore
// ---------------------------------------------------------------------------

describe("buildProfile — qualityScore", () => {
  it("computes qualityScore=1.0 for all exceeded", () => {
    const entries = [
      makeEntry({ selfAssessment: "exceeded" }),
      makeEntry({ selfAssessment: "exceeded" }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.qualityScore).toBe(1.0);
  });

  it("computes qualityScore=0.75 for all met", () => {
    const entries = [
      makeEntry({ selfAssessment: "met" }),
      makeEntry({ selfAssessment: "met" }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.qualityScore).toBe(0.75);
  });

  it("computes correct mixed qualityScore", () => {
    // exceeded=1.0, met=0.75, partial=0.4, failed=0.0 → avg = (1.0+0.75+0.4+0.0)/4 = 0.5375
    const entries = [
      makeEntry({ selfAssessment: "exceeded" }),
      makeEntry({ selfAssessment: "met" }),
      makeEntry({ selfAssessment: "partial" }),
      makeEntry({ selfAssessment: "failed" }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.qualityScore).toBeCloseTo(0.5375, 4);
  });
});

// ---------------------------------------------------------------------------
// buildProfile — modelMismatchRate
// ---------------------------------------------------------------------------

describe("buildProfile — modelMismatchRate", () => {
  it("computes 0 when all entries have modelTierAppropriate=true", () => {
    const entries = [
      makeEntry({ modelTierAppropriate: true }),
      makeEntry({ modelTierAppropriate: true }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.modelMismatchRate).toBe(0);
  });

  it("computes 1.0 when all entries have modelTierAppropriate=false", () => {
    const entries = [
      makeEntry({ modelTierAppropriate: false }),
      makeEntry({ modelTierAppropriate: false }),
      makeEntry({ modelTierAppropriate: false }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.modelMismatchRate).toBe(1.0);
  });

  it("computes correct mixed mismatchRate (2/4 = 0.5)", () => {
    const entries = [
      makeEntry({ modelTierAppropriate: false }),
      makeEntry({ modelTierAppropriate: false }),
      makeEntry({ modelTierAppropriate: true }),
      makeEntry({ modelTierAppropriate: true }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.modelMismatchRate).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// recommend — null when insufficient samples
// ---------------------------------------------------------------------------

describe("recommend — insufficient samples", () => {
  it("returns null when sampleCount < minSampleCount (default 3)", () => {
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol() });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    // sampleCount=0 < 3
    const rec = router.recommend(profile);
    expect(rec).toBeNull();
  });

  it("returns null with custom minSampleCount of 5 when only 3 entries", () => {
    const entries = [
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
    ];
    const router = new AdaptiveRouter({
      feedbackProtocol: makeProtocol(entries),
      minSampleCount: 5,
    });
    const profile = router.buildProfile("agent-alpha", "opus");
    expect(router.recommend(profile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recommend — downgrade
// ---------------------------------------------------------------------------

describe("recommend — downgrade", () => {
  it("recommends downgrade from opus to sonnet when qualityScore >= 0.8 and mismatchRate >= 0.5", () => {
    // exceeded=1.0 × 4 → qualityScore=1.0; all mismatch → rate=1.0
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "opus");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("sonnet");
    expect(rec!.currentModel).toBe("opus");
  });

  it("includes costSavingsEstimateUsd when downgrading from opus", () => {
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "opus");
    const rec = router.recommend(profile);
    expect(rec!.costSavingsEstimateUsd).toBeDefined();
    expect(rec!.costSavingsEstimateUsd).toBeGreaterThan(0);
  });

  it("recommends downgrade from sonnet to haiku when qualityScore >= 0.8 and mismatchRate >= 0.5", () => {
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("haiku");
  });

  it("does not downgrade below haiku", () => {
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "haiku");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("haiku"); // already at floor
    expect(rec!.currentModel).toBe("haiku");
  });
});

// ---------------------------------------------------------------------------
// recommend — upgrade
// ---------------------------------------------------------------------------

describe("recommend — upgrade", () => {
  it("recommends upgrade from haiku to sonnet when qualityScore < 0.5 and mismatchRate >= 0.5", () => {
    // failed=0 × 4 → qualityScore=0; all mismatch → rate=1.0
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "failed", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "haiku");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("sonnet");
    expect(rec!.currentModel).toBe("haiku");
  });

  it("recommends upgrade from sonnet to opus when qualityScore < 0.5 and mismatchRate >= 0.5", () => {
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "failed", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("opus");
  });

  it("does not upgrade beyond opus", () => {
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "failed", modelTierAppropriate: false }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "opus");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("opus"); // already at ceiling
    expect(rec!.currentModel).toBe("opus");
  });
});

// ---------------------------------------------------------------------------
// recommend — no change
// ---------------------------------------------------------------------------

describe("recommend — no change", () => {
  it("recommends no change when neither threshold is met", () => {
    // qualityScore=0.75 (met), mismatchRate=0.25 — neither condition triggers
    const entries = [
      makeEntry({ selfAssessment: "met", modelTierAppropriate: false }),
      makeEntry({ selfAssessment: "met", modelTierAppropriate: true }),
      makeEntry({ selfAssessment: "met", modelTierAppropriate: true }),
      makeEntry({ selfAssessment: "met", modelTierAppropriate: true }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("sonnet");
    expect(rec!.currentModel).toBe("sonnet");
  });

  it("recommends no change when qualityScore >= 0.8 but mismatchRate < 0.5", () => {
    // exceeded × 4, no mismatches
    const entries = Array.from({ length: 4 }, () =>
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: true }),
    );
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec!.recommendedModel).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// getAllRecommendations
// ---------------------------------------------------------------------------

describe("getAllRecommendations", () => {
  it("returns one recommendation per agent that has enough samples", () => {
    const fpAdapter = new InMemoryFeedbackFileAdapter();
    const fp = new FeedbackProtocol({ fileAdapter: fpAdapter });

    // agent-a: 4 entries (meets minSampleCount=3)
    for (let i = 0; i < 4; i++) {
      fp.recordEntry(makeEntry({ agentId: "agent-a", selfAssessment: "met", modelTierAppropriate: true }));
    }
    // agent-b: 1 entry (below minSampleCount)
    fp.recordEntry(makeEntry({ agentId: "agent-b", selfAssessment: "met", modelTierAppropriate: true }));

    const router = new AdaptiveRouter({ feedbackProtocol: fp });
    const recs = router.getAllRecommendations({ "agent-a": "sonnet", "agent-b": "haiku" });

    const agentIds = recs.map((r) => r.agentId);
    expect(agentIds).toContain("agent-a");
    expect(agentIds).not.toContain("agent-b");
  });

  it("returns correct model recommendations for multiple agents", () => {
    const fp = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });

    // agent-upgrade: low quality, high mismatch → upgrade haiku → sonnet
    for (let i = 0; i < 4; i++) {
      fp.recordEntry(makeEntry({ agentId: "agent-upgrade", selfAssessment: "failed", modelTierAppropriate: false }));
    }
    // agent-downgrade: high quality, high mismatch → downgrade opus → sonnet
    for (let i = 0; i < 4; i++) {
      fp.recordEntry(makeEntry({ agentId: "agent-downgrade", selfAssessment: "exceeded", modelTierAppropriate: false }));
    }

    const router = new AdaptiveRouter({ feedbackProtocol: fp });
    const recs = router.getAllRecommendations({
      "agent-upgrade": "haiku",
      "agent-downgrade": "opus",
    });

    const upgradeRec = recs.find((r) => r.agentId === "agent-upgrade");
    const downgradeRec = recs.find((r) => r.agentId === "agent-downgrade");

    expect(upgradeRec?.recommendedModel).toBe("sonnet");
    expect(downgradeRec?.recommendedModel).toBe("sonnet");
    expect(downgradeRec?.costSavingsEstimateUsd).toBeDefined();
  });

  it("returns empty array when no agents have enough samples", () => {
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol() });
    const recs = router.getAllRecommendations({ "agent-x": "sonnet" });
    expect(recs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getProfile — public access
// ---------------------------------------------------------------------------

describe("getProfile", () => {
  it("returns same profile as buildProfile", () => {
    const entries = [
      makeEntry({ selfAssessment: "met", modelTierAppropriate: true }),
      makeEntry({ selfAssessment: "met", modelTierAppropriate: true }),
      makeEntry({ selfAssessment: "met", modelTierAppropriate: true }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const viaGet = router.getProfile("agent-alpha", "sonnet");
    const viaBuild = router.buildProfile("agent-alpha", "sonnet");
    // Compare key fields (lastUpdated may differ by milliseconds)
    expect(viaGet.agentId).toBe(viaBuild.agentId);
    expect(viaGet.successRate).toBe(viaBuild.successRate);
    expect(viaGet.qualityScore).toBe(viaBuild.qualityScore);
    expect(viaGet.sampleCount).toBe(viaBuild.sampleCount);
  });
});
