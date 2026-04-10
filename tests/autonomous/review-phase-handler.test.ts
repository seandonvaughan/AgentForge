import { describe, it, expect, beforeEach } from "vitest";
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

describe("ReviewPhaseHandler", () => {
  let registry: MemoryRegistry;
  let handler: ReviewPhaseHandler;

  beforeEach(() => {
    registry = new MemoryRegistry();
    handler = new ReviewPhaseHandler(registry);
  });

  // ── Severity filtering ─────────────────────────────────────────────────────

  describe("severity filtering", () => {
    it("persists MAJOR findings", () => {
      const result = handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MAJOR" }),
      ]);
      expect(result.persistedCount).toBe(1);
      expect(result.memoryEntryIds).toHaveLength(1);
    });

    it("persists CRITICAL findings", () => {
      const result = handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "CRITICAL" }),
      ]);
      expect(result.persistedCount).toBe(1);
      expect(result.memoryEntryIds).toHaveLength(1);
    });

    it("drops MINOR findings", () => {
      const result = handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MINOR" }),
      ]);
      expect(result.persistedCount).toBe(0);
      expect(result.memoryEntryIds).toHaveLength(0);
      expect(registry.count()).toBe(0);
    });

    it("counts all findings in totalFindings regardless of severity", () => {
      const result = handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "MINOR" }),
        makeFinding({ severity: "MAJOR" }),
        makeFinding({ severity: "CRITICAL" }),
      ]);
      expect(result.totalFindings).toBe(3);
      expect(result.persistedCount).toBe(2);
    });
  });

  // ── Memory entry shape ─────────────────────────────────────────────────────

  describe("memory entry shape", () => {
    it("writes entries with category review-finding", () => {
      handler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const entries = registry.getByCategory("review-finding");
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe("review-finding");
    });

    it("includes severity and file in summary", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({
          severity: "CRITICAL",
          file: "src/api/client.ts",
          summary: "API key leaked in logs",
        }),
      ]);
      const entries = registry.getByCategory("review-finding");
      expect(entries[0].summary).toContain("CRITICAL");
      expect(entries[0].summary).toContain("src/api/client.ts");
      expect(entries[0].summary).toContain("API key leaked in logs");
    });

    it("includes line number in summary when provided", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/api/client.ts", line: 42 }),
      ]);
      const entries = registry.getByCategory("review-finding");
      expect(entries[0].summary).toContain("src/api/client.ts:42");
    });

    it("omits line from summary when not provided", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/api/client.ts" }),
      ]);
      const entries = registry.getByCategory("review-finding");
      // Should contain file path but no colon-number suffix
      expect(entries[0].summary).toContain("src/api/client.ts");
      expect(entries[0].summary).not.toMatch(/src\/api\/client\.ts:\d+/);
    });

    it("tags entry with severity, file, sprint id, and version", () => {
      handler.handleFindings("sprint-abc", "6.8", [
        makeFinding({ file: "src/orchestrator/task-router.ts" }),
      ]);
      const entries = registry.getByCategory("review-finding");
      const tags = entries[0].tags;
      expect(tags).toContain("review-finding");
      expect(tags).toContain("major");
      expect(tags).toContain("src/orchestrator/task-router.ts");
      expect(tags).toContain("sprint:sprint-abc");
      expect(tags).toContain("version:6.8");
    });

    it("sets ownerAgentId to the reviewer agent", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ reviewerAgentId: "meta-architect" }),
      ]);
      const entries = registry.getByCategory("review-finding");
      expect(entries[0].ownerAgentId).toBe("meta-architect");
    });

    it("assigns a higher relevance score to CRITICAL than MAJOR", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ severity: "CRITICAL", file: "src/a.ts" }),
        makeFinding({ severity: "MAJOR", file: "src/b.ts" }),
      ]);
      const entries = registry.getByCategory("review-finding");
      const critical = entries.find((e) => e.summary.includes("CRITICAL"))!;
      const major = entries.find((e) => e.summary.includes("MAJOR"))!;
      expect(critical.relevanceScore).toBeGreaterThan(major.relevanceScore);
    });

    it("uses a slow decay rate so entries persist across sprint cycles", () => {
      handler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const entries = registry.getByCategory("review-finding");
      // 0.005/day means ~200 days to full decay — intentionally slow
      expect(entries[0].decayRatePerDay).toBeLessThanOrEqual(0.01);
    });

    it("sets expiresAt to null so entries never auto-expire", () => {
      handler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const entries = registry.getByCategory("review-finding");
      expect(entries[0].expiresAt).toBeNull();
    });

    it("adds a line:<n> tag when line is provided", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ line: 99 }),
      ]);
      const entries = registry.getByCategory("review-finding");
      expect(entries[0].tags).toContain("line:99");
    });

    it("does not add a line tag when line is absent", () => {
      handler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const entries = registry.getByCategory("review-finding");
      expect(entries[0].tags.some((t) => t.startsWith("line:"))).toBe(false);
    });
  });

  // ── Metadata payload ───────────────────────────────────────────────────────

  describe("metadata payload", () => {
    it("populates metadata with all structured finding fields", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({
          severity: "CRITICAL",
          file: "src/api/auth.ts",
          line: 17,
          summary: "Token never expires",
          fixSuggestion: "Add expiry check before issuing tokens",
          reviewerAgentId: "security-auditor",
        }),
      ]);
      const entries = registry.getByCategory("review-finding");
      const meta = entries[0].metadata as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta.file).toBe("src/api/auth.ts");
      expect(meta.line).toBe(17);
      expect(meta.severity).toBe("CRITICAL");
      expect(meta.summary).toBe("Token never expires");
      expect(meta.fixSuggestion).toBe("Add expiry check before issuing tokens");
    });

    it("sets metadata.line to null when line is absent", () => {
      handler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const entries = registry.getByCategory("review-finding");
      const meta = entries[0].metadata as Record<string, unknown>;
      expect(meta.line).toBeNull();
    });

    it("sets metadata.fixSuggestion to null when fixSuggestion is absent", () => {
      handler.handleFindings("sprint-1", "6.8", [makeFinding()]);
      const entries = registry.getByCategory("review-finding");
      const meta = entries[0].metadata as Record<string, unknown>;
      expect(meta.fixSuggestion).toBeNull();
    });

    it("captures fixSuggestion when provided", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ fixSuggestion: "Use Math.max(totalTasks, 1) as divisor" }),
      ]);
      const entries = registry.getByCategory("review-finding");
      const meta = entries[0].metadata as Record<string, unknown>;
      expect(meta.fixSuggestion).toBe("Use Math.max(totalTasks, 1) as divisor");
    });
  });

  // ── Multi-finding batches ──────────────────────────────────────────────────

  describe("multi-finding batches", () => {
    it("writes one entry per qualifying finding", () => {
      handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/a.ts", severity: "MAJOR" }),
        makeFinding({ file: "src/b.ts", severity: "CRITICAL" }),
        makeFinding({ file: "src/c.ts", severity: "MINOR" }),
      ]);
      expect(registry.count()).toBe(2);
    });

    it("returns distinct memory entry ids", () => {
      const result = handler.handleFindings("sprint-1", "6.8", [
        makeFinding({ file: "src/a.ts", severity: "MAJOR" }),
        makeFinding({ file: "src/b.ts", severity: "CRITICAL" }),
      ]);
      const [id1, id2] = result.memoryEntryIds;
      expect(id1).not.toBe(id2);
    });

    it("handles an empty findings array gracefully", () => {
      const result = handler.handleFindings("sprint-1", "6.8", []);
      expect(result.totalFindings).toBe(0);
      expect(result.persistedCount).toBe(0);
      expect(result.memoryEntryIds).toHaveLength(0);
      expect(registry.count()).toBe(0);
    });
  });

  // ── Cross-cycle retrieval ──────────────────────────────────────────────────

  describe("getPersistedFindings", () => {
    it("returns all review-finding entries stored across calls", () => {
      handler.handleFindings("sprint-1", "6.7", [makeFinding({ severity: "MAJOR" })]);
      handler.handleFindings("sprint-2", "6.8", [makeFinding({ severity: "CRITICAL" })]);

      const all = handler.getPersistedFindings();
      expect(all).toHaveLength(2);
      expect(all.every((e) => e.category === "review-finding")).toBe(true);
    });

    it("returns an empty array when no findings have been persisted", () => {
      expect(handler.getPersistedFindings()).toHaveLength(0);
    });

    it("supports tag-based search for repeated file findings", () => {
      const repeatedFile = "src/orchestrator/cost-tracker.ts";
      handler.handleFindings("sprint-1", "6.7", [makeFinding({ file: repeatedFile, severity: "MAJOR" })]);
      handler.handleFindings("sprint-2", "6.8", [makeFinding({ file: repeatedFile, severity: "CRITICAL" })]);
      // Different file — should not appear
      handler.handleFindings("sprint-2", "6.8", [makeFinding({ file: "src/other.ts", severity: "MAJOR" })]);

      const hits = registry.searchByTags([repeatedFile]);
      expect(hits).toHaveLength(2);
    });
  });
});
