import { describe, expect, it } from 'vitest';
import { extractLearnedFact } from '../learn-phase.js';

const fallback = 'Review the cycle retrospective before planning the next AgentForge cycle.';

describe('extractLearnedFact', () => {
  it('returns the first action keyword line instead of a header', () => {
    const retrospective = [
      '## What went well',
      'Use bounded worktree isolation per agent to prevent branch collisions.',
      '## Cost',
      '$4.20 over budget',
    ].join('\n');

    expect(extractLearnedFact(retrospective)).toBe(
      'Use bounded worktree isolation per agent to prevent branch collisions.',
    );
  });

  it('returns the fallback when every line is a header', () => {
    const retrospective = [
      '## What went well',
      '### Cost',
      '#### Test results',
      '##### Recommendations',
    ].join('\n');

    expect(extractLearnedFact(retrospective)).toBe(fallback);
  });

  it('truncates a first actionable line longer than 360 characters', () => {
    const longAction = `Use ${'bounded deterministic workspace memory '.repeat(12)}`;

    const learnedFact = extractLearnedFact(longAction);

    expect(learnedFact).toHaveLength(360);
    expect(learnedFact.endsWith('...')).toBe(true);
  });

  it('returns the fallback for empty input', () => {
    expect(extractLearnedFact('')).toBe(fallback);
  });
});
