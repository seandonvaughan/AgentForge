import { describe, it, expect, beforeEach } from "vitest";
import {
  SprintRetroGenerator,
} from "../../src/feedback/sprint-retro-generator.js";
import {
  FeedbackProtocol,
  InMemoryFeedbackFileAdapter,
  type FeedbackEntry,
} from "../../src/feedback/feedback-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  idCounter += 1;
  return {
    agentId: "agent-default",
    taskId: `task-${idCounter}`,
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

function makeGenerator(): { protocol: FeedbackProtocol; generator: SprintRetroGenerator } {
  const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
  const generator = new SprintRetroGenerator(protocol);
  return { protocol, generator };
}

// ---------------------------------------------------------------------------
// Single agent, multiple entries
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — single agent, multiple entries", () => {
  it("single agent with 5 entries produces agentScores with 1 item", () => {
    const { protocol, generator } = makeGenerator();
    for (let i = 0; i < 5; i++) {
      protocol.recordEntry(makeEntry({ agentId: "solo-agent", selfAssessment: "met" }));
    }
    const report = generator.generateRetro("sprint-1");
    expect(report.agentScores).toHaveLength(1);
    expect(report.agentScores[0].agentId).toBe("solo-agent");
    expect(report.agentScores[0].entries).toBe(5);
  });

  it("single agent mixed assessments computes correct average score", () => {
    const { protocol, generator } = makeGenerator();
    // exceeded(3) + met(2) + partial(1) + failed(0) = 6 / 4 = 1.5
    protocol.recordEntry(makeEntry({ agentId: "solo-agent", selfAssessment: "exceeded" }));
    protocol.recordEntry(makeEntry({ agentId: "solo-agent", selfAssessment: "met" }));
    protocol.recordEntry(makeEntry({ agentId: "solo-agent", selfAssessment: "partial" }));
    protocol.recordEntry(makeEntry({ agentId: "solo-agent", selfAssessment: "failed" }));

    const report = generator.generateRetro("sprint-1");
    expect(report.agentScores[0].score).toBeCloseTo(1.5, 5);
  });
});

// ---------------------------------------------------------------------------
// topWins capped at 5
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — topWins capped at 5", () => {
  it("topWins returns at most 5 items even when 10 unique wins exist", () => {
    const { protocol, generator } = makeGenerator();
    const wins = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"];
    protocol.recordEntry(makeEntry({ whatWorked: wins }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topWins.length).toBeLessThanOrEqual(5);
  });

  it("topWins with exactly 5 unique items returns all 5", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ whatWorked: ["a", "b", "c", "d", "e"] }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topWins.length).toBe(5);
  });

  it("topWins with fewer than 5 items returns all of them", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ whatWorked: ["x", "y"] }));

    const report = generator.generateRetro("sprint-1");
    expect(report.topWins.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// topBlockers — all unique (no frequency > 1)
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — unique blockers", () => {
  it("sprint where all blockers are unique — no blocker has mentions > 1", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ blockers: ["blocker-A"] }));
    protocol.recordEntry(makeEntry({ blockers: ["blocker-B"] }));
    protocol.recordEntry(makeEntry({ blockers: ["blocker-C"] }));

    const report = generator.generateRetro("sprint-1");
    for (const b of report.topBlockers) {
      expect(b.mentions).toBe(1);
    }
  });

  it("duplicate blocker shows higher frequency than unique ones", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ blockers: ["repeated-blocker"] }));
    protocol.recordEntry(makeEntry({ blockers: ["repeated-blocker"] }));
    protocol.recordEntry(makeEntry({ blockers: ["one-off"] }));

    const report = generator.generateRetro("sprint-1");
    const repeated = report.topBlockers.find((b) => b.item === "repeated-blocker");
    const oneOff = report.topBlockers.find((b) => b.item === "one-off");
    expect(repeated?.mentions).toBe(2);
    expect(oneOff?.mentions).toBe(1);
    expect(report.topBlockers[0].item).toBe("repeated-blocker");
  });
});

// ---------------------------------------------------------------------------
// agentScores sorted by score descending
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — agentScores sorted descending", () => {
  it("agentScores are ordered highest score first", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ agentId: "low-scorer", selfAssessment: "failed" }));
    protocol.recordEntry(makeEntry({ agentId: "mid-scorer", selfAssessment: "met" }));
    protocol.recordEntry(makeEntry({ agentId: "top-scorer", selfAssessment: "exceeded" }));

    const report = generator.generateRetro("sprint-1");
    const scores = report.agentScores.map((s) => s.score);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });

  it("top-scorer appears first in agentScores", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ agentId: "agent-z", selfAssessment: "failed" }));
    protocol.recordEntry(makeEntry({ agentId: "agent-a", selfAssessment: "exceeded" }));

    const report = generator.generateRetro("sprint-1");
    expect(report.agentScores[0].agentId).toBe("agent-a");
  });
});

// ---------------------------------------------------------------------------
// Markdown table with 5+ agents
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — markdown table with many agents", () => {
  it("markdown agent performance table includes all 5 agents", () => {
    const { protocol, generator } = makeGenerator();
    for (let i = 1; i <= 5; i++) {
      protocol.recordEntry(makeEntry({ agentId: `agent-${i}`, selfAssessment: "met" }));
    }

    const report = generator.generateRetro("sprint-1");
    const md = generator.generateMarkdown(report);

    for (let i = 1; i <= 5; i++) {
      expect(md).toContain(`agent-${i}`);
    }
  });

  it("markdown table header exists with correct columns", () => {
    const { protocol, generator } = makeGenerator();
    protocol.recordEntry(makeEntry({ agentId: "some-agent", selfAssessment: "met" }));

    const report = generator.generateRetro("sprint-1");
    const md = generator.generateMarkdown(report);

    expect(md).toContain("| Agent | Score | Entries |");
  });
});

// ---------------------------------------------------------------------------
// generateRetro with no sprintMeta — defaults
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — no sprintMeta defaults", () => {
  it("tasksCompleted defaults to 0 when sprintMeta omitted", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("sprint-defaults");
    expect(report.tasksCompleted).toBe(0);
  });

  it("tasksPlanned defaults to 0 when sprintMeta omitted", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("sprint-defaults");
    expect(report.tasksPlanned).toBe(0);
  });

  it("completionRate defaults to 0 when no sprintMeta provided", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("sprint-defaults");
    expect(report.completionRate).toBe(0);
  });

  it("version defaults to 0.0.0 when sprintMeta omitted", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("sprint-defaults");
    expect(report.version).toBe("0.0.0");
  });

  it("sprintMeta with only version still defaults tasksCompleted/tasksPlanned to 0", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("sprint-1", { version: "4.6.0" });
    expect(report.tasksCompleted).toBe(0);
    expect(report.tasksPlanned).toBe(0);
    expect(report.version).toBe("4.6.0");
  });

  it("sprintMeta with only tasksCompleted and tasksPlanned leaves version as 0.0.0", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("sprint-1", { tasksCompleted: 3, tasksPlanned: 5 });
    expect(report.version).toBe("0.0.0");
    expect(report.tasksCompleted).toBe(3);
    expect(report.tasksPlanned).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// generateMarkdown — _none_ placeholders
// ---------------------------------------------------------------------------

describe("SprintRetroGenerator — generateMarkdown _none_ sections", () => {
  it("empty sprint markdown shows _none_ in Top Wins section", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("empty-sprint");
    const md = generator.generateMarkdown(report);
    const winsSection = md.split("## Top Wins")[1]?.split("##")[0] ?? "";
    expect(winsSection).toContain("_none_");
  });

  it("empty sprint markdown shows _none_ in Top Blockers section", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("empty-sprint");
    const md = generator.generateMarkdown(report);
    const blockersSection = md.split("## Top Blockers")[1]?.split("##")[0] ?? "";
    expect(blockersSection).toContain("_none_");
  });

  it("empty sprint markdown shows _none_ in Top Recommendations section", () => {
    const { generator } = makeGenerator();
    const report = generator.generateRetro("empty-sprint");
    const md = generator.generateMarkdown(report);
    const recoSection = md.split("## Top Recommendations")[1]?.split("##")[0] ?? "";
    expect(recoSection).toContain("_none_");
  });
});
