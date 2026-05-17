// packages/core/src/autonomous/self-eval/parser.ts
//
// Extracts a structured self-evaluation grade from the end of an agent's
// response text.  Two formats are accepted:
//
//   Markdown block (preferred):
//     ## Self-eval
//     Score: 4
//     Why: I implemented the function but skipped the edge-case test.
//
//   HTML comment with JSON payload (alternative):
//     <!-- self-eval: {"score": 4, "justification": "..."} -->
//
// Returns null gracefully if no structured block is found.

import type { SelfEvalGrade } from './types.js';

const VALID_SCORES = new Set([1, 2, 3, 4, 5]);

const MAX_JUSTIFICATION_LEN = 160;

/**
 * Parse a self-eval grade from the tail of an agent's response.
 * Tries markdown block format first, then JSON comment form.
 * Returns null if neither format is detected or if validation fails.
 */
export function parseSelfEval(agentResponse: string): SelfEvalGrade | null {
  return parseMarkdownBlock(agentResponse) ?? parseJsonComment(agentResponse);
}

function parseMarkdownBlock(text: string): SelfEvalGrade | null {
  const tail = text.slice(-2000);
  const headerMatch = tail.search(/##\s+self-eval\b/i);
  if (headerMatch === -1) return null;

  const section = tail.slice(headerMatch);

  const scoreMatch = /^\s*score\s*:\s*(\S+)\s*$/im.exec(section);
  if (!scoreMatch) return null;

  const whyMatch = /^\s*why\s*:\s*(.+)$/im.exec(section);
  if (!whyMatch) return null;

  const rawScore = scoreMatch[1] ?? '';
  const rawWhy = (whyMatch[1] ?? '').trim();

  return buildGrade(rawScore, rawWhy);
}

function parseJsonComment(text: string): SelfEvalGrade | null {
  const pattern = /<!--\s*self-eval\s*:\s*(\{[\s\S]*?\})\s*-->/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    lastMatch = m;
  }

  if (!lastMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch[1] ?? '');
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const rawScore = obj['score'];
  const rawJustification = obj['justification'];

  if (rawScore === undefined || rawJustification === undefined) return null;

  return buildGrade(String(rawScore), String(rawJustification).trim());
}

function buildGrade(rawScore: string, justification: string): SelfEvalGrade | null {
  const numScore = Number(rawScore);

  if (!Number.isInteger(numScore) || !VALID_SCORES.has(numScore as 1 | 2 | 3 | 4 | 5)) {
    return null;
  }

  if (!justification || justification.length === 0) return null;

  const finalJustification = justification.length > MAX_JUSTIFICATION_LEN
    ? justification.slice(0, MAX_JUSTIFICATION_LEN)
    : justification;

  return {
    score: numScore as 1 | 2 | 3 | 4 | 5,
    justification: finalJustification,
  };
}
