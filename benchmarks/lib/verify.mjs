/**
 * benchmarks/lib/verify.mjs
 *
 * Pure verification logic for benchmark results. No I/O here — all side
 * effects (reading cycle.json, calling gh) live in the runner script.
 *
 * Exported surface:
 *   verifyBenchmarkResult(result, { ghCheck }) → Promise<VerifyOutcome>
 *
 * @typedef {Object} BenchmarkResult
 * @property {string}  cycleId
 * @property {number}  tasksAttempted
 * @property {Array<{number:number, merged:boolean}>} mergedPRs
 * @property {number}  testsPassed
 * @property {number}  usd
 * @property {string}  model
 * @property {number}  budgetUsd
 * @property {string}  ts
 *
 * @typedef {Object} VerifyOutcome
 * @property {boolean}  ok
 * @property {string[]} reasons   — empty when ok is true
 */

/** Required top-level fields in a BenchmarkResult. */
const REQUIRED_FIELDS = ['cycleId', 'usd', 'budgetUsd', 'ts'];

/**
 * Verify a benchmark result record.
 *
 * @param {BenchmarkResult} result
 * @param {{ ghCheck: (prNumber: number) => Promise<{merged:boolean}> }} opts
 * @returns {Promise<VerifyOutcome>}
 */
export async function verifyBenchmarkResult(result, { ghCheck }) {
  const reasons = [];

  // 1. Required fields must be present and non-null.
  for (const field of REQUIRED_FIELDS) {
    if (result[field] === undefined || result[field] === null) {
      reasons.push(`Required field "${field}" is missing or null`);
    }
  }

  // 2. Cost must be within budget.
  if (typeof result.usd === 'number' && typeof result.budgetUsd === 'number') {
    if (result.usd > result.budgetUsd) {
      reasons.push(
        `Cost $${result.usd.toFixed(4)} exceeds budget $${result.budgetUsd.toFixed(2)}`
      );
    }
  }

  // 3. Every claimed merged PR must actually be merged according to GitHub.
  if (Array.isArray(result.mergedPRs) && result.mergedPRs.length > 0) {
    const prChecks = await Promise.allSettled(
      result.mergedPRs.map(async (entry) => {
        const prNumber = typeof entry === 'object' ? entry.number : entry;
        let ghResult;
        try {
          ghResult = await ghCheck(prNumber);
        } catch (err) {
          throw new Error(
            `PR #${prNumber}: gh check threw — ${err.message ?? err}`
          );
        }
        if (!ghResult.merged) {
          throw new Error(`PR #${prNumber}: GitHub reports merged=false`);
        }
      })
    );

    for (const settled of prChecks) {
      if (settled.status === 'rejected') {
        reasons.push(settled.reason?.message ?? String(settled.reason));
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
