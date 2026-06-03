/**
 * benchmarks/lib/summarize.mjs
 *
 * Pure aggregation logic for benchmark result records. No I/O here.
 *
 * @typedef {Object} BenchmarkResult
 * @property {Array<{number:number, merged:boolean}>} mergedPRs
 * @property {number} testsPassed
 * @property {number} usd
 *
 * @typedef {Object} BenchmarkSummary
 * @property {number} runs
 * @property {number} fullySucceededRuns
 * @property {number} mergedPrSuccessRate
 * @property {number} totalMergedPrs
 * @property {number} meanUsd
 * @property {number} totalUsd
 * @property {number} meanTestsPassed
 */

/**
 * Summarize benchmark results across runs.
 *
 * @param {BenchmarkResult[]} results
 * @returns {BenchmarkSummary}
 */
export function summarizeBenchmarkResults(results) {
  const runs = Array.isArray(results) ? results.length : 0;

  if (runs === 0) {
    return {
      runs: 0,
      fullySucceededRuns: 0,
      mergedPrSuccessRate: 0,
      totalMergedPrs: 0,
      meanUsd: 0,
      totalUsd: 0,
      meanTestsPassed: 0,
    };
  }

  let fullySucceededRuns = 0;
  let totalMergedPrs = 0;
  let totalUsd = 0;
  let totalTestsPassed = 0;

  for (const result of results) {
    const mergedPRs = Array.isArray(result?.mergedPRs) ? result.mergedPRs : [];
    const mergedCount = mergedPRs.filter((entry) => entry?.merged === true).length;

    if (mergedPRs.length > 0 && mergedCount === mergedPRs.length) {
      fullySucceededRuns += 1;
    }

    totalMergedPrs += mergedCount;
    totalUsd += typeof result?.usd === 'number' ? result.usd : 0;
    totalTestsPassed += typeof result?.testsPassed === 'number' ? result.testsPassed : 0;
  }

  return {
    runs,
    fullySucceededRuns,
    mergedPrSuccessRate: fullySucceededRuns / runs,
    totalMergedPrs,
    meanUsd: totalUsd / runs,
    totalUsd,
    meanTestsPassed: totalTestsPassed / runs,
  };
}
