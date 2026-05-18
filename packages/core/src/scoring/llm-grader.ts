// packages/core/src/scoring/llm-grader.ts
//
// LLM grader stub — returns a fixed quality score of 0.8 with no signals.
// T5 will replace this with the real batched Anthropic-SDK grader.
//
// The interface is intentionally minimal so T5 can swap in any implementation
// that satisfies LlmGraderResult without breaking callers.

import type { Signal } from './rubric-v1.js';

export interface LlmGradeInput {
  agentId: string;
  phase: string;
  raw: string;
  parsed: unknown;
  capabilityTags: string[];
  skillIds: string[];
}

export interface LlmGraderResult {
  quality: number;
  signals: Signal[];
}

/**
 * In-memory batched LLM grader interface.
 *
 * T5 supplies the real implementation. This stub resolves instantly with
 * quality=0.8 and no extra signals.
 */
export interface LlmGrader {
  grade(input: LlmGradeInput): Promise<LlmGraderResult>;
}

export class StubLlmGrader implements LlmGrader {
  async grade(_input: LlmGradeInput): Promise<LlmGraderResult> {
    return { quality: 0.8, signals: [] };
  }
}

// Default exported singleton used by scoreStep() when no grader is injected.
export const defaultLlmGrader: LlmGrader = new StubLlmGrader();
