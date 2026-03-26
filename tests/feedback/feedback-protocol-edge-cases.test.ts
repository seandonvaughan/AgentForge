import { describe, it, expect, beforeEach } from "vitest";
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
    timestamp: "2026-03-26T10:00:00.000Z",
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

// ---------------------------------------------------------------------------
// getEntries — combined filter (agentId AND sprintId)
// ---------------------------------------------------------------------------

describe("getEntries — combined agentId AND sprintId filter", () => {
  let protocol: FeedbackProtocol;

  beforeEach(() => {
    protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    protocol.recordEntry(makeEntry({ agentId: "agent-x", sprintId: "s1", taskId: "t-x-s1" }));
    protocol.recordEntry(makeEntry({ agentId: "agent-x", sprintId: "s2", taskId: "t-x-s2" }));
    protocol.recordEntry(makeEntry({ agentId: "agent-y", sprintId: "s1", taskId: "t-y-s1" }));
    protocol.recordEntry(makeEntry({ agentId: "agent-y", sprintId: "s2", taskId: "t-y-s2" }));
  });

  it("AND filter: only entries matching BOTH agentId and sprintId are returned", () => {
    const results = protocol.getEntries({ agentId: "agent-x", sprintId: "s1" });
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("t-x-s1");
  });

  it("AND filter: returns empty when agentId matches but sprintId does not", () => {
    const results = protocol.getEntries({ agentId: "agent-x", sprintId: "s-nonexistent" });
    expect(results).toHaveLength(0);
  });

  it("AND filter: returns empty when sprintId matches but agentId does not", () => {
    const results = protocol.getEntries({ agentId: "agent-z", sprintId: "s1" });
    expect(results).toHaveLength(0);
  });

  it("AND filter: returns correct subset for second agent+sprint pair", () => {
    const results = protocol.getEntries({ agentId: "agent-y", sprintId: "s2" });
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("t-y-s2");
  });
});

// ---------------------------------------------------------------------------
// Same agentId, different sprintIds
// ---------------------------------------------------------------------------

describe("getEntries — same agentId across multiple sprintIds", () => {
  it("records same agentId for different sprints without collision", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    protocol.recordEntry(makeEntry({ agentId: "shared-agent", sprintId: "sprint-A" }));
    protocol.recordEntry(makeEntry({ agentId: "shared-agent", sprintId: "sprint-B" }));
    protocol.recordEntry(makeEntry({ agentId: "shared-agent", sprintId: "sprint-C" }));
    expect(protocol.getEntries({ agentId: "shared-agent" })).toHaveLength(3);
  });

  it("filters by sprintId returns only that sprint's entry for shared agentId", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    protocol.recordEntry(makeEntry({ agentId: "shared-agent", sprintId: "sprint-A", taskId: "task-A" }));
    protocol.recordEntry(makeEntry({ agentId: "shared-agent", sprintId: "sprint-B", taskId: "task-B" }));

    const resultsA = protocol.getEntries({ sprintId: "sprint-A" });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].taskId).toBe("task-A");
  });
});

// ---------------------------------------------------------------------------
// generateSprintSummary — boundary values
// ---------------------------------------------------------------------------

describe("generateSprintSummary — zero-entry sprint", () => {
  it("returns 0 for all numeric fields when sprint has no entries", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const summary = protocol.generateSprintSummary("ghost-sprint");
    expect(summary.entryCount).toBe(0);
    expect(summary.agentCount).toBe(0);
    expect(summary.avgSelfAssessment).toBe(0);
    expect(summary.modelMismatchCount).toBe(0);
    expect(summary.topWins).toHaveLength(0);
    expect(summary.topBlockers).toHaveLength(0);
  });
});

describe("generateSprintSummary — all exceeded", () => {
  it("all 'exceeded' gives avgSelfAssessment of 3.0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    for (let i = 0; i < 4; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "all-exceed", selfAssessment: "exceeded" }));
    }
    const summary = protocol.generateSprintSummary("all-exceed");
    expect(summary.avgSelfAssessment).toBe(3.0);
  });
});

describe("generateSprintSummary — all failed", () => {
  it("all 'failed' gives avgSelfAssessment of 0.0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    for (let i = 0; i < 3; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "all-fail", selfAssessment: "failed" }));
    }
    const summary = protocol.generateSprintSummary("all-fail");
    expect(summary.avgSelfAssessment).toBe(0.0);
  });
});

describe("generateSprintSummary — all partial", () => {
  it("all 'partial' gives avgSelfAssessment of 1.0", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    for (let i = 0; i < 3; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "all-partial", selfAssessment: "partial" }));
    }
    const summary = protocol.generateSprintSummary("all-partial");
    expect(summary.avgSelfAssessment).toBe(1.0);
  });
});

describe("generateSprintSummary — modelMismatchCount edge cases", () => {
  it("modelMismatchCount=0 when all entries are appropriate", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    for (let i = 0; i < 5; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "no-mismatch", modelTierAppropriate: true }));
    }
    const summary = protocol.generateSprintSummary("no-mismatch");
    expect(summary.modelMismatchCount).toBe(0);
  });

  it("modelMismatchCount equals total entries when all are inappropriate", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    for (let i = 0; i < 4; i++) {
      protocol.recordEntry(makeEntry({ sprintId: "all-mismatch", modelTierAppropriate: false }));
    }
    const summary = protocol.generateSprintSummary("all-mismatch");
    expect(summary.modelMismatchCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// generateMarkdown — empty arrays show "_none_"
// ---------------------------------------------------------------------------

describe("generateMarkdown — empty arrays render as _none_", () => {
  it("empty whatWorked shows _none_ or equivalent placeholder", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const entry = makeEntry({ whatWorked: [] });
    const md = protocol.generateMarkdown(entry);
    // The section should exist but have no real items — must contain something indicating emptiness
    const section = md.split("## What Worked")[1]?.split("##")[0] ?? "";
    // Either it shows _none_ or the section is effectively empty (no bullet items)
    const hasBullets = section.includes("- ") && section.trim().split("- ").length > 1;
    expect(hasBullets).toBe(false);
  });

  it("empty blockers renders empty or _none_ in Blockers section", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const entry = makeEntry({ blockers: [] });
    const md = protocol.generateMarkdown(entry);
    const section = md.split("## Blockers")[1]?.split("##")[0] ?? "";
    const hasBullets = section.includes("- ") && section.trim().split("- ").length > 1;
    expect(hasBullets).toBe(false);
  });

  it("non-empty whatWorked renders bullet items", () => {
    const protocol = new FeedbackProtocol({ fileAdapter: new InMemoryFeedbackFileAdapter() });
    const entry = makeEntry({ whatWorked: ["item one", "item two"] });
    const md = protocol.generateMarkdown(entry);
    expect(md).toContain("- item one");
    expect(md).toContain("- item two");
  });
});

// ---------------------------------------------------------------------------
// autoSave — triggers after recordEntry
// ---------------------------------------------------------------------------

describe("autoSave behavior", () => {
  it("autoSave triggers after single recordEntry", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const protocol = new FeedbackProtocol({
      fileAdapter: adapter,
      autoSavePath: "/tmp/edge-autosave.json",
    });

    expect(adapter.fileExists("/tmp/edge-autosave.json")).toBe(false);
    protocol.recordEntry(makeEntry({ taskId: "first-task" }));
    expect(adapter.fileExists("/tmp/edge-autosave.json")).toBe(true);
  });

  it("autoSave file contains the recorded entry", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const protocol = new FeedbackProtocol({
      fileAdapter: adapter,
      autoSavePath: "/tmp/edge-autosave2.json",
    });

    protocol.recordEntry(makeEntry({ taskId: "save-me", agentId: "verify-agent" }));
    const snap = JSON.parse(adapter.readFile("/tmp/edge-autosave2.json"));
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].taskId).toBe("save-me");
    expect(snap.entries[0].agentId).toBe("verify-agent");
  });

  it("autoSave accumulates entries across multiple recordEntry calls", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const protocol = new FeedbackProtocol({
      fileAdapter: adapter,
      autoSavePath: "/tmp/edge-autosave3.json",
    });

    protocol.recordEntry(makeEntry({ taskId: "t1" }));
    protocol.recordEntry(makeEntry({ taskId: "t2" }));
    protocol.recordEntry(makeEntry({ taskId: "t3" }));

    const snap = JSON.parse(adapter.readFile("/tmp/edge-autosave3.json"));
    expect(snap.entries).toHaveLength(3);
  });

  it("without autoSavePath, no file is written after recordEntry", () => {
    const adapter = new InMemoryFeedbackFileAdapter();
    const protocol = new FeedbackProtocol({ fileAdapter: adapter });

    protocol.recordEntry(makeEntry({ taskId: "no-save" }));
    expect(adapter.fileExists("/tmp/anything.json")).toBe(false);
  });
});
