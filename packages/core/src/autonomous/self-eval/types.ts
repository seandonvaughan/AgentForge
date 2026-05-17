// packages/core/src/autonomous/self-eval/types.ts
//
// Type definitions for per-agent self-evaluation at end of turn.
// Part of Workstream T2.6 — Cycle 2 / v19.0.0 continuous-improvement loop.
// These grades feed into the learning-curator weighting: low self-grades
// carry higher learning weight because the agent itself flagged the work.

/** Numeric score from 1 (very poor) to 5 (excellent). */
export interface SelfEvalGrade {
  /** 1 (very poor) to 5 (excellent). */
  score: 1 | 2 | 3 | 4 | 5;
  /** One sentence (<160 chars) on why this score. */
  justification: string;
}

/** A persisted self-evaluation record linked to a specific sprint item. */
export interface SelfEvalRecord {
  agentId: string;
  cycleId: string;
  sprintItemId: string;
  grade: SelfEvalGrade;
  /** ISO-8601 timestamp of when this record was appended. */
  recordedAt: string;
}
