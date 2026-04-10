import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GatePhaseHandler,
  type GateVerdictInput,
  type GateVerdictMemoryWriter,
  type GateVerdictMetadata,
} from "../../src/autonomous/gate-phase-handler.js";
import type { SessionMemoryEntry } from "../../src/memory/session-memory-manager.js";
import type { CycleMemoryEntry } from "../../packages/core/src/memory/types.js";

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
  let tmpRoot: string;

  beforeEach(() => {
    const { writer, entries: e } = makeWriter();
    entries = e;
    handler = new GatePhaseHandler(writer);
    tmpRoot = mkdtempSync(join(tmpdir(), "agentforge-gate-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
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

  // ── JSONL write (projectRoot wiring) ───────────────────────────────────────

  describe("handleVerdict — JSONL store write", () => {
    function makeHandlerWithRoot(): { handler: GatePhaseHandler; entries: SessionMemoryEntry[] } {
      const { writer, entries: e } = makeWriter();
      return { handler: new GatePhaseHandler(writer, tmpRoot), entries: e };
    }

    it("does not write JSONL when projectRoot is not supplied", () => {
      // handler constructed without projectRoot (default)
      handler.handleVerdict(makeInput());
      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      expect(existsSync(jsonlPath)).toBe(false);
    });

    it("creates gate-verdict.jsonl when projectRoot is supplied", () => {
      const { handler: h } = makeHandlerWithRoot();
      h.handleVerdict(makeInput());
      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      expect(existsSync(jsonlPath)).toBe(true);
    });

    it("uses the same entryId in both stores", () => {
      const { handler: h, entries: e } = makeHandlerWithRoot();
      const result = h.handleVerdict(makeInput());

      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      const written = JSON.parse(readFileSync(jsonlPath, "utf8").trim()) as CycleMemoryEntry;

      // entryId returned == id in SessionMemoryManager == id in JSONL
      expect(result.entryId).toBe(e[0]!.id);
      expect(written.id).toBe(result.entryId);
    });

    it("writes type=gate-verdict to JSONL", () => {
      const { handler: h } = makeHandlerWithRoot();
      h.handleVerdict(makeInput());

      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      const written = JSON.parse(readFileSync(jsonlPath, "utf8").trim()) as CycleMemoryEntry;
      expect(written.type).toBe("gate-verdict");
    });

    it("sets source to cycleId in JSONL entry", () => {
      const { handler: h } = makeHandlerWithRoot();
      h.handleVerdict(makeInput({ cycleId: "cycle-abc" }));

      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      const written = JSON.parse(readFileSync(jsonlPath, "utf8").trim()) as CycleMemoryEntry;
      expect(written.source).toBe("cycle-abc");
    });

    it("includes the verdict in the JSONL tags", () => {
      const { handler: h } = makeHandlerWithRoot();
      h.handleVerdict(makeInput({ verdict: "approved" }));

      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      const written = JSON.parse(readFileSync(jsonlPath, "utf8").trim()) as CycleMemoryEntry;
      expect(written.tags).toContain("approved");
      expect(written.tags).toContain("gate");
    });

    it("stores structured GateVerdictMetadata in JSONL entry", () => {
      const { handler: h } = makeHandlerWithRoot();
      h.handleVerdict(makeInput({
        cycleId: "cycle-meta",
        verdict: "rejected",
        rationale: "Budget overrun",
        criticalFindings: ["OOM crash"],
        majorFindings: [],
      }));

      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      const written = JSON.parse(readFileSync(jsonlPath, "utf8").trim()) as CycleMemoryEntry;
      const meta = written.metadata as GateVerdictMetadata;

      expect(meta.cycleId).toBe("cycle-meta");
      expect(meta.verdict).toBe("rejected");
      expect(meta.rationale).toBe("Budget overrun");
      expect(meta.criticalFindings).toEqual(["OOM crash"]);
      expect(meta.majorFindings).toEqual([]);
    });

    it("appends multiple verdicts to the same JSONL file", () => {
      const { handler: h } = makeHandlerWithRoot();
      h.handleVerdict(makeInput({ cycleId: "cycle-1" }));
      h.handleVerdict(makeInput({ cycleId: "cycle-2" }));

      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      const lines = readFileSync(jsonlPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]!) as CycleMemoryEntry;
      const second = JSON.parse(lines[1]!) as CycleMemoryEntry;
      expect(first.source).toBe("cycle-1");
      expect(second.source).toBe("cycle-2");
    });

    it("still writes to SessionMemoryManager even when JSONL write is active", () => {
      const { handler: h, entries: e } = makeHandlerWithRoot();
      h.handleVerdict(makeInput());
      // Both stores should have been written
      expect(e).toHaveLength(1);
      const jsonlPath = join(tmpRoot, ".agentforge", "memory", "gate-verdict.jsonl");
      expect(existsSync(jsonlPath)).toBe(true);
    });
  });
});
