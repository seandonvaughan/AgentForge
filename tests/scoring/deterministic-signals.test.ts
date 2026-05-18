// tests/scoring/deterministic-signals.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDeterministicSignals, type DeterministicInput } from '../../packages/core/src/scoring/deterministic-signals.js';

function makeValidOutput(overrides: Partial<{
  ok: boolean;
  raw: string;
  parsed: unknown;
  validationError: string;
}> = {}): {
  agentId: string;
  schemaName: string;
  raw: string;
  parsed: unknown;
  ok: boolean;
  validationError?: string;
  capturedAt: string;
} {
  return {
    agentId: 'test-agent',
    schemaName: 'test-schema',
    raw: overrides.raw ?? JSON.stringify({ status: 'done', files_changed: [] }),
    parsed: overrides.parsed ?? { status: 'done', files_changed: [] },
    ok: overrides.ok ?? true,
    validationError: overrides.validationError,
    capturedAt: new Date().toISOString(),
  };
}

function makeInput(
  overrides: Partial<DeterministicInput> = {},
  tmpDir = '',
): DeterministicInput {
  return {
    validatedOutput: makeValidOutput(),
    cycleArtifactsDir: tmpDir || '/tmp/nonexistent-cycle-dir',
    ownsSubsystems: ['packages/core/'],
    capabilityTags: [],
    skillIds: [],
    cycleId: 'test-cycle-001',
    ...overrides,
  };
}

describe('computeDeterministicSignals', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'det-signals-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns exactly 9 signals', () => {
    const signals = computeDeterministicSignals(makeInput({}, tmpDir));
    expect(signals).toHaveLength(9);
  });

  it('schema.valid is 1 when ok=true', () => {
    const signals = computeDeterministicSignals(makeInput({
      validatedOutput: makeValidOutput({ ok: true }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'schema.valid');
    expect(sig?.value).toBe(1);
  });

  it('schema.valid is 0 when ok=false', () => {
    const signals = computeDeterministicSignals(makeInput({
      validatedOutput: makeValidOutput({ ok: false, validationError: 'field missing' }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'schema.valid');
    expect(sig?.value).toBe(0);
  });

  it('output.length_sane is 1 for normal-length output', () => {
    const raw = 'x'.repeat(200);
    const signals = computeDeterministicSignals(makeInput({
      validatedOutput: makeValidOutput({ raw, parsed: { status: 'done' } }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'output.length_sane');
    expect(sig?.value).toBe(1);
  });

  it('output.length_sane is 0 for too-short output', () => {
    const signals = computeDeterministicSignals(makeInput({
      validatedOutput: makeValidOutput({ raw: 'hi', parsed: {} }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'output.length_sane');
    expect(sig?.value).toBe(0);
  });

  it('output.no_placeholder_strings is 0 when TODO present', () => {
    const parsed = { summary: 'TODO: implement this properly' };
    const signals = computeDeterministicSignals(makeInput({
      validatedOutput: makeValidOutput({
        raw: JSON.stringify(parsed),
        parsed,
      }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'output.no_placeholder_strings');
    expect(sig?.value).toBe(0);
  });

  it('output.no_placeholder_strings is 1 when no placeholders', () => {
    const parsed = { summary: 'Implementation complete' };
    const signals = computeDeterministicSignals(makeInput({
      validatedOutput: makeValidOutput({
        raw: JSON.stringify(parsed),
        parsed,
      }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'output.no_placeholder_strings');
    expect(sig?.value).toBe(1);
  });

  it('tdd.red_green_observed is 1 when af-tdd not in skillIds', () => {
    const signals = computeDeterministicSignals(makeInput({
      skillIds: [],
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'tdd.red_green_observed');
    expect(sig?.value).toBe(1);
  });

  it('tdd.red_green_observed is 1 when af-tdd present and markers found', () => {
    const raw = JSON.stringify({ summary: 'Tests were red (FAIL), then green (PASS) after fix' });
    const signals = computeDeterministicSignals(makeInput({
      skillIds: ['af-tdd'],
      validatedOutput: makeValidOutput({ raw, parsed: JSON.parse(raw) }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'tdd.red_green_observed');
    expect(sig?.value).toBe(1);
  });

  it('tdd.red_green_observed is 0 when af-tdd present but no markers', () => {
    const raw = JSON.stringify({ summary: 'Implementation complete without test commentary' });
    const signals = computeDeterministicSignals(makeInput({
      skillIds: ['af-tdd'],
      validatedOutput: makeValidOutput({ raw, parsed: JSON.parse(raw) }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'tdd.red_green_observed');
    expect(sig?.value).toBe(0);
  });

  it('tests.delta_nonneg returns 0.5 when cycle.json missing', () => {
    const signals = computeDeterministicSignals(makeInput({}, tmpDir));
    const sig = signals.find((s) => s.key === 'tests.delta_nonneg');
    expect(sig?.value).toBe(0.5);
  });

  it('tests.delta_nonneg returns 1 when delta is positive', () => {
    const cycleJson = { tests: { passed: 100, previousPassed: 90, delta: 10 } };
    writeFileSync(join(tmpDir, 'cycle.json'), JSON.stringify(cycleJson));
    const signals = computeDeterministicSignals(makeInput({}, tmpDir));
    const sig = signals.find((s) => s.key === 'tests.delta_nonneg');
    expect(sig?.value).toBe(1);
  });

  it('tests.delta_nonneg returns 0 when delta is negative', () => {
    const cycleJson = { tests: { passed: 80, previousPassed: 90, delta: -10 } };
    writeFileSync(join(tmpDir, 'cycle.json'), JSON.stringify(cycleJson));
    const signals = computeDeterministicSignals(makeInput({}, tmpDir));
    const sig = signals.find((s) => s.key === 'tests.delta_nonneg');
    expect(sig?.value).toBe(0);
  });

  it('verify.checks_run is 1 when af-verify-before-done not in skillIds', () => {
    const signals = computeDeterministicSignals(makeInput({ skillIds: [] }, tmpDir));
    const sig = signals.find((s) => s.key === 'verify.checks_run');
    expect(sig?.value).toBe(1);
  });

  it('verify.checks_run is 1 when verification evidence present', () => {
    const raw = JSON.stringify({ summary: 'pnpm test passes: all tests pass' });
    const signals = computeDeterministicSignals(makeInput({
      skillIds: ['af-verify-before-done'],
      validatedOutput: makeValidOutput({ raw, parsed: JSON.parse(raw) }),
    }, tmpDir));
    const sig = signals.find((s) => s.key === 'verify.checks_run');
    expect(sig?.value).toBe(1);
  });

  it('all signals have source deterministic', () => {
    const signals = computeDeterministicSignals(makeInput({}, tmpDir));
    for (const s of signals) {
      expect(s.source).toBe('deterministic');
    }
  });

  it('all signals have non-negative weight', () => {
    const signals = computeDeterministicSignals(makeInput({}, tmpDir));
    for (const s of signals) {
      expect(s.weight).toBeGreaterThanOrEqual(0);
    }
  });
});
