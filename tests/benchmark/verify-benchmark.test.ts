/**
 * tests/benchmark/verify-benchmark.test.ts
 *
 * Unit tests for the pure verifyBenchmarkResult function.
 *
 * These tests use a MOCK ghCheck so they never hit the real GitHub API.
 * The anti-fake guard: a result claiming a merged PR fails immediately when
 * the mock reports merged=false — a static JSON cannot spoof live merge state.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Dynamic import because the module is plain ESM .mjs (not in tsconfig).
// We use the pathToFileURL helper to obtain a valid file:// URL for the import.
const verifyModulePath = resolve(
  fileURLToPath(import.meta.url),
  '../../../benchmarks/lib/verify.mjs'
);

// Load the module once for all tests.
let verifyBenchmarkResult: (
  result: unknown,
  opts: { ghCheck: (n: number) => Promise<{ merged: boolean }> }
) => Promise<{ ok: boolean; reasons: string[] }>;

// Vitest supports top-level dynamic imports in test files.
const mod = await import(pathToFileURL(verifyModulePath).href);
verifyBenchmarkResult = mod.verifyBenchmarkResult;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<{
  cycleId: string | null;
  usd: number;
  budgetUsd: number;
  ts: string | null;
  mergedPRs: Array<{ number: number; merged: boolean }>;
  testsPassed: number;
  model: string;
  tasksAttempted: number;
}> = {}) {
  return {
    cycleId: 'test-cycle-abc123',
    usd: 5.00,
    budgetUsd: 20,
    ts: '2026-06-01T12:00:00.000Z',
    mergedPRs: [],
    testsPassed: 100,
    model: 'codex-cli',
    tasksAttempted: 3,
    ...overrides,
  };
}

/** ghCheck that always reports merged=true */
const alwaysMerged = async (_n: number) => ({ merged: true });

/** ghCheck that always reports merged=false */
const neverMerged = async (_n: number) => ({ merged: false });

/** ghCheck that always throws (simulates 404 / network error) */
const alwaysThrows = async (n: number): Promise<{ merged: boolean }> => {
  throw new Error(`Not Found (PR #${n})`);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyBenchmarkResult', () => {
  it('passes when all fields are valid, no PRs claimed', async () => {
    const result = makeResult();
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(true);
    expect(outcome.reasons).toHaveLength(0);
  });

  it('passes when a claimed PR returns merged=true from GitHub mock', async () => {
    const result = makeResult({
      mergedPRs: [{ number: 229, merged: true }],
    });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(true);
    expect(outcome.reasons).toHaveLength(0);
  });

  // THE ANTI-FAKE GUARD
  it('FAILS when a claimed merged PR is NOT merged according to the GitHub mock', async () => {
    const result = makeResult({
      mergedPRs: [{ number: 42, merged: true }], // result claims merged
    });
    // but live check disagrees:
    const outcome = await verifyBenchmarkResult(result, { ghCheck: neverMerged });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('#42'))).toBe(true);
  });

  it('FAILS when ghCheck throws for a claimed PR', async () => {
    const result = makeResult({
      mergedPRs: [{ number: 99, merged: true }],
    });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysThrows });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('#99'))).toBe(true);
  });

  it('FAILS when usd exceeds budgetUsd', async () => {
    const result = makeResult({ usd: 25.00, budgetUsd: 20 });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.toLowerCase().includes('budget'))).toBe(true);
  });

  it('passes when usd exactly equals budgetUsd', async () => {
    const result = makeResult({ usd: 20.00, budgetUsd: 20 });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(true);
  });

  it('FAILS when cycleId is null', async () => {
    const result = makeResult({ cycleId: null });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('cycleId'))).toBe(true);
  });

  it('FAILS when cycleId is undefined', async () => {
    const result = makeResult({ cycleId: undefined as unknown as null });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('cycleId'))).toBe(true);
  });

  it('FAILS when ts is null', async () => {
    const result = makeResult({ ts: null });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: alwaysMerged });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('"ts"'))).toBe(true);
  });

  it('accumulates multiple failure reasons', async () => {
    const result = makeResult({
      cycleId: null,
      usd: 99,
      budgetUsd: 20,
      mergedPRs: [{ number: 7, merged: true }],
    });
    const outcome = await verifyBenchmarkResult(result, { ghCheck: neverMerged });
    expect(outcome.ok).toBe(false);
    // Should have: missing cycleId + over budget + PR not merged
    expect(outcome.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('handles multiple PRs where only one fails', async () => {
    // PR 1 → merged, PR 2 → not merged
    const ghCheck = async (n: number) => ({ merged: n === 100 });
    const result = makeResult({
      mergedPRs: [
        { number: 100, merged: true },
        { number: 101, merged: true },
      ],
    });
    const outcome = await verifyBenchmarkResult(result, { ghCheck });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.some((r) => r.includes('#101'))).toBe(true);
    expect(outcome.reasons.some((r) => r.includes('#100'))).toBe(false);
  });
});
