// packages/core/src/scoring/llm-grader.ts
//
// Batched LLM grader that dispatches to the `scorer-evaluator` agent via the
// existing RuntimeForScoring interface (same adapter shape used by
// ScoringPipeline).
//
// Queue semantics:
//   - Items accumulate in an in-memory queue.
//   - A flush is triggered when the queue reaches 8 items OR the oldest item
//     exceeds 30 s (checked lazily on enqueue).
//   - At most one grader dispatch is issued per cycle phase event (enforced by
//     the `_dispatchInFlight` guard).
//
// CodeQL compliance:
//   - No template-string YAML — all serialisation uses JSON.stringify (the
//     prompt is JSON, not YAML).
//   - No regex on user-controlled strings — uses String.includes() guards.
//   - No `exec` / shell injection vectors.

import type { RuntimeForScoring } from '../autonomous/scoring-pipeline.js';
import type { Signal } from './rubric-v1.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GradeSignal {
  key: string;
  value: number;
  note?: string;
}

export interface GradeResult {
  quality: number;
  signals: GradeSignal[];
}

export interface PendingItem {
  index: number;
  output: string;
  enqueuedAt: number; // Date.now() ms
}

/** Subset of the scorer-evaluator output_schema (step_score_batch_v1). */
interface ScoreBatchOutput {
  scores: Array<{
    index: number;
    quality: number;
    signals: GradeSignal[];
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUEUE_SIZE = 8;
const MAX_AGE_MS = 30_000; // 30 s
const SCORER_AGENT_ID = 'scorer-evaluator';

// ---------------------------------------------------------------------------
// LlmGrader
// ---------------------------------------------------------------------------

export class LlmGrader {
  private readonly queue: PendingItem[] = [];
  private _dispatchInFlight = false;

  constructor(private readonly runtime: RuntimeForScoring) {}

  /**
   * Enqueue one output string for grading.
   *
   * Returns immediately; grades are retrieved via flush().
   * Callers that need results synchronously should call flush() explicitly
   * after enqueue().
   */
  enqueue(index: number, output: string): void {
    this.queue.push({ index, output, enqueuedAt: Date.now() });
  }

  /**
   * Returns true when the queue should be flushed.
   *
   * Triggers:
   *  - 8 or more pending items (MAX_QUEUE_SIZE), OR
   *  - oldest item is >= 30 s old (MAX_AGE_MS).
   */
  shouldFlush(): boolean {
    if (this.queue.length === 0) return false;
    if (this.queue.length >= MAX_QUEUE_SIZE) return true;
    const oldest = this.queue[0];
    if (!oldest) return false;
    return Date.now() - oldest.enqueuedAt >= MAX_AGE_MS;
  }

  /**
   * Flush the current queue to the scorer-evaluator agent.
   *
   * Hard cap: one dispatch per call (enforced by `_dispatchInFlight`).
   * Subsequent flush() calls while a dispatch is running return an empty Map.
   *
   * On parse/validation failure the method returns an empty Map so callers
   * can fall back to static scoring without crashing the cycle.
   */
  async flush(rubric?: string[]): Promise<Map<number, GradeResult>> {
    if (this.queue.length === 0) return new Map();
    if (this._dispatchInFlight) return new Map();

    // Drain the queue atomically — snapshot then clear.
    const batch = this.queue.splice(0, this.queue.length);
    this._dispatchInFlight = true;

    try {
      const prompt = this.buildPrompt(batch, rubric ?? ['correctness', 'completeness', 'safety']);
      const result = await this.runtime.run(SCORER_AGENT_ID, prompt, {
        responseFormat: 'json',
      });
      return this.parseOutput(result.output);
    } catch {
      // Non-throwing: return empty map so the caller can degrade gracefully.
      return new Map();
    } finally {
      this._dispatchInFlight = false;
    }
  }

  /**
   * Convenience: enqueue all outputs, then flush immediately.
   */
  async gradeAll(
    outputs: string[],
    rubric?: string[],
  ): Promise<Map<number, GradeResult>> {
    outputs.forEach((o, i) => this.enqueue(i, o));
    return this.flush(rubric);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildPrompt(batch: PendingItem[], rubric: string[]): string {
    const items = batch.map((item) => ({
      index: item.index,
      output: item.output,
    }));
    // JSON serialisation — never template-string YAML (CodeQL compliance).
    return [
      `Grade these ${batch.length} agent outputs against the rubric: ${rubric.join(', ')}.`,
      '',
      'Batch:',
      JSON.stringify(items, null, 2),
      '',
      'Return ONLY valid JSON matching the step_score_batch_v1 output_schema.',
    ].join('\n');
  }

  private parseOutput(raw: string): Map<number, GradeResult> {
    const parsed = extractJson(raw);
    if (!parsed) return new Map();
    if (!isScoreBatchOutput(parsed)) return new Map();

    const map = new Map<number, GradeResult>();
    for (const entry of parsed.scores) {
      map.set(entry.index, {
        quality: entry.quality,
        signals: entry.signals,
      });
    }
    return map;
  }
}

type StubLlmGraderInput = {
  agentId: string;
  phase: string;
  raw: string;
  parsed: unknown;
  capabilityTags: string[];
  skillIds: string[];
};

type StubLlmGraderFn = (input: StubLlmGraderInput) => Promise<{
  quality: number;
  signals: Signal[];
}>;

interface StubLlmGraderConstructor {
  new(): StubLlmGraderFn;
  (): StubLlmGraderFn;
}

export const StubLlmGrader = function StubLlmGrader(): StubLlmGraderFn {
  return async () => ({
    quality: 0.8,
    signals: [],
  });
} as StubLlmGraderConstructor;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Robust JSON extraction: strips markdown fences then attempts JSON.parse.
 * Returns null on any failure (non-throwing).
 */
function extractJson(raw: string): unknown {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7).trim();
  else if (s.startsWith('```')) s = s.slice(3).trim();
  if (s.endsWith('```')) s = s.slice(0, -3).trim();

  // Walk to find the first balanced { ... } block.
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          s = s.slice(start, i + 1);
          break;
        }
      }
    }
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isScoreBatchOutput(v: unknown): v is ScoreBatchOutput {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.scores)) return false;
  for (const entry of obj.scores) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.index !== 'number') return false;
    if (typeof e.quality !== 'number') return false;
    if (!Array.isArray(e.signals)) return false;
  }
  return true;
}
