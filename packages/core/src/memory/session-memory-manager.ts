// packages/core/src/memory/session-memory-manager.ts
//
// Type stub migrated from root src/memory/session-memory-manager.ts.
// Only the interface is needed here — the full class remains in src/ until
// the memory module is itself migrated into packages/core.

/** A single memory entry from a session. */
export interface SessionMemoryEntry {
  /** Unique identifier. */
  id: string;
  /** Which session produced this entry. */
  sessionId: string;
  /** Category of memory. */
  category: "task-outcome" | "pattern-discovered" | "agent-interaction" | "error-recovery" | "gate-verdict";
  /** Agent that produced or is associated with this entry. */
  agentId: string;
  /** Summary of what happened. */
  summary: string;
  /** Whether the associated task/interaction was successful. */
  success: boolean;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /**
   * Optional structured payload for category-specific data.
   * For "gate-verdict" entries written by GatePhaseHandler this carries
   * { cycleId, verdict, rationale, criticalFindings, majorFindings }.
   */
  metadata?: Record<string, unknown>;
}
