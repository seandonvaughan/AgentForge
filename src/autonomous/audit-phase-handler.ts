/**
 * AuditPhaseHandler — Sprint Audit Phase Memory Reader
 *
 * Called at the start of each sprint's "audit" phase. Reads the last N
 * gate-verdict entries (from SessionMemoryManager) and the last N
 * review-finding entries (from MemoryRegistry via ReviewPhaseHandler),
 * then formats them as a "Past mistakes to avoid" section for prompt injection.
 *
 * This closes the learning loop: ReviewPhaseHandler writes; AuditPhaseHandler reads.
 * Without this reader, cross-cycle memory is written but never acted upon.
 *
 * Pure projection — no writes, no side effects beyond the MemoryRegistry
 * access-timestamp update on each entry read.
 */

import type { MemoryRegistryEntry } from "../types/v4-api.js";
import type { SessionMemoryEntry } from "../memory/session-memory-manager.js";
import type { ReviewPhaseHandler } from "./review-phase-handler.js";
import type { GateVerdictMetadata } from "./gate-phase-handler.js";

// ---------------------------------------------------------------------------
// Dependencies (read-only interfaces to avoid tight coupling)
// ---------------------------------------------------------------------------

/** Minimal interface for reading gate-verdict entries. */
export interface GateVerdictReader {
  getEntriesByCategory(category: "gate-verdict"): SessionMemoryEntry[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A normalised past mistake entry suitable for prompt injection. */
export interface PastMistake {
  /** Source of the mistake: review-finding or gate-verdict. */
  source: "review-finding" | "gate-verdict";
  /** Human-readable description of what went wrong or caused rejection. */
  description: string;
  /** Whether the original event was a failure (false = partial success e.g. MAJOR finding). */
  wasFailure: boolean;
  /** ISO-8601 timestamp of when it was recorded. */
  timestamp: string;
}

/** Output of buildPastMistakesSection. */
export interface AuditPromptInjection {
  /** The formatted Markdown section to prepend to the audit prompt. */
  section: string;
  /** Number of review-finding entries consumed. */
  reviewFindingCount: number;
  /** Number of gate-verdict entries consumed. */
  gateVerdictCount: number;
  /** Total entries combined. */
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of recent cycles to surface in the injected section. */
const DEFAULT_ENTRY_LIMIT = 10;

// ---------------------------------------------------------------------------
// AuditPhaseHandler
// ---------------------------------------------------------------------------

export class AuditPhaseHandler {
  constructor(
    private readonly reviewHandler: ReviewPhaseHandler,
    private readonly memoryManager: GateVerdictReader,
  ) {}

  /**
   * Retrieve up to `limit` past mistakes from both memory sources.
   *
   * Gate-verdict entries are sorted newest-first; review-finding entries
   * are sorted by descending relevanceScore so the most severe/recent
   * findings rank highest.
   *
   * @param limit - Maximum number of entries to return (default: 10).
   */
  getPastMistakes(limit = DEFAULT_ENTRY_LIMIT): PastMistake[] {
    const reviewFindings = this.collectReviewFindings(limit);
    const gateVerdicts = this.collectGateVerdicts(limit);

    // Merge and de-duplicate by description; newest-first, findings before verdicts
    const all = [...reviewFindings, ...gateVerdicts];

    // Trim to the overall limit so callers receive at most `limit` items total
    return all.slice(0, limit);
  }

  /**
   * Build a Markdown "Past mistakes to avoid" section ready for prompt injection.
   *
   * Returns an empty section when no memory entries exist so the caller can
   * safely prepend the result without checking for null.
   *
   * @param limit - Maximum number of entries to surface (default: 10).
   */
  buildPastMistakesSection(limit = DEFAULT_ENTRY_LIMIT): AuditPromptInjection {
    const reviewFindings = this.collectReviewFindings(limit);
    const gateVerdicts = this.collectGateVerdicts(limit);

    // Merge: review findings first (most actionable), then gate verdicts
    const combined = [...reviewFindings, ...gateVerdicts].slice(0, limit);

    if (combined.length === 0) {
      return {
        section: "",
        reviewFindingCount: 0,
        gateVerdictCount: 0,
        totalCount: 0,
      };
    }

    const lines: string[] = [
      "## Past mistakes to avoid",
      "",
      "The following issues were flagged in recent sprint cycles.",
      "Treat each as a hard constraint during this audit — do not repeat them.",
      "",
    ];

    for (const mistake of combined) {
      const label = mistake.source === "review-finding" ? "REVIEW" : "GATE";
      const status = mistake.wasFailure ? "REJECTED" : "FINDING";
      lines.push(`- **[${label}/${status}]** ${mistake.description}`);
    }

    lines.push("");

    return {
      section: lines.join("\n"),
      reviewFindingCount: reviewFindings.length,
      gateVerdictCount: gateVerdicts.length,
      totalCount: combined.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read up to `limit` review-finding entries, ordered by descending relevance.
   * CRITICAL findings (relevanceScore 0.95) naturally float above MAJOR (0.85).
   */
  private collectReviewFindings(limit: number): PastMistake[] {
    const entries: MemoryRegistryEntry[] = this.reviewHandler
      .getPersistedFindings()
      .slice() // avoid mutating the registry's copy
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    return entries.map(
      (e): PastMistake => ({
        source: "review-finding",
        description: e.summary,
        wasFailure: e.summary.startsWith("[CRITICAL]"),
        timestamp: e.createdAt,
      }),
    );
  }

  /**
   * Read up to `limit` gate-verdict entries, ordered newest-first.
   * Only rejected verdicts are surfaced — approved gates don't represent mistakes.
   *
   * When an entry was written by GatePhaseHandler it carries structured
   * metadata (rationale, criticalFindings, majorFindings). That richer
   * content is used as the description; older entries without metadata fall
   * back to the plain summary string.
   */
  private collectGateVerdicts(limit: number): PastMistake[] {
    const entries: SessionMemoryEntry[] = this.memoryManager
      .getEntriesByCategory("gate-verdict")
      .slice()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .filter((e) => !e.success) // only surface failures (rejected gates)
      .slice(0, limit);

    return entries.map(
      (e): PastMistake => ({
        source: "gate-verdict",
        description: buildGateVerdictDescription(e),
        wasFailure: true,
        timestamp: e.timestamp,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Build a description string for a gate-verdict memory entry.
 *
 * Prefers the structured metadata written by GatePhaseHandler so that the
 * audit prompt receives rationale + granular findings rather than just a
 * terse summary line. Falls back to entry.summary for entries written by
 * the older AutonomousSprintFramework.recordResult() path.
 */
function buildGateVerdictDescription(entry: SessionMemoryEntry): string {
  const meta = entry.metadata as GateVerdictMetadata | undefined;

  if (!meta?.rationale) {
    // Legacy entry — use the plain summary string
    return entry.summary;
  }

  const parts: string[] = [meta.rationale];

  if (meta.criticalFindings.length > 0) {
    parts.push(`Critical findings: ${meta.criticalFindings.join("; ")}`);
  }
  if (meta.majorFindings.length > 0) {
    parts.push(`Major findings: ${meta.majorFindings.join("; ")}`);
  }

  return parts.join(". ");
}
