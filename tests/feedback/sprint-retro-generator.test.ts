import { describe, it, expect, beforeEach } from "vitest";
import {
  SprintRetroGenerator,
  type RetroReport,
} from "../../src/feedback/sprint-retro-generator.js";
import {
  FeedbackProtocol,
  InMemoryFeedbackFileAdapter,
  type FeedbackEntry,
} from "../../src/feedback/feedback-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let entryCounter = 0;

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  entryCounter += 1;
  return {
    agentId: "agent-default",
    taskId: `task-${entryCounter}`,
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

function makeProtocol(): FeedbackProtocol {
  return new FeedbackProtocol({
    fileAdapter: new InMemoryFeedbackFileAdapter(),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator", () => {
  let protocol: FeedbackProtocol;
  let generator: SprintRetroGenerator;

  beforeEach(() => {
    protocol = makeProtocol();
    generator = new SprintRetroGenerator(protocol);
  });

  // -------------------------------------------------------------------------
  // generateRetro — empty sprint
  // -------------------------------------------------------------------------

  it("generateRetro with no entries returns empty report", () => {
    const report = generator.generateRetro("sprint-empty");
    expect(report.entryCount).toBe(0);
    expect(report.agentCount).toBe(0);
    expect(report.topWins).toEqual([]);
    expect(report.topBlockers).toEqual([]);
    expect(report.topRecommendations).toEqual([]);
    expect(report.agentScores).toEqual([]);
    expect(report.avgSelfAssessment).toBe(0);
    expect(report.modelMismatchCount).toBe(0);
    expect(report.costAnomalies).toEqual([]);
    expect(report.completionRate).toBe(0);
  });

  it("generateRetro sets sprintId on report", () => {
    const report = generator.generateRetro("sprint-42");
    expect(report.sprintId).toBe("sprint-42");
  });

  it("generateRetro sets generatedAt as ISO timestamp", () => {
    const report = generator.generateRetro("sprint-1");
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("generateRetro uses provided version from sprintMeta", () => {
    const report = generator.generateRetro("sprint-1", { version: "4.6.0" });
    expect(report.version).toBe("4.6.0");
  });

  it("generateRetro defaults version to 0.0.0 when sprintMeta omitted", () => {
    const report = generator.generateRetro("sprint-1");
    expect(report.version).toBe("0.0.0");
  });

  // -------------------------------------------------------------------------
  // generateRetro — filtering by sprintId
  // -------------------------------------------------------------------------

  it("generateRetro filters entries by sprintId correctly", () => {
    protocol.recordEntry(makeEntry({ sprintId: "sprint-1", agentId: "agent-a" }));
    protocol.recordEntry(makeEntry({ sprintId: "sprint-2", agentId: "agent-b" }));
    protocol.recordEntry(makeEntry({ sprintId: "sprint-1", agentId: "agent-c" }));

    const report = generator.generateRetro("sprint-1");
    expect(report.entryCount).toBe(2);
    expect(report.agentCount).toBe(2);
  });

  it("generateRetro returns 0 entries for unknown sprintId", () => {
    protocol.recordEntry(makeEntry({ sprintId: "sprint-1" }));
    const report = generator.generateRetro("sprint-unknown");
    expect(report.entryCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // generateRetro — topWins
  // -------------------------------------------------------------------------

  it("generateRetro computes correct topWins frequency ranked with counts", () => {
    protocol.recordEntry(makeEntry({ whatWorked: ["pair programming", "CI fixed"] }));
    protocol.recordEntry(makeEntry({ whatWorked: ["pair programming", "docs"] }));
    protocol.recordEntry(makeEntry({ whatWorked: ["pair programming"] }));
    protocol.recordEntry(makeEntry({ whatWorked: ["CI fixed"] }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topWins[0]).toEqual({ item: "pair programming", mentions: 3 });
    expect(report.topWins[1]).toEqual({ item: "CI fixed", mentions: 2 });
    expect(report.topWins[2]).toEqual({ item: "docs", mentions: 1 });
  });

  it("generateRetro returns at most 5 topWins", () => {
    // Create 7 distinct wins, each with 1 mention
    const wins = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
    protocol.recordEntry(makeEntry({ whatWorked: wins }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topWins.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // generateRetro — topBlockers
  // -------------------------------------------------------------------------

  it("generateRetro computes correct topBlockers frequency ranked with counts", () => {
    protocol.recordEntry(makeEntry({ blockers: ["flaky tests", "env issues"] }));
    protocol.recordEntry(makeEntry({ blockers: ["flaky tests", "slow CI"] }));
    protocol.recordEntry(makeEntry({ blockers: ["flaky tests"] }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topBlockers[0]).toEqual({ item: "flaky tests", mentions: 3 });
    expect(report.topBlockers[1].mentions).toBe(1);
  });

  // -------------------------------------------------------------------------
  // generateRetro — topRecommendations
  // -------------------------------------------------------------------------

  it("generateRetro computes correct topRecommendations frequency ranked", () => {
    protocol.recordEntry(makeEntry({ recommendations: ["add retries", "fix linting"] }));
    protocol.recordEntry(makeEntry({ recommendations: ["add retries"] }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topRecommendations[0]).toEqual({ item: "add retries", mentions: 2 });
    expect(report.topRecommendations[1]).toEqual({ item: "fix linting", mentions: 1 });
  });

  // -------------------------------------------------------------------------
  // generateRetro — avgSelfAssessment
  // -------------------------------------------------------------------------

  it("generateRetro computes correct avgSelfAssessment", () => {
    protocol.recordEntry(makeEntry({ selfAssessment: "exceeded" })); // 3
    protocol.recordEntry(makeEntry({ selfAssessment: "met" })); // 2
    protocol.recordEntry(makeEntry({ selfAssessment: "partial" })); // 1
    protocol.recordEntry(makeEntry({ selfAssessment: "failed" })); // 0

    const report = generator.generateRetro("sprint-1");
    // (3+2+1+0)/4 = 1.5
    expect(report.avgSelfAssessment).toBeCloseTo(1.5, 5);
  });

  it("generateRetro avgSelfAssessment is 0 for empty sprint", () => {
    const report = generator.generateRetro("sprint-empty");
    expect(report.avgSelfAssessment).toBe(0);
  });

  // -------------------------------------------------------------------------
  // generateRetro — modelMismatchCount
  // -------------------------------------------------------------------------

  it("generateRetro counts model mismatches correctly", () => {
    protocol.recordEntry(makeEntry({ modelTierAppropriate: true }));
    protocol.recordEntry(makeEntry({ modelTierAppropriate: false }));
    protocol.recordEntry(makeEntry({ modelTierAppropriate: false }));

    const report = generator.generateRetro("sprint-1");
    expect(report.modelMismatchCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // generateRetro — agentScores
  // -------------------------------------------------------------------------

  it("generateRetro computes agentScores per agent", () => {
    protocol.recordEntry(makeEntry({ agentId: "agent-a", selfAssessment: "exceeded" })); // 3
    protocol.recordEntry(makeEntry({ agentId: "agent-a", selfAssessment: "met" })); // 2
    protocol.recordEntry(makeEntry({ agentId: "agent-b", selfAssessment: "failed" })); // 0

    const report = generator.generateRetro("sprint-1");
    const agentA = report.agentScores.find((s) => s.agentId === "agent-a");
    const agentB = report.agentScores.find((s) => s.agentId === "agent-b");

    expect(agentA).toBeDefined();
    expect(agentA!.score).toBeCloseTo(2.5, 5); // (3+2)/2
    expect(agentA!.entries).toBe(2);

    expect(agentB).toBeDefined();
    expect(agentB!.score).toBeCloseTo(0, 5);
    expect(agentB!.entries).toBe(1);
  });

  it("generateRetro agentScores is empty for empty sprint", () => {
    const report = generator.generateRetro("sprint-empty");
    expect(report.agentScores).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // generateRetro — velocity / sprintMeta
  // -------------------------------------------------------------------------

  it("generateRetro uses provided tasksCompleted and tasksPlanned", () => {
    const report = generator.generateRetro("sprint-1", {
      tasksCompleted: 8,
      tasksPlanned: 10,
    });
    expect(report.tasksCompleted).toBe(8);
    expect(report.tasksPlanned).toBe(10);
  });

  it("generateRetro sets completionRate correctly", () => {
    const report = generator.generateRetro("sprint-1", {
      tasksCompleted: 8,
      tasksPlanned: 10,
    });
    expect(report.completionRate).toBeCloseTo(0.8, 5);
  });

  it("generateRetro completionRate is 0 when tasksPlanned is 0", () => {
    const report = generator.generateRetro("sprint-1", { tasksCompleted: 5, tasksPlanned: 0 });
    expect(report.completionRate).toBe(0);
  });

  it("generateRetro completionRate defaults to 0 when sprintMeta omitted", () => {
    const report = generator.generateRetro("sprint-1");
    expect(report.completionRate).toBe(0);
    expect(report.tasksCompleted).toBe(0);
    expect(report.tasksPlanned).toBe(0);
  });

  // -------------------------------------------------------------------------
  // generateRetro — costAnomalies
  // -------------------------------------------------------------------------

  it("generateRetro returns empty costAnomalies when no entries", () => {
    const report = generator.generateRetro("sprint-empty");
    expect(report.costAnomalies).toEqual([]);
  });

  it("generateRetro returns empty costAnomalies when all timeSpentMs is 0", () => {
    protocol.recordEntry(makeEntry({ agentId: "agent-x", timeSpentMs: 0 }));
    protocol.recordEntry(makeEntry({ agentId: "agent-y", timeSpentMs: 0 }));
    const report = generator.generateRetro("sprint-1");
    expect(report.costAnomalies).toEqual([]);
  });

  it("generateRetro detects cost anomaly for agent >2x sprint average", () => {
    // sprint average = (100+100+1000)/3 ≈ 400, agent-heavy avg = 1000 > 800
    protocol.recordEntry(makeEntry({ agentId: "agent-light", timeSpentMs: 100 }));
    protocol.recordEntry(makeEntry({ agentId: "agent-light", timeSpentMs: 100 }));
    protocol.recordEntry(makeEntry({ agentId: "agent-heavy", timeSpentMs: 1000 }));

    const report = generator.generateRetro("sprint-1");
    expect(report.costAnomalies).toContain("agent-heavy");
    expect(report.costAnomalies).not.toContain("agent-light");
  });

  // -------------------------------------------------------------------------
  // generateMarkdown
  // -------------------------------------------------------------------------

  it("generateMarkdown includes all sections", () => {
    const report = generator.generateRetro("sprint-1", {
      version: "4.6.0",
      tasksCompleted: 5,
      tasksPlanned: 10,
    });
    const md = generator.generateMarkdown(report);

    expect(md).toContain("# Sprint Retrospective — sprint-1 (v4.6.0)");
    expect(md).toContain("Generated:");
    expect(md).toContain("Entries:");
    expect(md).toContain("Sprint Completion:");
    expect(md).toContain("Avg Self-Assessment:");
    expect(md).toContain("Model Mismatches:");
    expect(md).toContain("## Top Wins");
    expect(md).toContain("## Top Blockers");
    expect(md).toContain("## Top Recommendations");
    expect(md).toContain("## Agent Performance");
    expect(md).toContain("| Agent | Score | Entries |");
  });

  it("generateMarkdown formats completionRate as percentage", () => {
    const report = generator.generateRetro("sprint-1", {
      tasksCompleted: 7,
      tasksPlanned: 10,
    });
    const md = generator.generateMarkdown(report);
    expect(md).toContain("7/10 (70%)");
  });

  it("generateMarkdown shows _none_ when topWins is empty", () => {
    const report = generator.generateRetro("sprint-empty");
    const md = generator.generateMarkdown(report);
    // Find the wins section
    const winsSection = md.split("## Top Wins")[1]?.split("##")[0] ?? "";
    expect(winsSection).toContain("_none_");
  });

  it("generateMarkdown shows _none_ when topBlockers is empty", () => {
    const report = generator.generateRetro("sprint-empty");
    const md = generator.generateMarkdown(report);
    const blockersSection = md.split("## Top Blockers")[1]?.split("##")[0] ?? "";
    expect(blockersSection).toContain("_none_");
  });

  it("generateMarkdown shows _none_ when topRecommendations is empty", () => {
    const report = generator.generateRetro("sprint-empty");
    const md = generator.generateMarkdown(report);
    const recoSection = md.split("## Top Recommendations")[1]?.split("##")[0] ?? "";
    expect(recoSection).toContain("_none_");
  });

  it("generateMarkdown lists wins with mention counts", () => {
    protocol.recordEntry(makeEntry({ whatWorked: ["great teamwork", "great teamwork"] }));

    const report = generator.generateRetro("sprint-1");
    const md = generator.generateMarkdown(report);
    expect(md).toContain("great teamwork");
    expect(md).toMatch(/\d+ mention/);
  });

  it("generateMarkdown includes agent performance table rows", () => {
    protocol.recordEntry(
      makeEntry({ agentId: "coder-agent", selfAssessment: "exceeded" }),
    );

    const report = generator.generateRetro("sprint-1");
    const md = generator.generateMarkdown(report);
    expect(md).toContain("coder-agent");
    expect(md).toContain("/3.0");
  });

  it("generateMarkdown completionRate 100% renders correctly", () => {
    const report = generator.generateRetro("sprint-1", {
      tasksCompleted: 10,
      tasksPlanned: 10,
    });
    const md = generator.generateMarkdown(report);
    expect(md).toContain("10/10 (100%)");
  });
});
