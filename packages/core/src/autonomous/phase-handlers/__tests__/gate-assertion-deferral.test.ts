import { describe, it, expect } from 'vitest';
import { GATE_ASSERTION_DEFERRAL_GUIDANCE } from '../gate-phase.js';

// The gate grades from a diff and cannot execute tests. It must defer the
// correctness of a PRESENT test's assertions to the deterministic VERIFY stage,
// rather than false-rejecting (the bug: a correct `PRAGMA busy_timeout` test was
// rejected because the gate wrongly expected a `busy_timeout` column when SQLite
// returns `timeout`). This guard must NOT relax the iron law.

describe('GATE_ASSERTION_DEFERRAL_GUIDANCE', () => {
  const g = GATE_ASSERTION_DEFERRAL_GUIDANCE.toLowerCase();

  it('instructs the gate NOT to reject on speculation about a present test’s assertions', () => {
    expect(g).toContain('do not reject');
    expect(g).toContain('present test');
    // covers the failure mode dimensions
    expect(g).toMatch(/field, column, value/);
  });

  it('names VERIFY as the sole authority on assertion correctness', () => {
    expect(g).toContain('verify');
    expect(g).toContain('sole authority');
  });

  it('tells the gate to APPROVE (note-not-reject) when it merely suspects an assertion is off', () => {
    expect(g).toContain('approve');
    expect(g).toContain('note it');
  });

  it('preserves the iron law — missing functionality / no test at all / fakes / CRITICAL-MAJOR still REJECT', () => {
    expect(g).toContain('missing functionality');
    expect(g).toContain('no test at all');
    expect(g).toContain('fabricated/no-op');
    expect(g).toContain('critical/major');
    expect(g).toContain('still drive reject');
  });
});
