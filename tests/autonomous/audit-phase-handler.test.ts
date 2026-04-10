import { describe, it, expect, beforeEach } from "vitest";
import { AuditPhaseHandler, type GateVerdictReader } from "../../src/autonomous/audit-phase-handler.js";
import { ReviewPhaseHandler, type ReviewFinding } from "../../src/autonomous/review-phase-handler.js";
import { MemoryRegistry } from "../../src/registry/memory-registry.js";
import type { SessionMemoryEntry } from "../../src/memory/session-memory-manager.js";
import type { GateVerdictMetadata } from "../../src/autonomous/gate-phase-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "MAJOR",
    file: "src/orchestrator/cost-tracker.ts",
    summary: "Unchecked division by zero when totalTasks is 0",
    reviewerAgentId: "code-reviewer",
    ...overrides,
  };
}

function makeGateVerdictReader(entries: Partial<SessionMemoryEntry>[] = []): GateVerdictReader {
  const defaults: SessionMemoryEntry = {
    id: "entry-1",
    sessionId: "sprint-1",
    category: "gate-verdict",
    agentId: "gate-phase",
    summary: "Sprint 6.8 gate rejected: 3/10 items completed",
    success: false,
    timestamp: new Date().toISOString(),
  };
  return {
    getEntriesByCategory: () =>
      entries.map((e, i) => ({
        ...defaults,
        id: `entry-${i}`,
        ...e,
      })) as SessionMemoryEntry[],
  };
}

/** Build a gate-verdict entry that carries the rich GateVerdictMetadata. */
function makeRichGateEntry(overrides: Partial<SessionMemoryEntry> = {}): Partial<SessionMemoryEntry> {
  const meta: GateVerdictMetadata = {
    cycleId: "sprint-rich-1",
    verdict: "rejected",
    rationale: "Critical auth bypass blocked release",
    criticalFindings: ["Auth bypass in middleware"],
    majorFindings: ["Slow query in registry"],
  };
  return {
    success: false,
    summary: "Gate rejected: Critical auth bypass blocked release. Critical: Auth bypass in middleware",
    metadata: meta,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditPhaseHandler", () => {
  let registry: MemoryRegistry;
  let reviewHandler: ReviewPhaseHandler;

  beforeEach(() => {
    registry = new MemoryRegistry();
    reviewHandler = new ReviewPhaseHandler(registry);
  });

  // ── getPastMistakes ────────────────────────────────────────────────────────

  describe("getPastMistakes", () => {
    it("returns an empty array when no memory entries exist", () => {
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());
      expect(handler.getPastMistakes()).toEqual([]);
    });

    it("surfaces MAJOR review findings as past mistakes", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding({ severity: "MAJOR" })]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const mistakes = handler.getPastMistakes();
      expect(mistakes).toHaveLength(1);
      expect(mistakes[0].source).toBe("review-finding");
      expect(mistakes[0].wasFailure).toBe(false);
    });

    it("marks CRITICAL review findings as wasFailure=true", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding({ severity: "CRITICAL" })]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].wasFailure).toBe(true);
    });

    it("surfaces rejected gate verdicts as past mistakes", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([{ success: false, summary: "Sprint 6.7 gate rejected: budget exceeded" }]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes).toHaveLength(1);
      expect(mistakes[0].source).toBe("gate-verdict");
      expect(mistakes[0].wasFailure).toBe(true);
    });

    it("excludes approved gate verdicts — they are not mistakes", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([{ success: true, summary: "Sprint 6.7 gate approved" }]),
      );

      // No review findings either
      expect(handler.getPastMistakes()).toHaveLength(0);
    });

    it("combines review findings and gate verdicts up to the limit", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts" }),
        makeFinding({ severity: "CRITICAL", file: "src/b.ts" }),
      ]);
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([
          { success: false, summary: "Sprint 6.7 gate rejected: tests failing" },
        ]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes).toHaveLength(3);
    });

    it("respects the limit parameter", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts" }),
        makeFinding({ severity: "CRITICAL", file: "src/b.ts" }),
        makeFinding({ severity: "MAJOR", file: "src/c.ts" }),
      ]);
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([
          { success: false, summary: "Sprint 6.7 gate rejected" },
          { success: false, summary: "Sprint 6.6 gate rejected" },
        ]),
      );

      const mistakes = handler.getPastMistakes(2);
      expect(mistakes).toHaveLength(2);
    });

    it("places CRITICAL findings before MAJOR (sorted by descending relevance)", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts", summary: "major issue" }),
        makeFinding({ severity: "CRITICAL", file: "src/b.ts", summary: "critical issue" }),
      ]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const mistakes = handler.getPastMistakes();
      // CRITICAL (relevanceScore 0.95) should rank above MAJOR (0.85)
      expect(mistakes[0].description).toContain("CRITICAL");
    });
  });

  // ── buildPastMistakesSection ───────────────────────────────────────────────

  describe("buildPastMistakesSection", () => {
    it("returns an empty section when there are no past mistakes", () => {
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());
      const result = handler.buildPastMistakesSection();

      expect(result.section).toBe("");
      expect(result.totalCount).toBe(0);
      expect(result.reviewFindingCount).toBe(0);
      expect(result.gateVerdictCount).toBe(0);
    });

    it("includes the section header when mistakes exist", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const result = handler.buildPastMistakesSection();
      expect(result.section).toContain("## Past mistakes to avoid");
    });

    it("formats review findings with [REVIEW/FINDING] label", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding({ severity: "MAJOR" })]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const result = handler.buildPastMistakesSection();
      expect(result.section).toContain("[REVIEW/FINDING]");
    });

    it("formats rejected gate verdicts with [GATE/REJECTED] label", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([{ success: false, summary: "Sprint 6.7 gate rejected" }]),
      );

      const result = handler.buildPastMistakesSection();
      expect(result.section).toContain("[GATE/REJECTED]");
    });

    it("reports accurate counts in the injection result", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR" }),
        makeFinding({ severity: "CRITICAL", file: "src/x.ts" }),
      ]);
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([
          { success: false, summary: "Sprint 6.7 gate rejected" },
        ]),
      );

      const result = handler.buildPastMistakesSection();
      expect(result.reviewFindingCount).toBe(2);
      expect(result.gateVerdictCount).toBe(1);
      expect(result.totalCount).toBe(3);
    });

    it("includes the finding message in the injected section", () => {
      const msg = "API key leaked in logs via debug output";
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "CRITICAL", summary: msg }),
      ]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const result = handler.buildPastMistakesSection();
      expect(result.section).toContain(msg);
    });

    it("ends the section with a trailing newline for clean concatenation", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const handler = new AuditPhaseHandler(reviewHandler, makeGateVerdictReader());

      const result = handler.buildPastMistakesSection();
      expect(result.section.endsWith("\n")).toBe(true);
    });
  });

  // ── Gate verdict metadata extraction ──────────────────────────────────────

  describe("gate verdict metadata — rich descriptions from GatePhaseHandler entries", () => {
    it("uses rationale from metadata as the primary description", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([makeRichGateEntry()]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].description).toContain("Critical auth bypass blocked release");
    });

    it("appends critical findings from metadata to the description", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([makeRichGateEntry()]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].description).toContain("Auth bypass in middleware");
    });

    it("appends major findings from metadata to the description", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([makeRichGateEntry()]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].description).toContain("Slow query in registry");
    });

    it("falls back to entry.summary for legacy entries without metadata", () => {
      const legacySummary = "Sprint 6.5 gate rejected: 5/10 items, budget overrun";
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([{ success: false, summary: legacySummary }]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].description).toBe(legacySummary);
    });

    it("falls back to entry.summary when metadata has no rationale", () => {
      const legacySummary = "Sprint 6.6 gate rejected: tests failing";
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([
          { success: false, summary: legacySummary, metadata: { someOtherField: true } },
        ]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].description).toBe(legacySummary);
    });

    it("description excludes findings sections when findings arrays are empty", () => {
      const handler = new AuditPhaseHandler(
        reviewHandler,
        makeGateVerdictReader([
          makeRichGateEntry({
            metadata: {
              cycleId: "sprint-x",
              verdict: "rejected",
              rationale: "Budget exceeded",
              criticalFindings: [],
              majorFindings: [],
            },
          }),
        ]),
      );

      const mistakes = handler.getPastMistakes();
      expect(mistakes[0].description).toBe("Budget exceeded");
      expect(mistakes[0].description).not.toContain("Critical findings");
      expect(mistakes[0].description).not.toContain("Major findings");
    });
  });
});
