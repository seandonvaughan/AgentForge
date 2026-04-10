/**
 * GatePhaseHandler — Sprint Gate Phase Memory Writer
 *
 * Called at the "gate" phase of each sprint cycle. Records a gate-verdict
 * memory entry carrying the full structured verdict: cycleId, verdict,
 * rationale, and the critical/major findings that drove the decision.
 *
 * Written entries are read by AuditPhaseHandler at the start of the next
 * sprint cycle, closing the feedback loop that lets the team avoid
 * repeating the same mistakes across cycles.
 *
 * Writes to two stores on each call:
 * 1. SessionMemoryManager (via injected memoryWriter) — in-memory + JSON,
 *    consumed by AuditPhaseHandler.collectGateVerdicts().
 * 2. JSONL file store (via writeMemoryEntry) — append-only, lock-safe,
 *    consumed by the /api/v5/memory endpoint and the flywheel dashboard.
 *    Only active when projectRoot is supplied to the constructor.
 */

import { randomUUID } from "node:crypto";
import type { SessionMemoryEntry } from "../memory/session-memory-manager.js";
import { writeMemoryEntry } from "../../packages/core/src/memory/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Inputs the gate phase produces and that should be recorded in memory. */
export interface GateVerdictInput {
  /** Cycle identifier — matches the sprintId used by AutonomousSprintFramework. */
  cycleId: string;
  /** The gate decision. */
  verdict: "approved" | "rejected" | "pending";
  /** Human-readable explanation of why the verdict was reached. */
  rationale: string;
  /** CRITICAL-severity findings that contributed to the gate decision. */
  criticalFindings: string[];
  /** MAJOR-severity findings that contributed to the gate decision. */
  majorFindings: string[];
}

/**
 * Structured payload stored in SessionMemoryEntry.metadata for gate verdicts.
 * AuditPhaseHandler reads this shape to build richer prompt injections.
 */
export interface GateVerdictMetadata {
  cycleId: string;
  verdict: "approved" | "rejected" | "pending";
  rationale: string;
  criticalFindings: string[];
  majorFindings: string[];
}

/** Minimal write interface — structurally satisfied by SessionMemoryManager. */
export interface GateVerdictMemoryWriter {
  addEntry(entry: SessionMemoryEntry): void;
}

/** Result returned by handleVerdict for traceability. */
export interface GatePhaseResult {
  /** The memory entry ID that was written. */
  entryId: string;
}

// ---------------------------------------------------------------------------
// GatePhaseHandler
// ---------------------------------------------------------------------------

export class GatePhaseHandler {
  /**
   * @param memoryWriter - Injected writer for the SessionMemoryManager store.
   * @param projectRoot  - Absolute path to the project root. When provided,
   *   handleVerdict() additionally appends an entry to
   *   `.agentforge/memory/gate-verdict.jsonl` via writeMemoryEntry so the
   *   verdict is available to the /api/v5/memory endpoint and flywheel
   *   dashboard without requiring a running SessionMemoryManager instance.
   */
  constructor(
    private readonly memoryWriter: GateVerdictMemoryWriter,
    private readonly projectRoot?: string,
  ) {}

  /**
   * Record a gate verdict as a structured memory entry.
   *
   * Both the human-readable summary and the machine-readable metadata are
   * written so downstream consumers (AuditPhaseHandler) can choose the
   * richest available representation.
   *
   * When projectRoot is set, the verdict is also appended to the canonical
   * JSONL store at `.agentforge/memory/gate-verdict.jsonl`.
   *
   * @param input - Full gate verdict including rationale and findings.
   * @returns The entry ID written to memory (same ID used in both stores).
   */
  handleVerdict(input: GateVerdictInput): GatePhaseResult {
    const entryId = randomUUID();
    const now = new Date().toISOString();

    const metadata: GateVerdictMetadata = {
      cycleId: input.cycleId,
      verdict: input.verdict,
      rationale: input.rationale,
      criticalFindings: [...input.criticalFindings],
      majorFindings: [...input.majorFindings],
    };

    const summary = buildSummary(input);

    // Write to the SessionMemoryManager store (in-memory + session-history.json).
    const entry: SessionMemoryEntry = {
      id: entryId,
      sessionId: input.cycleId,
      category: "gate-verdict",
      agentId: "gate-phase",
      summary,
      success: input.verdict === "approved",
      timestamp: now,
      metadata,
    };
    this.memoryWriter.addEntry(entry);

    // Write to the canonical JSONL store (.agentforge/memory/gate-verdict.jsonl)
    // so the verdict is queryable by the /api/v5/memory endpoint and flywheel
    // dashboard. The write is non-fatal — a failure here must never surface to
    // callers (writeMemoryEntry swallows I/O errors internally).
    if (this.projectRoot !== undefined) {
      writeMemoryEntry(this.projectRoot, {
        id: entryId,
        type: "gate-verdict",
        value: summary,
        createdAt: now,
        source: input.cycleId,
        tags: ["gate", input.verdict, `cycle:${input.cycleId}`],
        metadata,
      });
    }

    return { entryId };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a human-readable summary string from a gate verdict input.
 *
 * Kept intentionally dense so it remains useful even in contexts where
 * only the summary string is surfaced (e.g. legacy consumers, plain logs).
 */
function buildSummary(input: GateVerdictInput): string {
  const parts: string[] = [`Gate ${input.verdict}: ${input.rationale}`];

  if (input.criticalFindings.length > 0) {
    parts.push(`Critical: ${input.criticalFindings.join("; ")}`);
  }
  if (input.majorFindings.length > 0) {
    parts.push(`Major: ${input.majorFindings.join("; ")}`);
  }

  return parts.join(". ");
}
