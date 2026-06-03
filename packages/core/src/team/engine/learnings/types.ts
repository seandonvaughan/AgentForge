/**
 * Shared contract types for the learning-curator pipeline (T2.1).
 *
 * Consumed by scorer, curator, and the downstream reforge mutator (T2.2).
 * Do NOT modify this file without updating all consumers.
 */

export interface ProposedLearning {
  /** Agent that should learn this. */
  agentId: string;
  /** The lesson text (one sentence, imperative voice). */
  lesson: string;
  /** Score 0..1 — used for capping at 12 lessons per agent. */
  score: number;
  /** Source memory entry id (for traceability). */
  sourceId: string;
  /** Severity tier carried from the source (gate verdict / review finding). */
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
  /** Why this agent — 'role-tag' | 'subsystem' | 'recurring-pattern' | 'cross-agent'. */
  rationale: 'role-tag' | 'subsystem' | 'recurring-pattern' | 'cross-agent';
  /** ISO timestamp of the source entry. */
  sourceCreatedAt: string;
  /** Beta(1,1) outcome confidence, present only when attribution data exists. */
  outcomeConfidence?: number;
  /** Number of cycle×item observations for this lesson — present only when attribution data exists. */
  attributedAppearances?: number;
}

export interface CurationInput {
  /** Absolute project root. */
  projectRoot: string;
  /** The current roster of agent ids (from team.yaml). */
  agentIds: string[];
  /** Optional cap on entries scored per source file (default 500 most recent). */
  maxEntriesPerSource?: number;
}

export interface CurationResult {
  /** All proposed learnings, grouped by agent. */
  byAgent: Record<string, ProposedLearning[]>;
  /** Source files scanned + counts (for telemetry). */
  sourcesScanned: Array<{ path: string; entriesRead: number; scored: number }>;
  /** ISO timestamp. */
  generatedAt: string;
}
