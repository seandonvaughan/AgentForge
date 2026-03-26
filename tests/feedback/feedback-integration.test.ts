import { describe, it, expect, beforeEach } from "vitest";
import {
  FeedbackProtocol,
  InMemoryFeedbackFileAdapter,
  type FeedbackEntry,
} from "../../src/feedback/feedback-protocol.js";
import { SprintRetroGenerator } from "../../src/feedback/sprint-retro-generator.js";
import { AdaptiveRouter } from "../../src/routing/adaptive-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  counter += 1;
  return {
    agentId: "agent-a",
    taskId: `task-${counter}`,
    sprintId: "sprint-1",
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

function makeProtocolWithAdapter(): { protocol: FeedbackProtocol; adapter: InMemoryFeedbackFileAdapter } {
  const adapter = new InMemoryFeedbackFileAdapter();
  const protocol = new FeedbackProtocol({ fileAdapter: adapter });
  return { protocol, adapter };
}

// ---------------------------------------------------------------------------
// Multi-sprint, multi-agent population
// ---------------------------------------------------------------------------

describe("feedback integration — multi-agent, multi-sprint", () => {
  let protocol: FeedbackProtocol;
  let generator: SprintRetroGenerator;
  let router: AdaptiveRouter;

  beforeEach(() => {
    const { protocol: p } = makeProtocolWithAdapter();
    protocol = p;
    generator = new SprintRetroGenerator(protocol);
    router = new AdaptiveRouter({ feedbackProtocol: protocol });

    // Agent-A: sprint-1 (3 entries)
    protocol.recordEntry(makeEntry({ agentId: "agent-a", sprintId: "sprint-1", selfAssessment: "exceeded", whatWorked: ["parallel exec"], blockers: ["slow CI"] }));
    protocol.recordEntry(makeEntry({ agentId: "agent-a", sprintId: "sprint-1", selfAssessment: "met", whatWorked: ["caching"], blockers: ["slow CI"] }));
    protocol.recordEntry(makeEntry({ agentId: "agent-a", sprintId: "sprint-1", selfAssessment: "met", whatWorked: ["caching"] }));

    // Agent-A: sprint-2 (2 entries)
    protocol.recordEntry(makeEntry({ agentId: "agent-a", sprintId: "sprint-2", selfAssessment: "failed", modelTierAppropriate: false }));
    protocol.recordEntry(makeEntry({ agentId: "agent-a", sprintId: "sprint-2", selfAssessment: "failed", modelTierAppropriate: false }));

    // Agent-B: sprint-1 (3 entries)
    protocol.recordEntry(makeEntry({ agentId: "agent-b", sprintId: "sprint-1", selfAssessment: "exceeded", modelTierAppropriate: false, whatWorked: ["parallel exec"] }));
    protocol.recordEntry(makeEntry({ agentId: "agent-b", sprintId: "sprint-1", selfAssessment: "exceeded", modelTierAppropriate: false }));
    protocol.recordEntry(makeEntry({ agentId: "agent-b", sprintId: "sprint-1", selfAssessment: "partial", modelTierAppropriate: true }));

    // Agent-B: sprint-2 (2 entries)
    protocol.recordEntry(makeEntry({ agentId: "agent-b", sprintId: "sprint-2", selfAssessment: "met" }));
    protocol.recordEntry(makeEntry({ agentId: "agent-b", sprintId: "sprint-2", selfAssessment: "met" }));
  });

  it("sprint-1 retro includes exactly 6 entries (3 agent-a + 3 agent-b)", () => {
    const report = generator.generateRetro("sprint-1");
    expect(report.entryCount).toBe(6);
  });

  it("sprint-1 retro includes exactly 2 agents", () => {
    const report = generator.generateRetro("sprint-1");
    expect(report.agentCount).toBe(2);
  });

  it("sprint-2 retro includes exactly 4 entries (2 agent-a + 2 agent-b)", () => {
    const report = generator.generateRetro("sprint-2");
    expect(report.entryCount).toBe(4);
  });

  it("sprint-1 retro does NOT contain sprint-2 entries", () => {
    const report = generator.generateRetro("sprint-1");
    // agent-a sprint-2 had selfAssessment=failed (score 0); sprint-1 agent-a has exceeded+met+met = avg 2.33
    const agentA = report.agentScores.find((s) => s.agentId === "agent-a");
    expect(agentA?.score).toBeGreaterThan(1.5);
  });

  it("sprint-2 retro does NOT contain sprint-1 entries", () => {
    const report = generator.generateRetro("sprint-2");
    const agentA = report.agentScores.find((s) => s.agentId === "agent-a");
    expect(agentA?.score).toBe(0); // sprint-2 only has failed entries
  });

  it("router builds profile for agent-a using all 5 entries across sprints", () => {
    const profile = router.buildProfile("agent-a", "sonnet");
    expect(profile.sampleCount).toBe(5);
  });

  it("router builds profile for agent-b using all 5 entries across sprints", () => {
    const profile = router.buildProfile("agent-b", "opus");
    expect(profile.sampleCount).toBe(5);
  });

  it("getAllRecommendations returns recommendations for both agents (5 samples each >= default 3)", () => {
    const recs = router.getAllRecommendations({ "agent-a": "sonnet", "agent-b": "opus" });
    const ids = recs.map((r) => r.agentId);
    expect(ids).toContain("agent-a");
    expect(ids).toContain("agent-b");
  });

  it("sprint-1 topWins includes 'parallel exec' from two agents", () => {
    const report = generator.generateRetro("sprint-1");
    const parallelExec = report.topWins.find((w) => w.item === "parallel exec");
    expect(parallelExec).toBeDefined();
    expect(parallelExec!.mentions).toBe(2);
  });

  it("sprint-1 topBlockers includes 'slow CI' with 2 mentions from agent-a", () => {
    const report = generator.generateRetro("sprint-1");
    const slowCI = report.topBlockers.find((b) => b.item === "slow CI");
    expect(slowCI).toBeDefined();
    expect(slowCI!.mentions).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: write → save → load → generate retro
// ---------------------------------------------------------------------------

describe("feedback integration — full round-trip persistence", () => {
  it("save/load preserves entries and generates correct retro", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const protocol = new FeedbackProtocol({ fileAdapter: adapter });
    const generator = new SprintRetroGenerator(protocol);

    protocol.recordEntry(makeEntry({ sprintId: "s1", agentId: "arch", selfAssessment: "exceeded", whatWorked: ["fast typing"] }));
    protocol.recordEntry(makeEntry({ sprintId: "s1", agentId: "cto", selfAssessment: "met", whatWorked: ["fast typing"] }));
    protocol.recordEntry(makeEntry({ sprintId: "s2", agentId: "arch", selfAssessment: "failed" }));

    protocol.save("/tmp/rt-feedback.json");

    const restored = FeedbackProtocol.load("/tmp/rt-feedback.json", { fileAdapter: adapter });
    const restoredGenerator = new SprintRetroGenerator(restored);
    const report = restoredGenerator.generateRetro("s1");

    expect(report.entryCount).toBe(2);
    expect(report.topWins[0].item).toBe("fast typing");
    expect(report.topWins[0].mentions).toBe(2);
  });

  it("loaded protocol supports new entry and re-generates retro correctly", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const p1 = new FeedbackProtocol({ fileAdapter: adapter });

    p1.recordEntry(makeEntry({ sprintId: "s5", selfAssessment: "met" }));
    p1.save("/tmp/rt2.json");

    const p2 = FeedbackProtocol.load("/tmp/rt2.json", { fileAdapter: adapter });
    p2.recordEntry(makeEntry({ sprintId: "s5", selfAssessment: "exceeded" }));

    const gen = new SprintRetroGenerator(p2);
    const report = gen.generateRetro("s5");

    expect(report.entryCount).toBe(2);
    expect(report.avgSelfAssessment).toBeCloseTo(2.5, 5); // (2+3)/2
  });

  it("autoSave round-trip: autoSave writes then load reads same entries", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const p = new FeedbackProtocol({
      fileAdapter: adapter,
      autoSavePath: "/tmp/auto-rt.json",
    });

    p.recordEntry(makeEntry({ sprintId: "s-auto", agentId: "agent-rt", selfAssessment: "exceeded" }));
    p.recordEntry(makeEntry({ sprintId: "s-auto", agentId: "agent-rt", selfAssessment: "met" }));

    expect(adapter.fileExists("/tmp/auto-rt.json")).toBe(true);

    const restored = FeedbackProtocol.load("/tmp/auto-rt.json", { fileAdapter: adapter });
    expect(restored.getEntries()).toHaveLength(2);

    const gen = new SprintRetroGenerator(restored);
    const report = gen.generateRetro("s-auto");
    expect(report.entryCount).toBe(2);
    expect(report.avgSelfAssessment).toBeCloseTo(2.5, 5);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: all-failed, all-exceeded, mixed sprint
// ---------------------------------------------------------------------------

describe("feedback integration — sprint edge cases", () => {
  it("all-failed sprint: avgSelfAssessment=0, modelMismatchCount=0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const gen = new SprintRetroGenerator(protocol);

    for (let i = 0; i < 4; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "all-fail", selfAssessment: "failed", modelTierAppropriate: true }));
    }
    const report = gen.generateRetro("all-fail");
    expect(report.avgSelfAssessment).toBe(0);
    expect(report.modelMismatchCount).toBe(0);
  });

  it("all-exceeded sprint: avgSelfAssessment=3.0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const gen = new SprintRetroGenerator(protocol);

    for (let i = 0; i < 4; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "all-exceed", selfAssessment: "exceeded" }));
    }
    const report = gen.generateRetro("all-exceed");
    expect(report.avgSelfAssessment).toBe(3.0);
  });

  it("all-failed sprint produces correct router profile: successRate=0, qualityScore=0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const router = new AdaptiveRouter({ feedbackProtocol: protocol });

    for (let i = 0; i < 4; i++) {
      protocol.recordEntry(makeEntry({ agentId: "fail-agent", sprintId: "all-fail", selfAssessment: "failed", modelTierAppropriate: false }));
    }
    const profile = router.buildProfile("fail-agent", "haiku");
    expect(profile.successRate).toBe(0);
    expect(profile.qualityScore).toBe(0);
  });

  it("all-exceeded sprint produces correct router profile: successRate=1.0, qualityScore=1.0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const router = new AdaptiveRouter({ feedbackProtocol: protocol });

    for (let i = 0; i < 4; i++) {
      protocol.recordEntry(makeEntry({ agentId: "star-agent", sprintId: "all-exceed", selfAssessment: "exceeded", modelTierAppropriate: true }));
    }
    const profile = router.buildProfile("star-agent", "opus");
    expect(profile.successRate).toBe(1.0);
    expect(profile.qualityScore).toBe(1.0);
  });

  it("mixed sprint: retro and router see same pool of entries", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const gen = new SprintRetroGenerator(protocol);
    const router = new AdaptiveRouter({ feedbackProtocol: protocol });

    protocol.recordEntry(makeEntry({ agentId: "mix-agent", sprintId: "mixed", selfAssessment: "exceeded", modelTierAppropriate: false }));
    protocol.recordEntry(makeEntry({ agentId: "mix-agent", sprintId: "mixed", selfAssessment: "failed", modelTierAppropriate: false }));
    protocol.recordEntry(makeEntry({ agentId: "mix-agent", sprintId: "mixed", selfAssessment: "met", modelTierAppropriate: true }));

    const report = gen.generateRetro("mixed");
    const profile = router.buildProfile("mix-agent", "sonnet");

    expect(report.entryCount).toBe(3);
    expect(profile.sampleCount).toBe(3);
    // avgSelfAssessment = (3+0+2)/3 = 1.667
    expect(report.avgSelfAssessment).toBeCloseTo(5 / 3, 3);
  });
});

// ---------------------------------------------------------------------------
// Retros for two sprints side by side
// ---------------------------------------------------------------------------

describe("feedback integration — two retros side by side", () => {
  it("sprint-1 and sprint-2 produce independent retros", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const gen = new SprintRetroGenerator(protocol);

    protocol.recordEntry(makeEntry({ sprintId: "sprint-A", agentId: "agent-x", selfAssessment: "exceeded", whatWorked: ["fast deploy"] }));
    protocol.recordEntry(makeEntry({ sprintId: "sprint-A", agentId: "agent-y", selfAssessment: "met", whatWorked: ["fast deploy"] }));
    protocol.recordEntry(makeEntry({ sprintId: "sprint-B", agentId: "agent-x", selfAssessment: "partial", whatWorked: ["new cache"] }));

    const retroA = gen.generateRetro("sprint-A");
    const retroB = gen.generateRetro("sprint-B");

    expect(retroA.entryCount).toBe(2);
    expect(retroB.entryCount).toBe(1);

    expect(retroA.topWins[0].item).toBe("fast deploy");
    expect(retroB.topWins[0].item).toBe("new cache");
    expect(retroA.topWins[0].mentions).toBe(2);
    expect(retroB.topWins[0].mentions).toBe(1);
  });
});
