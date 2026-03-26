import { describe, it, expect } from "vitest";
import { AdaptiveRouter } from "../../src/routing/adaptive-router.js";
import { FeedbackProtocol, InMemoryFeedbackFileAdapter } from "../../src/feedback/feedback-protocol.js";
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
  const fp = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
  for (const e of entries) fp.recordEntry(e);
  return fp;
}

function nEntries(n: number, overrides: Partial<FeedbackEntry> = {}): FeedbackEntry[] {
  return Array.from({ length: n }, (_, i) => makeEntry({ taskId: `task-${i}`, ...overrides }));
}

// ---------------------------------------------------------------------------
// getAllRecommendations — empty / skipping
// ---------------------------------------------------------------------------

describe("getAllRecommendations — edge cases", () => {
  it("returns empty array when agent map is empty", () => {
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol() });
    const recs = router.getAllRecommendations({});
    expect(recs).toEqual([]);
  });

  it("skips agents with 0 samples (below default minSampleCount=3)", () => {
    const fp = makeProtocol();
    // No entries at all
    const router = new AdaptiveRouter({ feedbackProtocol: fp });
    const recs = router.getAllRecommendations({ "no-data-agent": "sonnet" });
    expect(recs).toHaveLength(0);
  });

  it("skips agents with samples below custom minSampleCount", () => {
    const fp = makeProtocol(nEntries(4, { agentId: "partially-sampled" }));
    const router = new AdaptiveRouter({ feedbackProtocol: fp, minSampleCount: 10 });
    const recs = router.getAllRecommendations({ "partially-sampled": "sonnet" });
    expect(recs).toHaveLength(0);
  });

  it("includes agents that exactly meet minSampleCount", () => {
    const fp = makeProtocol(nEntries(3, { agentId: "exact-count" }));
    const router = new AdaptiveRouter({ feedbackProtocol: fp, minSampleCount: 3 });
    const recs = router.getAllRecommendations({ "exact-count": "sonnet" });
    expect(recs).toHaveLength(1);
  });

  it("multiple agents: qualifies some, skips others", () => {
    const fp = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    // agent-qualified: 4 entries
    for (const e of nEntries(4, { agentId: "agent-qualified" })) fp.recordEntry(e);
    // agent-too-few: 1 entry
    fp.recordEntry(makeEntry({ agentId: "agent-too-few" }));

    const router = new AdaptiveRouter({ feedbackProtocol: fp });
    const recs = router.getAllRecommendations({
      "agent-qualified": "sonnet",
      "agent-too-few": "haiku",
    });

    const ids = recs.map((r) => r.agentId);
    expect(ids).toContain("agent-qualified");
    expect(ids).not.toContain("agent-too-few");
  });
});

// ---------------------------------------------------------------------------
// buildProfile — boundary conditions
// ---------------------------------------------------------------------------

describe("buildProfile — boundary conditions", () => {
  it("profile with exactly minSampleCount entries (3) is valid for recommendation", () => {
    const entries = nEntries(3, {
      agentId: "boundary-agent",
      selfAssessment: "met",
      modelTierAppropriate: true,
    });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("boundary-agent", "sonnet");
    expect(profile.sampleCount).toBe(3);
    // With 3 samples the router should be able to produce a recommendation
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
  });

  it("profile with all modelTierAppropriate=true has mismatchRate=0", () => {
    const entries = nEntries(5, { modelTierAppropriate: true });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.modelMismatchRate).toBe(0);
  });

  it("profile with all modelTierAppropriate=false has mismatchRate=1.0", () => {
    const entries = nEntries(5, { modelTierAppropriate: false });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    expect(profile.modelMismatchRate).toBe(1.0);
  });

  it("profile sampleCount reflects only entries for that agent", () => {
    const fp = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    for (const e of nEntries(4, { agentId: "agent-a" })) fp.recordEntry(e);
    for (const e of nEntries(7, { agentId: "agent-b" })) fp.recordEntry(e);

    const router = new AdaptiveRouter({ feedbackProtocol: fp });
    expect(router.buildProfile("agent-a", "sonnet").sampleCount).toBe(4);
    expect(router.buildProfile("agent-b", "haiku").sampleCount).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// recommend — specific upgrade/downgrade paths
// ---------------------------------------------------------------------------

describe("recommend — sonnet to opus upgrade", () => {
  it("recommends sonnet→opus upgrade when qualityScore < 0.5 and mismatchRate >= 0.5", () => {
    const entries = nEntries(4, {
      selfAssessment: "failed",
      modelTierAppropriate: false,
    });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("opus");
    expect(rec!.currentModel).toBe("sonnet");
  });
});

describe("recommend — sonnet to haiku downgrade", () => {
  it("recommends sonnet→haiku downgrade when qualityScore >= 0.8 and mismatchRate >= 0.5", () => {
    const entries = nEntries(4, {
      selfAssessment: "exceeded",
      modelTierAppropriate: false,
    });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("haiku");
    expect(rec!.currentModel).toBe("sonnet");
  });
});

describe("recommend — no change for middle range quality", () => {
  it("no change when qualityScore is in middle range (~0.75) and low mismatch", () => {
    // all met = qualityScore=0.75, all appropriate → mismatchRate=0
    const entries = nEntries(4, { selfAssessment: "met", modelTierAppropriate: true });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("sonnet");
  });

  it("no change when qualityScore is mid-range (0.5-0.8) regardless of mismatch", () => {
    // partial=0.4, exceeded=1.0 → avg=0.7, which is < 0.8 so no downgrade; > 0.5 so no upgrade
    const entries = [
      makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
      makeEntry({ selfAssessment: "partial", modelTierAppropriate: false }),
      makeEntry({ selfAssessment: "partial", modelTierAppropriate: false }),
      makeEntry({ selfAssessment: "partial", modelTierAppropriate: false }),
    ];
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "sonnet");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("sonnet");
  });

  it("no change when mismatchRate < 0.5 even with high quality", () => {
    const entries = nEntries(4, { selfAssessment: "exceeded", modelTierAppropriate: true });
    const router = new AdaptiveRouter({ feedbackProtocol: makeProtocol(entries) });
    const profile = router.buildProfile("agent-alpha", "opus");
    const rec = router.recommend(profile);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedModel).toBe("opus"); // no downgrade — mismatchRate too low
  });
});

describe("recommend — multiple agents, mixed eligibility", () => {
  it("each agent gets the correct recommendation independently", () => {
    const fp = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });

    // agent-high: exceeded + mismatch → downgrade from opus
    for (const e of nEntries(4, { agentId: "agent-high", selfAssessment: "exceeded", modelTierAppropriate: false })) {
      fp.recordEntry(e);
    }
    // agent-low: failed + mismatch → upgrade from haiku
    for (const e of nEntries(4, { agentId: "agent-low", selfAssessment: "failed", modelTierAppropriate: false })) {
      fp.recordEntry(e);
    }
    // agent-stable: met + no mismatch → no change (sonnet stays sonnet)
    for (const e of nEntries(4, { agentId: "agent-stable", selfAssessment: "met", modelTierAppropriate: true })) {
      fp.recordEntry(e);
    }

    const router = new AdaptiveRouter({ feedbackProtocol: fp });
    const recs = router.getAllRecommendations({
      "agent-high": "opus",
      "agent-low": "haiku",
      "agent-stable": "sonnet",
    });

    const highRec = recs.find((r) => r.agentId === "agent-high");
    const lowRec = recs.find((r) => r.agentId === "agent-low");
    const stableRec = recs.find((r) => r.agentId === "agent-stable");

    expect(highRec?.recommendedModel).toBe("sonnet");
    expect(lowRec?.recommendedModel).toBe("sonnet");
    expect(stableRec?.recommendedModel).toBe("sonnet");
  });
});
