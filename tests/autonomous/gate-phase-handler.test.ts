import { describe, it, expect, beforeEach } from "vitest";
import {
  GatePhaseHandler,
  type GateVerdictInput,
  type GateVerdictMemoryWriter,
  type GateVerdictMetadata,
} from "../../src/autonomous/gate-phase-handler.js";
import type { SessionMemoryEntry } from "../../src/memory/session-memory-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<GateVerdictInput> = {}): GateVerdictInput {
  return {
    cycleId: "sprint-abc-123",
    verdict: "rejected",
    rationale: "Too many tests failing and budget overrun",
    criticalFindings: ["Memory leak in orchestrator"],
    majorFindings: ["Missing error handling in cost tracker"],
    ...overrides,
  };
}

function makeWriter(): { writer: GateVerdictMemoryWriter; entries: SessionMemoryEntry[] } {
  const entries: SessionMemoryEntry[] = [];
  const writer: GateVerdictMemoryWriter = { addEntry: (e) => entries.push(e) };
  return { writer, entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GatePhaseHandler", () => {
  let handler: GatePhaseHandler;
  let entries: SessionMemoryEntry[];

  beforeEach(() => {
    const { writer, entries: e } = makeWriter();
    entries = e;
    handler = new GatePhaseHandler(writer);
  });

  // ── Entry shape ────────────────────────────────────────────────────────────

  describe("handleVerdict — entry shape", () => {
    it("writes exactly one memory entry per call", () => {
      handler.handleVerdict(makeInput());
      expect(entries).toHaveLength(1);
    });

    it("returns the entryId that was written", () => {
      const result = handler.handleVerdict(makeInput());
      expect(result.entryId).toBeTruthy();
      expect(result.entryId).toBe(entries[0].id);
    });

    it("sets category to gate-verdict", () => {
      handler.handleVerdict(makeInput());
      expect(entries[0].category).toBe("gate-verdict");
    });

    it("sets agentId to gate-phase", () => {
      handler.handleVerdict(makeInput());
      expect(entries[0].agentId).toBe("gate-phase");
    });

    it("sets sessionId to the cycleId from input", () => {
      handler.handleVerdict(makeInput({ cycleId: "cycle-xyz" }));
      expect(entries[0].sessionId).toBe("cycle-xyz");
    });

    it("sets success=false for rejected verdicts", () => {
      handler.handleVerdict(makeInput({ verdict: "rejected" }));
      expect(entries[0].success).toBe(false);
    });

    it("sets success=true for approved verdicts", () => {
      handler.handleVerdict(makeInput({ verdict: "approved" }));
      expect(entries[0].success).toBe(true);
    });

    it("sets success=false for pending verdicts", () => {
      handler.handleVerdict(makeInput({ verdict: "pending" }));
      expect(entries[0].success).toBe(false);
    });

    it("populates a non-empty timestamp", () => {
      handler.handleVerdict(makeInput());
      expect(entries[0].timestamp).toBeTruthy();
      // Should be a parseable ISO-8601 date
      expect(new Date(entries[0].timestamp).getTime()).not.toBeNaN();
    });
  });

  // ── Summary string ─────────────────────────────────────────────────────────

  describe("handleVerdict — summary", () => {
    it("includes the verdict in the summary", () => {
      handler.handleVerdict(makeInput({ verdict: "rejected" }));
      expect(entries[0].summary).toContain("rejected");
    });

    it("includes the rationale in the summary", () => {
      const rationale = "All tests passed but budget was exceeded";
      handler.handleVerdict(makeInput({ rationale }));
      expect(entries[0].summary).toContain(rationale);
    });

    it("includes critical findings in the summary when present", () => {
      handler.handleVerdict(makeInput({ criticalFindings: ["Null pointer in router"] }));
      expect(entries[0].summary).toContain("Null pointer in router");
    });

    it("includes major findings in the summary when present", () => {
      handler.handleVerdict(makeInput({ majorFindings: ["Slow DB query >5s"] }));
      expect(entries[0].summary).toContain("Slow DB query >5s");
    });

    it("omits the Critical section when criticalFindings is empty", () => {
      handler.handleVerdict(makeInput({ criticalFindings: [] }));
      expect(entries[0].summary).not.toContain("Critical:");
    });

    it("omits the Major section when majorFindings is empty", () => {
      handler.handleVerdict(makeInput({ majorFindings: [] }));
      expect(entries[0].summary).not.toContain("Major:");
    });
  });

  // ── Metadata payload ───────────────────────────────────────────────────────

  describe("handleVerdict — metadata", () => {
    it("writes a metadata object", () => {
      handler.handleVerdict(makeInput());
      expect(entries[0].metadata).toBeDefined();
    });

    it("metadata contains the cycleId", () => {
      handler.handleVerdict(makeInput({ cycleId: "cycle-007" }));
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.cycleId).toBe("cycle-007");
    });

    it("metadata contains the verdict", () => {
      handler.handleVerdict(makeInput({ verdict: "approved" }));
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.verdict).toBe("approved");
    });

    it("metadata contains the rationale", () => {
      const rationale = "Sprint completed all P0 items";
      handler.handleVerdict(makeInput({ rationale }));
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.rationale).toBe(rationale);
    });

    it("metadata contains criticalFindings array", () => {
      const criticalFindings = ["Auth bypass in middleware", "Data loss in writer"];
      handler.handleVerdict(makeInput({ criticalFindings }));
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.criticalFindings).toEqual(criticalFindings);
    });

    it("metadata contains majorFindings array", () => {
      const majorFindings = ["Slow query in registry", "Missing retry logic"];
      handler.handleVerdict(makeInput({ majorFindings }));
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.majorFindings).toEqual(majorFindings);
    });

    it("metadata arrays are independent copies (immutability)", () => {
      const criticalFindings = ["Finding A"];
      handler.handleVerdict(makeInput({ criticalFindings }));
      criticalFindings.push("Finding B"); // mutate original after write
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.criticalFindings).toHaveLength(1); // copy was not mutated
    });

    it("handles empty findings arrays gracefully", () => {
      handler.handleVerdict(makeInput({ criticalFindings: [], majorFindings: [] }));
      const meta = entries[0].metadata as GateVerdictMetadata;
      expect(meta.criticalFindings).toEqual([]);
      expect(meta.majorFindings).toEqual([]);
    });
  });

  // ── Unique IDs ─────────────────────────────────────────────────────────────

  describe("handleVerdict — uniqueness", () => {
    it("generates a unique entryId for each call", () => {
      const r1 = handler.handleVerdict(makeInput());
      const r2 = handler.handleVerdict(makeInput());
      expect(r1.entryId).not.toBe(r2.entryId);
    });
  });
});
