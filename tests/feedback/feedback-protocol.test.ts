import { describe, it, expect, beforeEach } from "vitest";
import {
  FeedbackProtocol,
  InMemoryFeedbackFileAdapter,
  type FeedbackEntry,
  type FeedbackSummary,
} from "../../src/feedback/feedback-protocol.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    agentId: "arch",
    taskId: "T-001",
    sprintId: "s1",
    timestamp: "2026-03-26T10:00:00.000Z",
    whatWorked: ["parallel execution", "caching"],
    whatDidnt: ["manual handoffs"],
    recommendations: ["automate handoffs"],
    timeSpentMs: 5000,
    blockers: ["missing spec"],
    selfAssessment: "met",
    modelTierAppropriate: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// recordEntry
// ---------------------------------------------------------------------------

describe("FeedbackProtocol", () => {
  let protocol: FeedbackProtocol;

  beforeEach(() => {
    protocol = new FeedbackProtocol();
  });

  describe("recordEntry", () => {
    it("stores a single entry", () => {
      protocol.recordEntry(makeEntry());
      expect(protocol.getEntries()).toHaveLength(1);
    });

    it("stores multiple entries", () => {
      protocol.recordEntry(makeEntry({ taskId: "T-001" }));
      protocol.recordEntry(makeEntry({ taskId: "T-002" }));
      expect(protocol.getEntries()).toHaveLength(2);
    });

    it("stores a defensive copy — mutation of original does not affect stored entry", () => {
      const entry = makeEntry();
      protocol.recordEntry(entry);
      entry.agentId = "mutated";
      expect(protocol.getEntries()[0].agentId).toBe("arch");
    });
  });

  // -------------------------------------------------------------------------
  // getEntries filtering
  // -------------------------------------------------------------------------

  describe("getEntries", () => {
    beforeEach(() => {
      protocol.recordEntry(makeEntry({ agentId: "arch", sprintId: "s1", taskId: "T-001" }));
      protocol.recordEntry(makeEntry({ agentId: "cto", sprintId: "s1", taskId: "T-002" }));
      protocol.recordEntry(makeEntry({ agentId: "arch", sprintId: "s2", taskId: "T-003" }));
    });

    it("returns all entries when no filter is provided", () => {
      expect(protocol.getEntries()).toHaveLength(3);
    });

    it("filters by agentId", () => {
      const result = protocol.getEntries({ agentId: "arch" });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.agentId === "arch")).toBe(true);
    });

    it("filters by sprintId", () => {
      const result = protocol.getEntries({ sprintId: "s1" });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.sprintId === "s1")).toBe(true);
    });

    it("filters by both agentId and sprintId", () => {
      const result = protocol.getEntries({ agentId: "arch", sprintId: "s1" });
      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe("T-001");
    });

    it("returns empty array when filter matches nothing", () => {
      expect(protocol.getEntries({ agentId: "nobody" })).toHaveLength(0);
    });

    it("returns defensive copies — mutation does not affect stored entries", () => {
      const entries = protocol.getEntries();
      entries[0].agentId = "mutated";
      expect(protocol.getEntries()[0].agentId).toBe("arch");
    });
  });

  // -------------------------------------------------------------------------
  // generateMarkdown
  // -------------------------------------------------------------------------

  describe("generateMarkdown", () => {
    it("produces a heading with agentId and date", () => {
      const entry = makeEntry({ agentId: "arch", timestamp: "2026-03-26T10:00:00.000Z" });
      const md = protocol.generateMarkdown(entry);
      expect(md).toContain("# Agent Feedback — arch — 2026-03-26");
    });

    it("includes task and sprint metadata", () => {
      const md = protocol.generateMarkdown(makeEntry({ taskId: "T-42", sprintId: "s7" }));
      expect(md).toContain("**Task:** T-42");
      expect(md).toContain("**Sprint:** s7");
    });

    it("includes self-assessment", () => {
      const md = protocol.generateMarkdown(makeEntry({ selfAssessment: "exceeded" }));
      expect(md).toContain("**Self-Assessment:** exceeded");
    });

    it("renders modelTierAppropriate as yes/no", () => {
      expect(protocol.generateMarkdown(makeEntry({ modelTierAppropriate: true }))).toContain(
        "**Model Tier Appropriate:** yes",
      );
      expect(protocol.generateMarkdown(makeEntry({ modelTierAppropriate: false }))).toContain(
        "**Model Tier Appropriate:** no",
      );
    });

    it("includes time spent in ms", () => {
      const md = protocol.generateMarkdown(makeEntry({ timeSpentMs: 12345 }));
      expect(md).toContain("**Time Spent:** 12345ms");
    });

    it("renders whatWorked items as bullet list", () => {
      const md = protocol.generateMarkdown(
        makeEntry({ whatWorked: ["thing A", "thing B"] }),
      );
      expect(md).toContain("## What Worked");
      expect(md).toContain("- thing A");
      expect(md).toContain("- thing B");
    });

    it("renders whatDidnt items as bullet list", () => {
      const md = protocol.generateMarkdown(makeEntry({ whatDidnt: ["slow CI"] }));
      expect(md).toContain("## What Didn't Work");
      expect(md).toContain("- slow CI");
    });

    it("renders recommendations as bullet list", () => {
      const md = protocol.generateMarkdown(
        makeEntry({ recommendations: ["automate deploys"] }),
      );
      expect(md).toContain("## Recommendations");
      expect(md).toContain("- automate deploys");
    });

    it("renders blockers as bullet list", () => {
      const md = protocol.generateMarkdown(makeEntry({ blockers: ["no access"] }));
      expect(md).toContain("## Blockers");
      expect(md).toContain("- no access");
    });
  });

  // -------------------------------------------------------------------------
  // generateSprintSummary
  // -------------------------------------------------------------------------

  describe("generateSprintSummary", () => {
    it("returns empty summary for sprint with no entries", () => {
      const summary = protocol.generateSprintSummary("ghost-sprint");
      expect(summary.entryCount).toBe(0);
      expect(summary.agentCount).toBe(0);
      expect(summary.topWins).toHaveLength(0);
      expect(summary.avgSelfAssessment).toBe(0);
    });

    it("counts correct entryCount and agentCount", () => {
      protocol.recordEntry(makeEntry({ agentId: "arch", sprintId: "s1" }));
      protocol.recordEntry(makeEntry({ agentId: "arch", sprintId: "s1" }));
      protocol.recordEntry(makeEntry({ agentId: "cto", sprintId: "s1" }));
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.entryCount).toBe(3);
      expect(summary.agentCount).toBe(2); // arch + cto
    });

    it("ranks topWins by frequency (highest first)", () => {
      protocol.recordEntry(
        makeEntry({ sprintId: "s1", whatWorked: ["caching", "parallel exec", "caching"] }),
      );
      protocol.recordEntry(makeEntry({ sprintId: "s1", whatWorked: ["caching", "typing"] }));
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.topWins[0]).toBe("caching"); // 3 mentions
    });

    it("returns at most 3 topWins", () => {
      protocol.recordEntry(
        makeEntry({
          sprintId: "s1",
          whatWorked: ["A", "B", "C", "D", "E"],
        }),
      );
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.topWins.length).toBeLessThanOrEqual(3);
    });

    it("ranks topBlockers by frequency", () => {
      protocol.recordEntry(makeEntry({ sprintId: "s1", blockers: ["slow CI", "missing spec"] }));
      protocol.recordEntry(makeEntry({ sprintId: "s1", blockers: ["slow CI", "no access"] }));
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.topBlockers[0]).toBe("slow CI");
    });

    it("computes avgSelfAssessment correctly (failed=0 .. exceeded=3)", () => {
      protocol.recordEntry(makeEntry({ sprintId: "s1", selfAssessment: "exceeded" })); // 3
      protocol.recordEntry(makeEntry({ sprintId: "s1", selfAssessment: "met" }));      // 2
      protocol.recordEntry(makeEntry({ sprintId: "s1", selfAssessment: "partial" })); // 1
      protocol.recordEntry(makeEntry({ sprintId: "s1", selfAssessment: "failed" }));  // 0
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.avgSelfAssessment).toBeCloseTo(1.5, 5); // (3+2+1+0)/4
    });

    it("counts modelMismatchCount correctly", () => {
      protocol.recordEntry(makeEntry({ sprintId: "s1", modelTierAppropriate: true }));
      protocol.recordEntry(makeEntry({ sprintId: "s1", modelTierAppropriate: false }));
      protocol.recordEntry(makeEntry({ sprintId: "s1", modelTierAppropriate: false }));
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.modelMismatchCount).toBe(2);
    });

    it("does not include entries from other sprints", () => {
      protocol.recordEntry(makeEntry({ sprintId: "s1", selfAssessment: "exceeded" }));
      protocol.recordEntry(makeEntry({ sprintId: "s2", selfAssessment: "failed" }));
      const summary = protocol.generateSprintSummary("s1");
      expect(summary.entryCount).toBe(1);
      expect(summary.avgSelfAssessment).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // save / load
  // -------------------------------------------------------------------------

  describe("persistence", () => {
    it("save/load round-trip preserves all entries using InMemoryFeedbackFileAdapter", () => {
      const fs = new InMemoryFeedbackFileAdapter();
      const p = new FeedbackProtocol({ fileAdapter: fs });

      p.recordEntry(makeEntry({ taskId: "T-001", agentId: "arch" }));
      p.recordEntry(makeEntry({ taskId: "T-002", agentId: "cto" }));
      p.save("/tmp/feedback.json");

      const restored = FeedbackProtocol.load("/tmp/feedback.json", { fileAdapter: fs });
      expect(restored.getEntries()).toHaveLength(2);
      expect(restored.getEntries()[0].taskId).toBe("T-001");
      expect(restored.getEntries()[1].agentId).toBe("cto");
    });

    it("load returns empty protocol when file does not exist", () => {
      const fs = new InMemoryFeedbackFileAdapter();
      const restored = FeedbackProtocol.load("/tmp/no-such-file.json", { fileAdapter: fs });
      expect(restored.getEntries()).toHaveLength(0);
    });

    it("autoSave writes to path after recordEntry", () => {
      const fs = new InMemoryFeedbackFileAdapter();
      const p = new FeedbackProtocol({
        fileAdapter: fs,
        autoSavePath: "/tmp/auto-feedback.json",
      });

      p.recordEntry(makeEntry({ taskId: "T-100" }));
      expect(fs.fileExists("/tmp/auto-feedback.json")).toBe(true);

      const snap = JSON.parse(fs.readFile("/tmp/auto-feedback.json"));
      expect(snap.entries).toHaveLength(1);
      expect(snap.entries[0].taskId).toBe("T-100");
    });

    it("autoSave updates on each subsequent recordEntry", () => {
      const fs = new InMemoryFeedbackFileAdapter();
      const p = new FeedbackProtocol({
        fileAdapter: fs,
        autoSavePath: "/tmp/auto2.json",
      });

      p.recordEntry(makeEntry({ taskId: "T-1" }));
      p.recordEntry(makeEntry({ taskId: "T-2" }));
      const snap = JSON.parse(fs.readFile("/tmp/auto2.json"));
      expect(snap.entries).toHaveLength(2);
    });

    it("save/load preserves selfAssessment and modelTierAppropriate", () => {
      const fs = new InMemoryFeedbackFileAdapter();
      const p = new FeedbackProtocol({ fileAdapter: fs });
      p.recordEntry(
        makeEntry({ selfAssessment: "exceeded", modelTierAppropriate: false }),
      );
      p.save("/tmp/assess.json");

      const restored = FeedbackProtocol.load("/tmp/assess.json", { fileAdapter: fs });
      const entry = restored.getEntries()[0];
      expect(entry.selfAssessment).toBe("exceeded");
      expect(entry.modelTierAppropriate).toBe(false);
    });

    it("loaded protocol can record new entries and generate summary", () => {
      const fs = new InMemoryFeedbackFileAdapter();
      const p = new FeedbackProtocol({ fileAdapter: fs });
      p.recordEntry(makeEntry({ sprintId: "s3", selfAssessment: "met" }));
      p.save("/tmp/sprint3.json");

      const restored = FeedbackProtocol.load("/tmp/sprint3.json", { fileAdapter: fs });
      restored.recordEntry(makeEntry({ sprintId: "s3", selfAssessment: "exceeded" }));

      const summary = restored.generateSprintSummary("s3");
      expect(summary.entryCount).toBe(2);
      expect(summary.avgSelfAssessment).toBeCloseTo(2.5, 5); // (2+3)/2
    });
  });
});
