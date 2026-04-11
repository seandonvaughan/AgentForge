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
 * Writes to two stores on each qualifying finding:
 * 1. MemoryRegistry (in-memory) — consumed by AuditPhaseHandler within
 *    the same session via getPersistedFindings().
 * 2. JSONL file store (via writeMemoryEntry) — append-only, lock-safe,
 *    consumed by the /api/v5/memory endpoint and the flywheel dashboard.
 *    Only active when projectRoot is supplied to the constructor.
 */

import type { MemoryRegistry } from "../registry/memory-registry.js";
import type { MemoryRegistryEntry } from "../types/v4-api.js";
import {
  writeMemoryEntry,
  type ReviewFindingMetadata,
} from "../../packages/core/src/memory/types.js";

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
  /** Line number within the file where the issue was detected, if known. */
  line?: number;
  /** Human-readable description of the issue (used as the memory entry summary). */
  summary: string;
  /** Suggested fix or remediation for the issue, if available. */
  fixSuggestion?: string;
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
  /**
   * @param registry    - In-memory registry for within-session lookups.
   * @param projectRoot - Absolute path to the project root. When provided,
   *   handleFindings() additionally appends each qualifying finding to
   *   `.agentforge/memory/review-finding.jsonl` via writeMemoryEntry so
   *   findings persist across sessions and are queryable by /api/v5/memory.
   */
  constructor(
    private readonly registry: MemoryRegistry,
    private readonly projectRoot?: string,
  ) {}

  /**
   * Process a batch of review findings from one sprint review phase.
   *
   * Only MAJOR and CRITICAL findings are written to memory. MINOR findings
   * are acknowledged but not persisted — they are too numerous to be
   * signal-worthy for cross-cycle pattern detection.
   *
   * When projectRoot is set, each qualifying finding is also appended to the
   * canonical JSONL store at `.agentforge/memory/review-finding.jsonl`. The
   * same entry ID is used for both stores so callers can correlate them.
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
      const now = new Date().toISOString();

      // Write to the in-memory registry. The registry generates the entry ID.
      const entry = this.registry.store(buildMemoryInput(sprintId, version, finding, now));
      memoryEntryIds.push(entry.id);

      // Persist to the JSONL store so findings survive process restarts and
      // are visible to the /api/v5/memory endpoint and the flywheel dashboard.
      // Uses the same entry.id so both stores are correlatable by ID.
      // The write is non-fatal — writeMemoryEntry swallows I/O errors.
      if (this.projectRoot !== undefined) {
        const metadata: ReviewFindingMetadata = {
          file: finding.file,
          line: finding.line ?? null,
          severity: finding.severity as "CRITICAL" | "MAJOR",
          summary: finding.summary,
          fixSuggestion: finding.fixSuggestion ?? null,
        };

        const locationPart = finding.line != null
          ? `${finding.file}:${finding.line}`
          : finding.file;

        writeMemoryEntry(this.projectRoot, {
          id: entry.id,
          type: "review-finding",
          value: `[${finding.severity}] ${locationPart}: ${finding.summary}`,
          createdAt: now,
          source: sprintId,
          tags: buildTags(sprintId, version, finding),
          metadata,
        });
      }
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
 * Build the shared tag array for both the registry entry and the JSONL row.
 * Extracted so both stores use an identical tag set for consistent filtering.
 */
function buildTags(sprintId: string, version: string, finding: ReviewFinding): string[] {
  const tags = [
    "review-finding",
    finding.severity.toLowerCase(),
    finding.file,
    `sprint:${sprintId}`,
    `version:${version}`,
  ];
  // Tag with line number so the execute-phase injector can filter by exact location.
  if (finding.line != null) {
    tags.push(`line:${finding.line}`);
  }
  return tags;
}

/**
 * Build a MemoryRegistry store input from a qualifying finding.
 *
 * Content path convention: .agentforge/memory/review/{sprintId}/{reviewerAgentId}/{now}.md
 * This ensures findings are grouped by sprint for easy bulk retrieval.
 *
 * The `metadata` field carries the full structured payload so the execute-phase
 * injector (rank 6) can surface {file, line, severity, summary, fixSuggestion}
 * without parsing the summary string.
 *
 * @param now - ISO-8601 timestamp used for contentPath and lastAccessedAt.
 */
function buildMemoryInput(
  sprintId: string,
  version: string,
  finding: ReviewFinding,
  now: string,
) {
  // Higher relevance for CRITICAL than MAJOR — decay is intentionally slow
  // (0.005/day) so cross-cycle pattern detection spans multiple sprints.
  const relevanceScore = finding.severity === "CRITICAL" ? 0.95 : 0.85;

  // Build a human-readable summary that includes line when present.
  const locationPart = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
  const summaryText = `[${finding.severity}] ${locationPart}: ${finding.summary}`;

  return {
    type: "memory" as const,
    version: "1.0.0",
    ownerAgentId: finding.reviewerAgentId,
    active: true,
    category: "review-finding" as const,
    summary: summaryText,
    contentPath: `.agentforge/memory/review/${sprintId}/${finding.reviewerAgentId}/${now}.md`,
    relevanceScore,
    decayRatePerDay: 0.005, // slow decay — review findings persist across several cycles
    lastAccessedAt: now,
    expiresAt: null,
    tags: buildTags(sprintId, version, finding),
    // Structured payload for downstream consumers (execute-phase injector, audit phase).
    metadata: {
      file: finding.file,
      line: finding.line ?? null,
      severity: finding.severity,
      summary: finding.summary,
      fixSuggestion: finding.fixSuggestion ?? null,
    },
  };
}
