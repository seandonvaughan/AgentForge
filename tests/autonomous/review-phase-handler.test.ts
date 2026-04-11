import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// JSONL persistence — verifies the file-system write path when projectRoot is
// supplied. Each test uses a fresh temp directory so tests are isolated.
// ---------------------------------------------------------------------------

describe("ReviewPhaseHandler — JSONL persistence", () => {
  let projectRoot: string;
  let cleanup: () => void;
  let registry: MemoryRegistry;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agentforge-review-"));
    cleanup = () => {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
      } catch {}
    };
    registry = new MemoryRegistry();
  });

  afterEach(() => {
    cleanup();
  });

  const JSONL_PATH = (root: string) =>
    join(root, ".agentforge", "memory", "review-finding.jsonl");

  it("creates review-finding.jsonl when a MAJOR finding is processed", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [makeFinding({ severity: "MAJOR" })]);

    expect(existsSync(JSONL_PATH(projectRoot))).toBe(true);
  });

  it("creates review-finding.jsonl when a CRITICAL finding is processed", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [makeFinding({ severity: "CRITICAL" })]);

    expect(existsSync(JSONL_PATH(projectRoot))).toBe(true);
  });

  it("does not create the JSONL file for MINOR-only findings", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [makeFinding({ severity: "MINOR" })]);

    expect(existsSync(JSONL_PATH(projectRoot))).toBe(false);
  });

  it("does not create the JSONL file when projectRoot is not provided", () => {
    const handler = new ReviewPhaseHandler(registry); // no projectRoot
    handler.handleFindings("sprint-1", "9.4", [makeFinding({ severity: "MAJOR" })]);

    // The in-memory registry should have the entry
    expect(registry.count()).toBe(1);
    // But no JSONL file should exist in the temp dir (nothing was written there)
    expect(existsSync(JSONL_PATH(projectRoot))).toBe(false);
  });

  it("writes a well-formed JSONL entry with correct type and source", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-abc", "9.4", [makeFinding({ severity: "MAJOR" })]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as Record<string, unknown>;

    expect(entry.type).toBe("review-finding");
    expect(entry.source).toBe("sprint-abc");
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.createdAt).toBe("string");
  });

  it("entry id in JSONL matches the id returned in memoryEntryIds", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    const result = handler.handleFindings("sprint-1", "9.4", [makeFinding()]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { id: string };

    expect(entry.id).toBe(result.memoryEntryIds[0]);
  });

  it("JSONL entry value includes severity, file, and summary", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [
      makeFinding({
        severity: "CRITICAL",
        file: "src/api/client.ts",
        summary: "API key leaked in logs",
      }),
    ]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { value: string };

    expect(entry.value).toContain("CRITICAL");
    expect(entry.value).toContain("src/api/client.ts");
    expect(entry.value).toContain("API key leaked in logs");
  });

  it("JSONL entry value includes line number when provided", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [
      makeFinding({ file: "src/api/client.ts", line: 42, severity: "MAJOR" }),
    ]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { value: string };

    expect(entry.value).toContain("src/api/client.ts:42");
  });

  it("JSONL entry carries structured ReviewFindingMetadata", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [
      makeFinding({
        severity: "CRITICAL",
        file: "src/api/auth.ts",
        line: 17,
        summary: "Token never expires",
        fixSuggestion: "Add expiry check before issuing tokens",
      }),
    ]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { metadata: Record<string, unknown> };

    expect(entry.metadata).toBeDefined();
    expect(entry.metadata.severity).toBe("CRITICAL");
    expect(entry.metadata.file).toBe("src/api/auth.ts");
    expect(entry.metadata.line).toBe(17);
    expect(entry.metadata.summary).toBe("Token never expires");
    expect(entry.metadata.fixSuggestion).toBe("Add expiry check before issuing tokens");
  });

  it("JSONL metadata sets fixSuggestion to null when absent", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [makeFinding({ severity: "MAJOR" })]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { metadata: Record<string, unknown> };
    expect(entry.metadata.fixSuggestion).toBeNull();
  });

  it("JSONL metadata sets line to null when absent", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [makeFinding({ severity: "MAJOR" })]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { metadata: Record<string, unknown> };
    expect(entry.metadata.line).toBeNull();
  });

  it("JSONL entry tags match the registry entry tags", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-xyz", "9.4", [
      makeFinding({ file: "src/orchestrator/task-router.ts", severity: "MAJOR" }),
    ]);

    const line = readFileSync(JSONL_PATH(projectRoot), "utf8").trim();
    const entry = JSON.parse(line) as { tags: string[] };
    const registryEntry = registry.getByCategory("review-finding")[0]!;

    expect(entry.tags).toEqual(registryEntry.tags);
    expect(entry.tags).toContain("review-finding");
    expect(entry.tags).toContain("major");
    expect(entry.tags).toContain("sprint:sprint-xyz");
  });

  it("appends one JSONL line per qualifying finding", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.4", [
      makeFinding({ file: "src/a.ts", severity: "MAJOR" }),
      makeFinding({ file: "src/b.ts", severity: "CRITICAL" }),
      makeFinding({ file: "src/c.ts", severity: "MINOR" }), // should not be written
    ]);

    const lines = readFileSync(JSONL_PATH(projectRoot), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(2);
  });

  it("appends across multiple handleFindings calls without overwriting", () => {
    const handler = new ReviewPhaseHandler(registry, projectRoot);
    handler.handleFindings("sprint-1", "9.3", [makeFinding({ severity: "MAJOR" })]);
    handler.handleFindings("sprint-2", "9.4", [makeFinding({ severity: "CRITICAL" })]);

    const lines = readFileSync(JSONL_PATH(projectRoot), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(2);
    const sources = lines.map((l) => (JSON.parse(l) as { source: string }).source);
    expect(sources).toContain("sprint-1");
    expect(sources).toContain("sprint-2");
  });

  it("handler result is correct even when JSONL write fails non-fatally", () => {
    // Use a projectRoot that points to a non-directory path to trigger I/O error.
    // writeMemoryEntry swallows I/O errors, so handleFindings must still return.
    const badRoot = join(projectRoot, "this-is-a-file-not-a-dir.txt");

    const handler = new ReviewPhaseHandler(registry, badRoot);
    const result = handler.handleFindings("sprint-1", "9.4", [
      makeFinding({ severity: "MAJOR" }),
    ]);

    // Result must be correct — the JSONL write failure is non-fatal.
    expect(result.totalFindings).toBe(1);
    expect(result.persistedCount).toBe(1);
    expect(result.memoryEntryIds).toHaveLength(1);
    // Registry entry must still exist.
    expect(registry.count()).toBe(1);
  });
});
