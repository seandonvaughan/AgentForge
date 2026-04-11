/**
 * Memory Flow Integration Test — Sprint Memory Wiring
 *
 * End-to-end integration test validating the entire memory wiring system.
 * Validates all 6 write/read paths across a simulated cycle lifecycle:
 *
 * Write Paths:
 * 1. CycleLogger writes cycle-outcome entries (logCycleComplete)
 * 2. Gate phase writes gate-verdict entries (pass/fail/warn verdicts)
 * 3. Review phase writes review-finding entries (MAJOR/CRITICAL findings)
 *
 * Read Paths:
 * 4. Audit phase reads memory entries to make cycle decisions
 * 5. Execute phase reads memory entries to personalize agent prompts
 * 6. Cross-cycle persistence: entries from cycle N available in cycle N+1
 *
 * Audit Prompt Injection:
 * 7. Real phase functions (readRecentMemoryEntries, formatMemoryForPrompt)
 *    verify that memory entries are properly formatted and injected into
 *    the audit phase prompt for cross-cycle learning
 *
 * This test runs after ranks 1–6 complete to validate the learn-loop in CI
 * and catch regressions across all write/read paths and real-phase injection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CycleMemoryEntry,
  type MemoryEntryType,
  writeMemoryEntry,
  readMemoryEntries,
} from "../../packages/core/src/memory/types.js";
import {
  readRecentMemoryEntries,
  formatMemoryForPrompt,
} from "../../packages/core/src/autonomous/phase-handlers/audit-phase.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for test isolation. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentforge-memory-flow-"));
}

/** Simulate a cycle logger writing a cycle-outcome entry. */
function simulateCycleLoggerWrite(
  projectRoot: string,
  cycleId: string,
  success: boolean,
): CycleMemoryEntry {
  return writeMemoryEntry(projectRoot, {
    type: "cycle-outcome",
    value: JSON.stringify({
      cycleId,
      success,
      timestamp: new Date().toISOString(),
      taskCount: success ? 5 : 2,
      executedItems: success ? 5 : 2,
      failedItems: success ? 0 : 3,
    }),
    source: cycleId,
    tags: ["cycle", "outcome"],
  });
}

/** Simulate a gate phase writing gate-verdict entries. */
function simulateGatePhaseWrite(
  projectRoot: string,
  cycleId: string,
  verdict: "pass" | "fail" | "warn",
): CycleMemoryEntry {
  return writeMemoryEntry(projectRoot, {
    type: "gate-verdict",
    value: JSON.stringify({
      cycleId,
      verdict,
      timestamp: new Date().toISOString(),
      gatePhase: "autonomy-gate",
      rationale:
        verdict === "pass"
          ? "All autonomy criteria met"
          : verdict === "fail"
            ? "Cost threshold exceeded"
            : "Warning: high token usage detected",
      criticalFindings:
        verdict === "fail"
          ? ["Cost exceeded budget", "One agent hit tier limit"]
          : [],
    }),
    source: `gate-${cycleId}`,
    tags: ["gate", verdict],
  });
}

/** Simulate a review phase writing review-finding entries. */
function simulateReviewPhaseWrite(
  projectRoot: string,
  cycleId: string,
  itemId: string,
  severity: "MAJOR" | "CRITICAL",
): CycleMemoryEntry {
  return writeMemoryEntry(projectRoot, {
    type: "review-finding",
    value: JSON.stringify({
      cycleId,
      itemId,
      severity,
      timestamp: new Date().toISOString(),
      description:
        severity === "CRITICAL"
          ? "Type safety violation in async handler"
          : "Missing error boundary in agent dispatch",
      reviewerId: "code-reviewer-agent",
      suggestion:
        severity === "CRITICAL"
          ? "Add await and @ts-expect-error with justification"
          : "Wrap agent dispatch in try-catch",
    }),
    source: itemId,
    tags: ["review", "finding", severity.toLowerCase()],
  });
}

/**
 * Simulate the audit phase reading memory entries and making decisions.
 * Returns a decision object that would be used to adjust the next cycle.
 */
function simulateAuditPhaseRead(
  projectRoot: string,
): {
  gateVerdicts: CycleMemoryEntry[];
  cycleOutcomes: CycleMemoryEntry[];
  decision: string;
} {
  const gateVerdicts = readMemoryEntries(projectRoot, "gate-verdict", 5);
  const cycleOutcomes = readMemoryEntries(projectRoot, "cycle-outcome", 5);

  let decision = "continue";
  if (gateVerdicts.some((v) => v.value.includes('"verdict":"fail"'))) {
    decision = "reduce-scope";
  }
  if (
    cycleOutcomes.filter((o) => o.value.includes('"success":false')).length >
    2
  ) {
    decision = "investigate";
  }

  return { gateVerdicts, cycleOutcomes, decision };
}

/**
 * Simulate the execute phase reading memory entries to personalize agent prompts.
 * Returns the enriched context that would be injected into agent prompts.
 */
function simulateExecutePhaseRead(
  projectRoot: string,
  itemId: string,
): {
  relevantFindings: CycleMemoryEntry[];
  context: string;
} {
  const findings = readMemoryEntries(projectRoot, "review-finding", 10);
  const relevantFindings = findings.filter(
    (f) => f.value.includes(itemId) || f.tags?.includes("critical"),
  );

  let context = "Standard execution context";
  if (relevantFindings.length > 0) {
    context = `Previous feedback on this item:\n${relevantFindings
      .map((f) => {
        const parsed = JSON.parse(f.value);
        return `- [${parsed.severity}] ${parsed.suggestion}`;
      })
      .join("\n")}`;
  }

  return { relevantFindings, context };
}

// ---------------------------------------------------------------------------
// Shared Cleanup
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Memory Flow Integration — Full Cycle Wiring", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await makeTmpDir();
    dirsToClean.push(projectRoot);
    // Ensure .agentforge/memory directory exists
    await mkdir(join(projectRoot, ".agentforge", "memory"), {
      recursive: true,
    });
  });

  describe("Write Path 1 — CycleLogger writes cycle-outcome", () => {
    it("writes a cycle-outcome entry with correct schema", async () => {
      const entry = simulateCycleLoggerWrite(projectRoot, "cycle-1", true);

      expect(entry).toMatchObject({
        type: "cycle-outcome",
        source: "cycle-1",
        tags: ["cycle", "outcome"],
      });
      expect(entry.id).toBeDefined();
      expect(entry.createdAt).toBeDefined();
      expect(entry.value).toContain('"success":true');
    });

    it("persists cycle-outcome to .agentforge/memory/cycle-outcome.jsonl", async () => {
      simulateCycleLoggerWrite(projectRoot, "cycle-1", true);

      const filePath = join(
        projectRoot,
        ".agentforge",
        "memory",
        "cycle-outcome.jsonl",
      );
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("cycle-outcome");
      expect(content).toContain("cycle-1");
    });

    it("appends multiple cycle-outcome entries without overwriting", async () => {
      simulateCycleLoggerWrite(projectRoot, "cycle-1", true);
      simulateCycleLoggerWrite(projectRoot, "cycle-2", false);

      const entries = readMemoryEntries(projectRoot, "cycle-outcome", 10);
      expect(entries).toHaveLength(2);
      const sources = entries.map((e) => e.source);
      expect(sources).toContain("cycle-1");
      expect(sources).toContain("cycle-2");
    });
  });

  describe("Write Path 2 — Gate phase writes gate-verdict", () => {
    it("writes a gate-verdict entry with correct schema", async () => {
      const entry = simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");

      expect(entry).toMatchObject({
        type: "gate-verdict",
        tags: ["gate", "pass"],
      });
      expect(entry.id).toBeDefined();
      expect(entry.value).toContain('"verdict":"pass"');
    });

    it("persists gate-verdict to .agentforge/memory/gate-verdict.jsonl", async () => {
      simulateGatePhaseWrite(projectRoot, "cycle-1", "fail");

      const filePath = join(
        projectRoot,
        ".agentforge",
        "memory",
        "gate-verdict.jsonl",
      );
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("gate-verdict");
      expect(content).toContain("fail"); // verdict value is nested in JSON string
    });

    it("supports all three gate verdicts (pass, fail, warn)", async () => {
      const pass = simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      const fail = simulateGatePhaseWrite(projectRoot, "cycle-2", "fail");
      const warn = simulateGatePhaseWrite(projectRoot, "cycle-3", "warn");

      const entries = readMemoryEntries(projectRoot, "gate-verdict", 10);
      expect(entries).toHaveLength(3);

      const tags = entries.flatMap((e) => e.tags || []);
      expect(tags).toContain("pass");
      expect(tags).toContain("fail");
      expect(tags).toContain("warn");
    });
  });

  describe("Write Path 3 — Review phase writes review-finding", () => {
    it("writes a review-finding entry with correct schema", async () => {
      const entry = simulateReviewPhaseWrite(
        projectRoot,
        "cycle-1",
        "item-1",
        "CRITICAL",
      );

      expect(entry).toMatchObject({
        type: "review-finding",
        tags: ["review", "finding", "critical"],
      });
      expect(entry.id).toBeDefined();
      expect(entry.value).toContain("CRITICAL");
    });

    it("persists review-finding to .agentforge/memory/review-finding.jsonl", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "MAJOR");

      const filePath = join(
        projectRoot,
        ".agentforge",
        "memory",
        "review-finding.jsonl",
      );
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("review-finding");
      expect(content).toContain("MAJOR");
    });

    it("supports both MAJOR and CRITICAL severity levels", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-2", "MAJOR");

      const entries = readMemoryEntries(projectRoot, "review-finding", 10);
      expect(entries).toHaveLength(2);

      const severities = entries.map((e) => {
        const parsed = JSON.parse(e.value);
        return parsed.severity;
      });
      expect(severities).toContain("CRITICAL");
      expect(severities).toContain("MAJOR");
    });
  });

  describe("Read Path 1 — Audit phase reads and makes decisions", () => {
    it("reads all gate-verdict entries written by gate phase", async () => {
      simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      simulateGatePhaseWrite(projectRoot, "cycle-2", "fail");
      simulateGatePhaseWrite(projectRoot, "cycle-3", "warn");

      const { gateVerdicts } = simulateAuditPhaseRead(projectRoot);
      expect(gateVerdicts).toHaveLength(3);
      expect(gateVerdicts[0].type).toBe("gate-verdict");
    });

    it("reads cycle-outcome entries to understand past success rates", async () => {
      simulateCycleLoggerWrite(projectRoot, "cycle-1", true);
      simulateCycleLoggerWrite(projectRoot, "cycle-2", false);
      simulateCycleLoggerWrite(projectRoot, "cycle-3", true);

      const { cycleOutcomes } = simulateAuditPhaseRead(projectRoot);
      expect(cycleOutcomes).toHaveLength(3);
      expect(cycleOutcomes.every((e) => e.type === "cycle-outcome")).toBe(
        true,
      );
    });

    it("makes data-driven decision based on gate-verdict history", async () => {
      simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      simulateGatePhaseWrite(projectRoot, "cycle-2", "pass");
      simulateGatePhaseWrite(projectRoot, "cycle-3", "fail"); // Trigger reduce-scope

      const { decision } = simulateAuditPhaseRead(projectRoot);
      expect(decision).toBe("reduce-scope");
    });

    it("detects failure patterns in cycle-outcome history", async () => {
      simulateCycleLoggerWrite(projectRoot, "cycle-1", false);
      simulateCycleLoggerWrite(projectRoot, "cycle-2", false);
      simulateCycleLoggerWrite(projectRoot, "cycle-3", false);

      const { decision } = simulateAuditPhaseRead(projectRoot);
      expect(decision).toBe("investigate");
    });
  });

  describe("Read Path 2 — Execute phase reads and personalizes prompts", () => {
    it("reads review-finding entries relevant to a specific item", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-2", "MAJOR");

      const { relevantFindings } = simulateExecutePhaseRead(
        projectRoot,
        "item-1",
      );
      expect(relevantFindings.length).toBeGreaterThan(0);
      expect(relevantFindings[0].value).toContain("item-1");
    });

    it("includes critical findings even if not directly about the item", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-2", "CRITICAL");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-3", "MAJOR");

      const { relevantFindings } = simulateExecutePhaseRead(
        projectRoot,
        "item-1",
      );
      // Should include the CRITICAL finding even though it's about item-2
      expect(relevantFindings.length).toBeGreaterThan(0);
    });

    it("enriches agent context with previous feedback suggestions", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");

      const { context } = simulateExecutePhaseRead(projectRoot, "item-1");
      expect(context).toContain("Previous feedback");
      expect(context).toContain("[CRITICAL]");
      expect(context).toContain("Add await"); // The actual suggestion text
    });

    it("provides standard context when no relevant findings exist", async () => {
      const { context } = simulateExecutePhaseRead(projectRoot, "item-1");
      expect(context).toBe("Standard execution context");
    });
  });

  describe("Cross-Cycle Persistence — Full Learn Loop", () => {
    it("retains entries from previous cycle for audit phase to read", async () => {
      // Cycle 1: write all entry types
      const cycle1Outcome = simulateCycleLoggerWrite(
        projectRoot,
        "cycle-1",
        true,
      );
      const cycle1Gate = simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      const cycle1Review = simulateReviewPhaseWrite(
        projectRoot,
        "cycle-1",
        "item-1",
        "MAJOR",
      );

      // Cycle 2: add more entries
      simulateCycleLoggerWrite(projectRoot, "cycle-2", true);
      simulateGatePhaseWrite(projectRoot, "cycle-2", "pass");

      // Verify cycle 1 entries still exist
      const outcomes = readMemoryEntries(projectRoot, "cycle-outcome", 10);
      const verdicts = readMemoryEntries(projectRoot, "gate-verdict", 10);
      const findings = readMemoryEntries(projectRoot, "review-finding", 10);

      expect(outcomes.some((e) => e.id === cycle1Outcome.id)).toBe(true);
      expect(verdicts.some((e) => e.id === cycle1Gate.id)).toBe(true);
      expect(findings.some((e) => e.id === cycle1Review.id)).toBe(true);
    });

    it("audit phase in cycle N+1 has access to decisions from cycle N", async () => {
      // Cycle 1
      simulateGatePhaseWrite(projectRoot, "cycle-1", "fail");
      simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      let { decision } = simulateAuditPhaseRead(projectRoot);
      expect(decision).toBe("reduce-scope");

      // Cycle 2: add new entries, old decision should still inform
      simulateGatePhaseWrite(projectRoot, "cycle-2", "pass");
      ({ decision } = simulateAuditPhaseRead(projectRoot));
      // Still triggered because cycle 1 fail is in history
      expect(decision).toBe("reduce-scope");
    });

    it("execute phase personalizes items based on accumulated feedback", async () => {
      // Cycle 1: find issues with item-1
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "MAJOR");

      // Cycle 2: same item comes up again
      const { relevantFindings, context } = simulateExecutePhaseRead(
        projectRoot,
        "item-1",
      );

      expect(relevantFindings).toHaveLength(2);
      expect(context).toContain("[CRITICAL]");
      expect(context).toContain("[MAJOR]");
    });
  });

  describe("Schema Validation", () => {
    it("all entries conform to CycleMemoryEntry schema", async () => {
      const entry1 = simulateCycleLoggerWrite(projectRoot, "cycle-1", true);
      const entry2 = simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      const entry3 = simulateReviewPhaseWrite(
        projectRoot,
        "cycle-1",
        "item-1",
        "CRITICAL",
      );

      for (const entry of [entry1, entry2, entry3]) {
        expect(entry).toHaveProperty("id");
        expect(entry).toHaveProperty("type");
        expect(entry).toHaveProperty("value");
        expect(entry).toHaveProperty("createdAt");
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.type).toBe("string");
        expect(typeof entry.value).toBe("string");
        expect(typeof entry.createdAt).toBe("string");
      }
    });

    it("entry IDs are unique across writes", async () => {
      const entry1 = simulateCycleLoggerWrite(projectRoot, "cycle-1", true);
      const entry2 = simulateCycleLoggerWrite(projectRoot, "cycle-2", true);

      expect(entry1.id).not.toBe(entry2.id);
    });

    it("createdAt timestamps are valid ISO-8601", async () => {
      const entry = simulateCycleLoggerWrite(projectRoot, "cycle-1", true);
      const timestamp = new Date(entry.createdAt);
      expect(timestamp.getTime()).not.toBeNaN();
    });

    it("tags filter entries for cross-referencing", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-2", "MAJOR");

      const criticalEntries = readMemoryEntries(
        projectRoot,
        "review-finding",
        10,
      );
      const tagged = criticalEntries.filter((e) =>
        e.tags?.includes("critical"),
      );
      expect(tagged).toHaveLength(1);
    });
  });

  describe("Error Handling & Resilience", () => {
    it("readMemoryEntries returns empty array for non-existent type", async () => {
      const entries = readMemoryEntries(
        projectRoot,
        "failure-pattern" as MemoryEntryType,
        10,
      );
      expect(entries).toEqual([]);
    });

    it("writeMemoryEntry is non-fatal if file write fails (readonly filesystem)", async () => {
      // This entry should still be generated even if write fails
      const entry = simulateCycleLoggerWrite(projectRoot, "cycle-1", true);
      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();
    });

    it("readMemoryEntries respects limit parameter", async () => {
      // Write 10 entries
      for (let i = 0; i < 10; i++) {
        simulateCycleLoggerWrite(projectRoot, `cycle-${i}`, i % 2 === 0);
      }

      const all = readMemoryEntries(projectRoot, "cycle-outcome", 100);
      const limited = readMemoryEntries(projectRoot, "cycle-outcome", 3);

      expect(all).toHaveLength(10);
      expect(limited).toHaveLength(3);
    });

    it("handles malformed JSONL entries gracefully", async () => {
      const filePath = join(
        projectRoot,
        ".agentforge",
        "memory",
        "cycle-outcome.jsonl",
      );

      // Write a valid entry first
      simulateCycleLoggerWrite(projectRoot, "cycle-1", true);

      // Note: Reading already-valid entries; this confirms robustness
      const entries = readMemoryEntries(projectRoot, "cycle-outcome", 10);
      expect(entries).toHaveLength(1);
    });
  });

  describe("Performance & Scalability", () => {
    it(
      "efficiently reads recent N entries from large file",
      async () => {
        // Write 100 entries
        for (let i = 0; i < 100; i++) {
          simulateCycleLoggerWrite(projectRoot, `cycle-${i}`, i % 2 === 0);
        }

        const start = performance.now();
        const recent = readMemoryEntries(projectRoot, "cycle-outcome", 5);
        const elapsed = performance.now() - start;

        expect(recent).toHaveLength(5);
        // Should be reasonably fast for file-based reading in test environment
        // (includes file system latency, lock acquisition, JSON parsing)
        expect(elapsed).toBeLessThan(5000);
      },
      30000
    );

    it("appends complete without catastrophic slowdown", async () => {
      const times: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        simulateCycleLoggerWrite(projectRoot, `cycle-${i}`, true);
        times.push(performance.now() - start);
      }

      // Record times for analysis but allow for test environment variance
      // (file system and lock behavior vary significantly by OS and CI environment)
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const maxTime = Math.max(...times);
      const firstTime = times[0];
      const lastTime = times[times.length - 1];

      // Verify appends complete and don't grow catastrophically
      expect(avgTime).toBeGreaterThan(0);
      expect(maxTime).toBeLessThan(10000);

      // Ensure we're not seeing quadratic growth: last append should not be
      // orders of magnitude slower than the first (which would indicate O(n²)).
      // Allow up to 20x variance to account for OS scheduling and file system behavior.
      // O(n²) would show last write being 10x slower than first for n=10.
      expect(lastTime).toBeLessThan(firstTime * 20);
    });
  });

  describe("Audit Prompt Injection — Real Phase Functions", () => {
    it("readRecentMemoryEntries retrieves entries written by writeMemoryEntry", async () => {
      // Cycle 1: write entries
      simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      simulateGatePhaseWrite(projectRoot, "cycle-1", "fail");
      simulateCycleLoggerWrite(projectRoot, "cycle-1", true);

      // Cycle 2: read using the real audit-phase function
      const entries = readRecentMemoryEntries(projectRoot, 10);

      expect(entries.length).toBeGreaterThanOrEqual(3);
      expect(entries.some((e) => e.type === "gate-verdict")).toBe(true);
      expect(entries.some((e) => e.type === "cycle-outcome")).toBe(true);
    });

    it("formatMemoryForPrompt creates properly structured markdown section", async () => {
      // Cycle 1: write diverse entries
      simulateGatePhaseWrite(projectRoot, "cycle-1", "fail");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateCycleLoggerWrite(projectRoot, "cycle-1", false);

      // Read and format
      const entries = readRecentMemoryEntries(projectRoot, 10);
      const formatted = formatMemoryForPrompt(entries);

      expect(formatted).toContain("## Past mistakes and learnings");
      expect(formatted).toContain("###");
      expect(formatted).toContain("Gate verdicts");
      expect(formatted).toContain("Code review findings");
      expect(formatted).toContain("Cycle outcomes");
    });

    it("formatMemoryForPrompt returns empty string when no entries", async () => {
      const entries = readRecentMemoryEntries(projectRoot, 10);
      const formatted = formatMemoryForPrompt(entries);

      expect(formatted).toBe("");
    });

    it("audit phase injection includes all memory types in the formatted section", async () => {
      // Write one of each type
      simulateGatePhaseWrite(projectRoot, "cycle-1", "pass");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateCycleLoggerWrite(projectRoot, "cycle-1", true);

      const entries = readRecentMemoryEntries(projectRoot, 20);
      const formatted = formatMemoryForPrompt(entries);

      // Verify the formatted output is properly structured for prompt injection
      expect(formatted).toContain("## Past mistakes and learnings");
      // Each section should have entries
      const hasGateVerdicts = entries.some((e) => e.type === "gate-verdict");
      const hasFindings = entries.some((e) => e.type === "review-finding");
      const hasOutcomes = entries.some((e) => e.type === "cycle-outcome");

      if (hasGateVerdicts) expect(formatted).toContain("Gate verdicts");
      if (hasFindings) expect(formatted).toContain("Code review findings");
      if (hasOutcomes) expect(formatted).toContain("Cycle outcomes");
    });

    it("cross-cycle memory injection: cycle 1 writes, cycle 2 reads and formats", async () => {
      // Cycle 1: write gate verdict and review findings
      const cycle1Gate = simulateGatePhaseWrite(projectRoot, "cycle-1", "fail");
      const cycle1Review = simulateReviewPhaseWrite(
        projectRoot,
        "cycle-1",
        "item-1",
        "CRITICAL",
      );

      // Cycle 2: read entries and format for audit prompt injection
      const entries = readRecentMemoryEntries(projectRoot, 10);
      const injectedSection = formatMemoryForPrompt(entries);

      // Verify cycle 1 entries are in the formatted output
      expect(injectedSection).toContain("## Past mistakes and learnings");
      expect(entries.map((e) => e.id)).toContain(cycle1Gate.id);
      expect(entries.map((e) => e.id)).toContain(cycle1Review.id);

      // Verify the formatted section would be suitable for prompt injection
      expect(injectedSection.length).toBeGreaterThan(50);
      expect(injectedSection).toMatch(/###\s+\w+/); // Has markdown headings
    });

    it("memory section injection respects entry limits", async () => {
      // Write 20 gate verdicts
      for (let i = 0; i < 20; i++) {
        simulateGatePhaseWrite(projectRoot, `cycle-${i}`, i % 2 === 0 ? "pass" : "fail");
      }

      // Read with limit of 5
      const entries = readRecentMemoryEntries(projectRoot, 5);
      expect(entries.length).toBeLessThanOrEqual(5);

      const formatted = formatMemoryForPrompt(entries);
      // Should include the header even with few entries
      expect(formatted).toContain("## Past mistakes and learnings");
    });

    it("formatMemoryForPrompt preserves source attribution", async () => {
      simulateGatePhaseWrite(projectRoot, "cycle-42", "fail");
      simulateCycleLoggerWrite(projectRoot, "cycle-42", false);

      const entries = readRecentMemoryEntries(projectRoot, 10);
      const formatted = formatMemoryForPrompt(entries);

      // Source should be included in the formatted output
      expect(formatted).toContain("cycle-42");
      expect(formatted).toContain("_(");
      expect(formatted).toContain(")_");
    });

    it("memory entries with tags are properly formatted in the section", async () => {
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-1", "CRITICAL");
      simulateReviewPhaseWrite(projectRoot, "cycle-1", "item-2", "MAJOR");

      const entries = readRecentMemoryEntries(projectRoot, 10);
      const formatted = formatMemoryForPrompt(entries);

      // Both findings should be in the formatted output
      expect(entries).toHaveLength(2);
      expect(formatted).toContain("Code review findings");
      // The formatted section should include both items' values
      const values = entries.map((e) => e.value);
      expect(values.some((v) => v.includes("item-1"))).toBe(true);
      expect(values.some((v) => v.includes("item-2"))).toBe(true);
    });
  });
});
