// packages/core/src/autonomous/self-eval/__tests__/parser.test.ts
//
// Tests for parseSelfEval() — markdown block and JSON comment variants.

import { describe, expect, it } from 'vitest';
import { parseSelfEval } from '../parser.js';

describe('parseSelfEval — markdown block', () => {
  it('parses a well-formed markdown block at the end of a response', () => {
    const response = `
I implemented the feature and wrote unit tests.

## Self-eval
Score: 4
Why: I implemented the function but skipped the edge-case test for empty input.
`;
    const result = parseSelfEval(response);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(4);
    expect(result?.justification).toBe('I implemented the function but skipped the edge-case test for empty input.');
  });

  it('accepts score 5 (excellent) with a full justification', () => {
    const response = `
All tests pass.

## Self-eval
Score: 5
Why: Hit every acceptance criterion, tests pass, no shortcuts taken.
`;
    const result = parseSelfEval(response);
    expect(result?.score).toBe(5);
  });

  it('accepts score 1 (stuck) with a blocker description', () => {
    const response = `
## Self-eval
Score: 1
Why: Could not locate the database adapter — missing import path blocked progress.
`;
    const result = parseSelfEval(response);
    expect(result?.score).toBe(1);
  });

  it('is case-insensitive on the ## Self-eval header', () => {
    const response = `## SELF-EVAL\nScore: 3\nWhy: Partial implementation delivered.\n`;
    const result = parseSelfEval(response);
    expect(result?.score).toBe(3);
  });

  it('trims extra whitespace around the section', () => {
    const response = `
##  Self-eval  
  Score:   2  
  Why:   Partial work needs rework before merge.   
`;
    const result = parseSelfEval(response);
    expect(result?.score).toBe(2);
    expect(result?.justification).toBe('Partial work needs rework before merge.');
  });
});

describe('parseSelfEval — JSON comment form', () => {
  it('parses a well-formed JSON comment', () => {
    const response = `
Some work done here.

<!-- self-eval: {"score": 4, "justification": "Completed main path but skipped one test."} -->
`;
    const result = parseSelfEval(response);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(4);
    expect(result?.justification).toBe('Completed main path but skipped one test.');
  });

  it('uses the LAST JSON comment when multiple are present', () => {
    const response = `
<!-- self-eval: {"score": 2, "justification": "Earlier estimate."} -->
Some more work.
<!-- self-eval: {"score": 5, "justification": "Actually finished everything."} -->
`;
    const result = parseSelfEval(response);
    expect(result?.score).toBe(5);
  });

  it('handles JSON comment with extra whitespace around the payload', () => {
    const response = `<!--   self-eval :   {"score": 3, "justification": "Mostly done."}   -->`;
    const result = parseSelfEval(response);
    expect(result?.score).toBe(3);
  });
});

describe('parseSelfEval — missing / malformed input', () => {
  it('returns null when no self-eval block is present', () => {
    const response = 'I did some work. Here are the results.';
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseSelfEval('')).toBeNull();
  });

  it('returns null when Score is missing from the markdown block', () => {
    const response = `## Self-eval\nWhy: Did the work.\n`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null when Why is missing from the markdown block', () => {
    const response = `## Self-eval\nScore: 4\n`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null when score is out of range (0)', () => {
    const response = `## Self-eval\nScore: 0\nWhy: Below minimum.\n`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null when score is out of range (6)', () => {
    const response = `## Self-eval\nScore: 6\nWhy: Above maximum.\n`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null when score is a float (non-integer)', () => {
    const response = `## Self-eval\nScore: 3.5\nWhy: Half-done.\n`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null when score is a non-numeric string', () => {
    const response = `## Self-eval\nScore: great\nWhy: Looks good.\n`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('returns null for malformed JSON in the comment form', () => {
    const response = `<!-- self-eval: {score: 4, justification: "missing quotes"} -->`;
    expect(parseSelfEval(response)).toBeNull();
  });

  it('truncates justification longer than 160 chars rather than rejecting', () => {
    const longWhy = 'A'.repeat(200);
    const response = `## Self-eval\nScore: 3\nWhy: ${longWhy}\n`;
    const result = parseSelfEval(response);
    expect(result).not.toBeNull();
    expect(result?.justification.length).toBe(160);
  });
});
