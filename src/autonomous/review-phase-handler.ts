/**
 * ReviewPhaseHandler — Sprint Review Phase Memory Writer
 *
 * Called during the "review" phase of the autonomous sprint cycle.
 * Filters review findings to MAJOR and CRITICAL severity, then writes
 * a MemoryRegistryEntry of category "review-finding" for each.
 *
 * Recurring findings against the same file across cycles surface as
 * persistent anti-patterns when the audit phase reads these entries
 * in the next sprint.
 *
 * Pure side-effecting module — no I/O beyond MemoryRegistry calls.
 */

import type { MemoryRegistry } from "../registry/memory-registry.js";
import type { MemoryRegistryEntry } from "../types/v4-api.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity levels that review tools or agents may assign to a finding. */
export type FindingSeverity = "MINOR" | "MAJOR" | "CRITICAL";

/** A single finding produced during the review phase. */
export interface ReviewFinding {
  /** Severity level. Only MAJOR and CRITICAL are persisted to memory. */
  severity: FindingSeverity;
  /** Source file the finding relates to (relative project path). */
  file: string;
  /** Human-readable description of the issue. */
  message: string;
  /** Agent that produced this finding (e.g. "code-reviewer", "meta-architect"). */
  reviewerAgentId: string;
}

/** Result of a handleFindings call. */
export interface ReviewPhaseResult {
  /** Total findings passed in. */
  totalFindings: number;
  /** Findings that met the MAJOR/CRITICAL threshold. */
  persistedCount: number;
  /** IDs of the memory entries written for this review run. */
  memoryEntryIds: string[];
}

// ---------------------------------------------------------------------------
// ReviewPhaseHandler
// ---------------------------------------------------------------------------

export class ReviewPhaseHandler {
  constructor(private readonly registry: MemoryRegistry) {}

  /**
   * Process a batch of review findings from one sprint review phase.
   *
   * Only MAJOR and CRITICAL findings are written to memory. MINOR findings
   * are acknowledged but not persisted — they are too numerous to be
   * signal-worthy for cross-cycle pattern detection.
   *
   * @param sprintId  - Sprint identifier (used for tags and content path).
   * @param version   - Sprint version string, e.g. "6.8" (used for content path).
   * @param findings  - All findings from the review phase.
   * @returns Summary of what was persisted.
   */
  handleFindings(
    sprintId: string,
    version: string,
    findings: ReviewFinding[],
  ): ReviewPhaseResult {
    const qualifying = findings.filter(isMajorOrCritical);
    const memoryEntryIds: string[] = [];

    for (const finding of qualifying) {
      const entry = this.registry.store(buildMemoryInput(sprintId, version, finding));
      memoryEntryIds.push(entry.id);
    }

    return {
      totalFindings: findings.length,
      persistedCount: qualifying.length,
      memoryEntryIds,
    };
  }

  /**
   * Retrieve all review-finding entries stored so far (across all sprints).
   * Useful for the audit phase to detect recurring patterns.
   */
  getPersistedFindings(): MemoryRegistryEntry[] {
    return this.registry.getByCategory("review-finding");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if a finding's severity warrants persistent memory storage. */
function isMajorOrCritical(finding: ReviewFinding): boolean {
  return finding.severity === "MAJOR" || finding.severity === "CRITICAL";
}

/**
 * Build a MemoryRegistry store input from a qualifying finding.
 *
 * Content path convention: .agentforge/memory/review/{sprintId}/{reviewerAgentId}/{timestamp}.md
 * This ensures findings are grouped by sprint for easy bulk retrieval.
 */
function buildMemoryInput(
  sprintId: string,
  version: string,
  finding: ReviewFinding,
) {
  const timestamp = Date.now();
  // Higher relevance for CRITICAL than MAJOR — decay is intentionally slow
  // (0.005/day) so cross-cycle pattern detection spans multiple sprints.
  const relevanceScore = finding.severity === "CRITICAL" ? 0.95 : 0.85;

  return {
    type: "memory" as const,
    version: "1.0.0",
    ownerAgentId: finding.reviewerAgentId,
    active: true,
    category: "review-finding" as const,
    summary: `[${finding.severity}] ${finding.file}: ${finding.message}`,
    contentPath: `.agentforge/memory/review/${sprintId}/${finding.reviewerAgentId}/${timestamp}.md`,
    relevanceScore,
    decayRatePerDay: 0.005, // slow decay — review findings persist across several cycles
    lastAccessedAt: new Date().toISOString(),
    expiresAt: null,
    tags: [
      "review-finding",
      finding.severity.toLowerCase(),
      finding.file,
      `sprint:${sprintId}`,
      `version:${version}`,
    ],
  };
}
