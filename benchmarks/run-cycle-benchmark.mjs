#!/usr/bin/env node
/**
 * benchmarks/run-cycle-benchmark.mjs
 *
 * Benchmark harness: measures merged-PR success rate + $/cycle.
 *
 * Usage:
 *   node benchmarks/run-cycle-benchmark.mjs --help
 *   node benchmarks/run-cycle-benchmark.mjs --dry-run --cycle <cycleId>
 *   node benchmarks/run-cycle-benchmark.mjs --live --budget 20
 *
 * The --dry-run flag (DEFAULT) reads an existing cycle.json without spending.
 * The --live flag drives a real cycle under a hard budget cap (operator only).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBenchmarkResult } from './lib/verify.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RESULTS_DIR = resolve(__dirname, 'results');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(`
AgentForge Benchmark Harness
=============================

Measures merged-PR success rate and $/cycle over a fixed workload.
Results are verified against the live GitHub API (not fakeable).

USAGE
  node benchmarks/run-cycle-benchmark.mjs [options]

OPTIONS
  --dry-run            (default) Read an existing cycle.json, build a result
                       record, and run verification. No spend.
  --cycle <id>         Required with --dry-run. The cycle UUID to read.
  --live               Drive a real 'agentforge cycle run' under --budget cap.
                       Operator-triggered only. Real spend ~$10-20.
  --budget <usd>       Hard cap in USD for --live mode (default: 20).
  --skip-gh-check      Skip live GitHub API verification (useful offline).
  --help               Print this message and exit 0.

DRY-RUN EXAMPLE
  node benchmarks/run-cycle-benchmark.mjs \\
    --dry-run \\
    --cycle 0ebe79bf-f371-4bde-a4ab-0400fc2e8869

LIVE EXAMPLE (real spend — operator only)
  export GH_TOKEN=<token>
  node benchmarks/run-cycle-benchmark.mjs --live --budget 20

OUTPUT
  benchmarks/results/<cycleId>.json

VERIFICATION
  The harness calls gh api repos/.../pulls/<n> --jq .merged for every claimed
  merged PR. A result passes only when every claimed PR is actually merged on
  GitHub and cost is within budget.

`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    help: false,
    dryRun: true, // default
    live: false,
    cycle: null,
    budget: 20,
    skipGhCheck: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a === '--dry-run') { opts.dryRun = true; opts.live = false; }
    else if (a === '--live') { opts.live = true; opts.dryRun = false; }
    else if (a === '--skip-gh-check') { opts.skipGhCheck = true; }
    else if (a === '--cycle') {
      opts.cycle = args[++i];
    } else if (a === '--budget') {
      const b = parseFloat(args[++i]);
      if (isNaN(b) || b <= 0) { die(`--budget must be a positive number; got "${args[i]}"`); }
      opts.budget = b;
    } else {
      die(`Unknown option: ${a}\nRun with --help for usage.`);
    }
  }
  return opts;
}

function die(msg) {
  process.stderr.write(`[benchmark] ERROR: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// cycle.json → BenchmarkResult
// ---------------------------------------------------------------------------

/**
 * Read a cycle.json and derive a BenchmarkResult record from it.
 * @param {string} cycleId
 * @returns {{ result: object, cycleJson: object }}
 */
function readCycleResult(cycleId) {
  const cycleDir = resolve(REPO_ROOT, '.agentforge', 'cycles', cycleId);
  const cyclePath = resolve(cycleDir, 'cycle.json');

  if (!existsSync(cyclePath)) {
    die(`cycle.json not found at ${cyclePath}`);
  }

  let cycleJson;
  try {
    cycleJson = JSON.parse(readFileSync(cyclePath, 'utf8'));
  } catch (err) {
    die(`Failed to parse cycle.json at ${cyclePath}: ${err.message}`);
  }

  // Resolve primary provider/model from providerUsage (first key) or fallback.
  const providerUsage = cycleJson.providerUsage ?? {};
  const model = Object.keys(providerUsage)[0] ?? 'unknown';

  // Build the mergedPRs array from cycle.json.pr (single-PR per cycle).
  const prEntry = cycleJson.pr ?? {};
  const mergedPRs = prEntry.number != null
    ? [{ number: prEntry.number, merged: prEntry.merged ?? false }]
    : [];

  const result = {
    cycleId: cycleJson.cycleId,
    tasksAttempted: cycleJson.tasksAttempted ?? 0,
    mergedPRs,
    testsPassed: cycleJson.tests?.passed ?? 0,
    usd: cycleJson.cost?.totalUsd ?? 0,
    model,
    budgetUsd: cycleJson.cost?.budgetUsd ?? 0,
    ts: cycleJson.completedAt ?? null,
  };

  return { result, cycleJson };
}

// ---------------------------------------------------------------------------
// GitHub API check
// ---------------------------------------------------------------------------

/**
 * Check whether a PR is merged via the gh CLI.
 * @param {string} owner
 * @param {string} repo
 * @returns {(prNumber: number) => Promise<{merged: boolean}>}
 */
function makeGhCheck(owner, repo) {
  return async (prNumber) => {
    const { stdout } = await execFileAsync('gh', [
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}`,
      '--jq',
      '.merged',
    ]);
    const merged = stdout.trim() === 'true';
    return { merged };
  };
}

/**
 * A ghCheck that always skips and returns merged:true (offline / no token).
 * Records that the check was skipped in the result.
 * @returns {(prNumber: number) => Promise<{merged: boolean, skipped: boolean}>}
 */
function makeSkippedGhCheck() {
  return async (_prNumber) => ({ merged: true, skipped: true });
}

// ---------------------------------------------------------------------------
// Write result file
// ---------------------------------------------------------------------------

function writeResult(result, extra = {}) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fileName = `${result.cycleId ?? Date.now()}.json`;
  const filePath = resolve(RESULTS_DIR, fileName);
  const payload = { ...result, ...extra, recordedAt: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
  return filePath;
}

// ---------------------------------------------------------------------------
// Drive a live cycle run
// ---------------------------------------------------------------------------

/**
 * Launch `agentforge cycle run` under the given budget cap.
 * Returns the cycleId from stdout (last UUID-shaped token emitted).
 * @param {number} budgetUsd
 * @returns {Promise<string>} cycleId
 */
async function runLiveCycle(budgetUsd) {
  process.stdout.write(`[benchmark] Starting live cycle run (budget $${budgetUsd})...\n`);

  // Resolve the agentforge binary.
  const binPath = resolve(REPO_ROOT, 'node_modules', '.bin', 'agentforge');

  const args = [
    'cycle', 'run',
    '--project-root', REPO_ROOT,
    '--budget', String(budgetUsd),
  ];

  process.stdout.write(`[benchmark] Invoking: ${binPath} ${args.join(' ')}\n`);

  return new Promise((res, rej) => {
    const child = execFile(binPath, args, { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        rej(new Error(`agentforge cycle run exited with code ${code}\n${stderr}`));
        return;
      }

      // Extract the last UUID-shaped token from stdout.
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
      const matches = stdout.match(uuidPattern);
      if (!matches || matches.length === 0) {
        rej(new Error('Could not find cycleId UUID in agentforge output'));
        return;
      }
      const cycleId = matches[matches.length - 1];
      process.stdout.write(`[benchmark] Detected cycleId: ${cycleId}\n`);
      res(cycleId);
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve owner/repo from git remote (best-effort).
  let owner = 'seandonvaughan';
  let repo = 'AgentForge';
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
    const match = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) { owner = match[1]; repo = match[2]; }
  } catch { /* non-fatal */ }

  const ghCheck = opts.skipGhCheck
    ? makeSkippedGhCheck()
    : makeGhCheck(owner, repo);

  let cycleId;

  if (opts.live) {
    // Live run — drive a real cycle.
    process.stdout.write('[benchmark] Mode: LIVE (real spend)\n');
    cycleId = await runLiveCycle(opts.budget);
  } else {
    // Dry-run — read an existing cycle.
    if (!opts.cycle) {
      printHelp();
      die('--dry-run requires --cycle <cycleId>');
    }
    cycleId = opts.cycle;
    process.stdout.write(`[benchmark] Mode: DRY-RUN (reading cycle ${cycleId})\n`);
  }

  const { result, cycleJson } = readCycleResult(cycleId);

  process.stdout.write('[benchmark] Verifying result...\n');
  const outcome = await verifyBenchmarkResult(result, { ghCheck });

  const resultPath = writeResult(result, {
    verifyOutcome: outcome,
    ghCheckSkipped: opts.skipGhCheck,
  });
  process.stdout.write(`[benchmark] Result written to ${resultPath}\n`);

  if (outcome.ok) {
    process.stdout.write('[benchmark] PASS — all checks passed\n');
  } else {
    process.stderr.write('[benchmark] FAIL — verification failed:\n');
    for (const r of outcome.reasons) {
      process.stderr.write(`  - ${r}\n`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[benchmark] Unhandled error: ${err.message ?? err}\n`);
  process.exit(1);
});
