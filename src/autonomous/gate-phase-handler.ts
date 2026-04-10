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
 * Pure side-effecting module — writes one SessionMemoryEntry per call,
 * no I/O beyond the injected memoryWriter.
 */

import { randomUUID } from "node:crypto";
import type { SessionMemoryEntry } from "../memory/session-memory-manager.js";

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
  constructor(private readonly memoryWriter: GateVerdictMemoryWriter) {}

  /**
   * Record a gate verdict as a structured memory entry.
   *
   * Both the human-readable summary and the machine-readable metadata are
   * written so downstream consumers (AuditPhaseHandler) can choose the
   * richest available representation.
   *
   * @param input - Full gate verdict including rationale and findings.
   * @returns The entry ID written to memory.
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

    const entry: SessionMemoryEntry = {
      id: entryId,
      sessionId: input.cycleId,
      category: "gate-verdict",
      agentId: "gate-phase",
      summary: buildSummary(input),
      success: input.verdict === "approved",
      timestamp: now,
      metadata,
    };

    this.memoryWriter.addEntry(entry);
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
