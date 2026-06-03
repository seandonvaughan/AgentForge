import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const summarizeModulePath = resolve(
  fileURLToPath(import.meta.url),
  '../../../benchmarks/lib/summarize.mjs'
);

type BenchmarkSummary = {
  runs: number;
  fullySucceededRuns: number;
  mergedPrSuccessRate: number;
  totalMergedPrs: number;
  meanUsd: number;
  totalUsd: number;
  meanTestsPassed: number;
};

const mod = await import(pathToFileURL(summarizeModulePath).href);
const summarizeBenchmarkResults = mod.summarizeBenchmarkResults as (
  results: unknown[]
) => BenchmarkSummary;

describe('summarizeBenchmarkResults', () => {
  it('aggregates exact benchmark totals and means across runs', () => {
    const summary = summarizeBenchmarkResults([
      {
        cycleId: 'run-a',
        tasksAttempted: 1,
        mergedPRs: [{ number: 1, merged: true }],
        testsPassed: 10,
        usd: 3,
        budgetUsd: 20,
        model: 'codex-cli',
        ts: '2026-06-01T12:00:00.000Z',
      },
      {
        cycleId: 'run-b',
        tasksAttempted: 1,
        mergedPRs: [{ number: 2, merged: false }],
        testsPassed: 8,
        usd: 5,
        budgetUsd: 20,
        model: 'codex-cli',
        ts: '2026-06-01T13:00:00.000Z',
      },
      {
        cycleId: 'run-c',
        tasksAttempted: 2,
        mergedPRs: [
          { number: 3, merged: true },
          { number: 4, merged: true },
        ],
        testsPassed: 12,
        usd: 4,
        budgetUsd: 20,
        model: 'codex-cli',
        ts: '2026-06-01T14:00:00.000Z',
      },
    ]);

    expect(summary.runs).toBe(3);
    expect(summary.fullySucceededRuns).toBe(2);
    expect(summary.mergedPrSuccessRate).toBe(2 / 3);
    expect(summary.totalMergedPrs).toBe(3);
    expect(summary.totalUsd).toBe(12);
    expect(summary.meanUsd).toBe(4);
    expect(summary.meanTestsPassed).toBe(10);
  });

  it('returns all-zero aggregates without NaN for empty input', () => {
    const summary = summarizeBenchmarkResults([]);

    expect(summary.runs).toBe(0);
    expect(summary.fullySucceededRuns).toBe(0);
    expect(summary.mergedPrSuccessRate).toBe(0);
    expect(summary.totalMergedPrs).toBe(0);
    expect(summary.totalUsd).toBe(0);
    expect(summary.meanUsd).toBe(0);
    expect(summary.meanTestsPassed).toBe(0);

    expect(Number.isNaN(summary.mergedPrSuccessRate)).toBe(false);
    expect(Number.isNaN(summary.meanUsd)).toBe(false);
    expect(Number.isNaN(summary.meanTestsPassed)).toBe(false);
  });
});
