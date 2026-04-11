import { describe, it, expect, beforeEach } from "vitest";
import {
  ExecutePhaseHandler,
  type ExecutePhaseMemorySection,
} from "../../src/autonomous/execute-phase-handler.js";
import { ReviewPhaseHandler, type ReviewFinding } from "../../src/autonomous/review-phase-handler.js";
import { MemoryRegistry } from "../../src/registry/memory-registry.js";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutePhaseHandler", () => {
  let registry: MemoryRegistry;
  let reviewHandler: ReviewPhaseHandler;
  let handler: ExecutePhaseHandler;

  beforeEach(() => {
    registry = new MemoryRegistry();
    reviewHandler = new ReviewPhaseHandler(registry);
    handler = new ExecutePhaseHandler(registry);
  });

  // ── buildMemorySection — empty cases ──────────────────────────────────────

  describe("buildMemorySection — empty cases", () => {
    it("returns an empty section when itemTags is empty", () => {
      const result = handler.buildMemorySection([]);
      expect(result.section).toBe("");
      expect(result.matchedCount).toBe(0);
      expect(result.tags).toEqual([]);
    });

    it("returns an empty section when no registry entries match the tags", () => {
      // Populate registry with entries tagged "auth"
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/auth.ts", summary: "Auth bypass via null token" }),
      ]);

      // Query with completely unrelated tags
      const result = handler.buildMemorySection(["database", "caching"]);
      expect(result.section).toBe("");
      expect(result.matchedCount).toBe(0);
      expect(result.tags).toEqual(["database", "caching"]);
    });

    it("returns empty section when registry is empty", () => {
      const result = handler.buildMemorySection(["memory", "execute"]);
      expect(result.section).toBe("");
      expect(result.matchedCount).toBe(0);
    });
  });

  // ── buildMemorySection — matching ─────────────────────────────────────────

  describe("buildMemorySection — matching entries", () => {
    it("returns a non-empty section when review-finding tags overlap", () => {
      // ReviewPhaseHandler stamps "review-finding" on every MAJOR/CRITICAL entry
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);

      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.section).not.toBe("");
      expect(result.matchedCount).toBe(1);
    });

    it("matches by file path tag from review findings", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/orchestrator/cost-tracker.ts" }),
      ]);

      const result = handler.buildMemorySection(["src/orchestrator/cost-tracker.ts"]);
      expect(result.matchedCount).toBe(1);
    });

    it("matches by sprint tag from review findings", () => {
      reviewHandler.handleFindings("sprint-42", "10.1", [makeFinding()]);

      const result = handler.buildMemorySection(["sprint:sprint-42"]);
      expect(result.matchedCount).toBe(1);
    });

    it("matches by severity tag (e.g. 'major', 'critical')", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "CRITICAL", file: "src/a.ts" }),
        makeFinding({ severity: "MAJOR", file: "src/b.ts" }),
      ]);

      const result = handler.buildMemorySection(["critical"]);
      expect(result.matchedCount).toBe(1);
      expect(result.section).toContain("src/a.ts");
    });

    it("uses OR logic — any tag match surfaces the entry", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/auth.ts" }),
        makeFinding({ file: "src/billing.ts" }),
      ]);

      // Only "src/auth.ts" is a tag on the first entry
      const result = handler.buildMemorySection(["src/auth.ts"]);
      expect(result.matchedCount).toBe(1);
    });

    it("surfaces multiple matching entries", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts" }),
        makeFinding({ severity: "CRITICAL", file: "src/b.ts" }),
        makeFinding({ severity: "MAJOR", file: "src/c.ts" }),
      ]);

      // "review-finding" tag is on every entry
      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.matchedCount).toBe(3);
    });
  });

  // ── buildMemorySection — section format ───────────────────────────────────

  describe("buildMemorySection — section format", () => {
    beforeEach(() => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);
    });

    it("includes the section header", () => {
      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.section).toContain("## Memory: Past Failures on Similar Work");
    });

    it("includes the preamble describing the entries", () => {
      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.section).toContain("The following entries from prior cycles matched this item's tags.");
    });

    it("includes the finding summary in the section body", () => {
      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.section).toContain("Unchecked division by zero when totalTasks is 0");
    });

    it("labels entries with their category", () => {
      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.section).toContain("**[review-finding]**");
    });

    it("ends with a horizontal rule and trailing newline for clean concatenation", () => {
      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.section).toContain("---");
      expect(result.section.endsWith("\n")).toBe(true);
    });

    it("reports accurate matchedCount in the result", () => {
      reviewHandler.handleFindings("sprint-2", "6.9", [
        makeFinding({ file: "src/x.ts" }),
      ]);

      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.matchedCount).toBe(2);
    });

    it("reports the queried tags in the result", () => {
      const tags = ["review-finding", "src/orchestrator/cost-tracker.ts"];
      const result = handler.buildMemorySection(tags);
      expect(result.tags).toEqual(tags);
    });
  });

  // ── buildMemorySection — ordering and limit ───────────────────────────────

  describe("buildMemorySection — ordering and limit", () => {
    it("places CRITICAL entries before MAJOR (sorted by descending relevanceScore)", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts", summary: "major issue in a" }),
        makeFinding({ severity: "CRITICAL", file: "src/b.ts", summary: "critical issue in b" }),
      ]);

      const result = handler.buildMemorySection(["review-finding"]);
      const criticalIdx = result.section.indexOf("critical issue in b");
      const majorIdx = result.section.indexOf("major issue in a");
      expect(criticalIdx).toBeLessThan(majorIdx);
    });

    it("respects the limit parameter", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts" }),
        makeFinding({ severity: "MAJOR", file: "src/b.ts" }),
        makeFinding({ severity: "CRITICAL", file: "src/c.ts" }),
        makeFinding({ severity: "MAJOR", file: "src/d.ts" }),
      ]);

      const result = handler.buildMemorySection(["review-finding"], 2);
      expect(result.matchedCount).toBe(2);
    });

    it("default limit surfaces at most 5 entries", () => {
      for (let i = 0; i < 8; i++) {
        reviewHandler.handleFindings(`sprint-${i}`, "6.8", [
          makeFinding({ file: `src/file-${i}.ts` }),
        ]);
      }

      const result = handler.buildMemorySection(["review-finding"]);
      expect(result.matchedCount).toBeLessThanOrEqual(5);
    });
  });

  // ── injectMemoryIntoPrompt ─────────────────────────────────────────────────

  describe("injectMemoryIntoPrompt", () => {
    const basePrompt = "Implement the new caching layer for the cost tracker.";

    it("returns the original prompt unchanged when no entries match", () => {
      const result = handler.injectMemoryIntoPrompt(basePrompt, ["database"]);
      expect(result).toBe(basePrompt);
    });

    it("returns the original prompt unchanged when itemTags is empty", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const result = handler.injectMemoryIntoPrompt(basePrompt, []);
      expect(result).toBe(basePrompt);
    });

    it("prepends the memory section to the prompt when matches exist", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);

      const result = handler.injectMemoryIntoPrompt(basePrompt, ["review-finding"]);
      expect(result).toContain("## Memory: Past Failures on Similar Work");
      expect(result).toContain(basePrompt);
    });

    it("memory section appears before the original prompt content", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);

      const result = handler.injectMemoryIntoPrompt(basePrompt, ["review-finding"]);
      const sectionIdx = result.indexOf("## Memory:");
      const promptIdx = result.indexOf(basePrompt);
      expect(sectionIdx).toBeLessThan(promptIdx);
    });

    it("preserves the full original prompt content after injection", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [makeFinding()]);

      const result = handler.injectMemoryIntoPrompt(basePrompt, ["review-finding"]);
      expect(result.endsWith(basePrompt)).toBe(true);
    });

    it("respects the optional limit parameter", () => {
      reviewHandler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR", file: "src/a.ts", summary: "issue in a" }),
        makeFinding({ severity: "CRITICAL", file: "src/b.ts", summary: "issue in b" }),
        makeFinding({ severity: "MAJOR", file: "src/c.ts", summary: "issue in c" }),
      ]);

      const limited = handler.injectMemoryIntoPrompt(basePrompt, ["review-finding"], 1);
      // With limit=1, only the highest-relevance entry (CRITICAL) should appear
      expect(limited).toContain("issue in b");
      expect(limited).not.toContain("issue in a");
      expect(limited).not.toContain("issue in c");
    });
  });

  // ── SprintItem tags integration ────────────────────────────────────────────

  describe("SprintItem.tags integration", () => {
    it("supports typical sprint item tag vocabulary", () => {
      // Simulate a review finding tagged with "execute" domain tag
      registry.store({
        type: "memory",
        version: "1.0.0",
        ownerAgentId: "code-reviewer",
        active: true,
        category: "review-finding",
        summary: "[MAJOR] execute-phase past failure: missing error propagation",
        contentPath: ".agentforge/memory/review/sprint-1/code-reviewer/1234.md",
        relevanceScore: 0.85,
        decayRatePerDay: 0.005,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null,
        tags: ["review-finding", "execute", "error-handling", "sprint:sprint-1"],
      });

      const result = handler.buildMemorySection(["execute", "memory"]);
      expect(result.matchedCount).toBe(1);
      expect(result.section).toContain("missing error propagation");
    });
  });
});
