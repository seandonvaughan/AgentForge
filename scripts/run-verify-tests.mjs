#!/usr/bin/env node
/**
 * run-verify-tests.mjs — the autonomous-cycle VERIFY gate.
 *
 * Reads `.agentforge/autonomous.yaml` (the `testing` block), derives the changed
 * files via git, plans the run with verify-test-planner.mjs (memory-adaptive
 * workers + affected/full gate mode), spawns vitest with a per-fork heap cap
 * (no shell), retries ONCE at half workers on an OOM signature, writes a summary
 * sidecar, and propagates vitest's exit code.
 *
 * Exit codes: vitest's status (0 = gate passed). Non-zero fails the cycle gate.
 *
 * NOTE: never pass --minWorkers — vitest 4.x rejects it with a fatal CACError.
 * buildVitestArgs() in the planner enforces this.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { freemem, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';
import yaml from 'js-yaml';
import {
  resolveVerifyConfig,
  computeWorkers,
  selectGateMode,
  buildVitestArgs,
  isOomExit,
  nextWorkersOnOom,
} from './verify-test-planner.mjs';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const DEFAULT_MIN_WORKERS = 2;
const BYTES_PER_GB = 1e9;

function loadAutonomousYaml() {
  try {
    const parsed = yaml.load(readFileSync(join(ROOT, '.agentforge', 'autonomous.yaml'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the changed files for affected-test selection. The cycle already
 * tracks an authoritative diff; prefer it (AGENTFORGE_CHANGED_FILES, newline- or
 * comma-separated) and fall back to a local `git diff` against the base branch.
 */
function getChangedFiles(baseBranch) {
  const fromEnv = process.env.AGENTFORGE_CHANGED_FILES;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // unknown diff → planner treats as a full gate (safe)
  }
}

function resolveVitestBin() {
  const pkgJson = require.resolve('vitest/package.json');
  return join(dirname(pkgJson), 'vitest.mjs');
}

function parsePositiveNumber(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInteger(value) {
  const parsed = parsePositiveNumber(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function resolveAvailableMemoryGb({
  env = process.env,
  readMeminfo = readFileSync,
  fallbackFreeBytes = freemem(),
} = {}) {
  const overrideGb = parsePositiveNumber(env.AGENTFORGE_VERIFY_AVAILABLE_GB);
  if (overrideGb !== null) return { availableGb: overrideGb, availableSource: 'env' };

  try {
    const meminfo = readMeminfo('/proc/meminfo', 'utf8');
    const line = meminfo
      .split('\n')
      .find((entry) => entry.startsWith('MemAvailable:'));
    if (line) {
      const [, rawKb] = line.trim().split(/\s+/);
      const availableKb = Number.parseInt(rawKb ?? '', 10);
      if (Number.isFinite(availableKb) && availableKb > 0) {
        return { availableGb: (availableKb * 1024) / BYTES_PER_GB, availableSource: 'meminfo' };
      }
    }
  } catch {
    // Non-Linux hosts do not expose /proc/meminfo; fall back to node:os.
  }

  return { availableGb: fallbackFreeBytes / BYTES_PER_GB, availableSource: 'os.freemem' };
}

export function resolveMinWorkers(env = process.env) {
  const override = parsePositiveInteger(env.AGENTFORGE_VERIFY_MIN_WORKERS);
  return Math.max(DEFAULT_MIN_WORKERS, override ?? DEFAULT_MIN_WORKERS);
}

export function resolveWorkerSizing({
  cfg,
  env = process.env,
  readMeminfo = readFileSync,
  fallbackFreeBytes = freemem(),
  cores = cpus().length,
}) {
  const memory = resolveAvailableMemoryGb({ env, readMeminfo, fallbackFreeBytes });
  const minWorkers = resolveMinWorkers(env);
  const plannedWorkers = computeWorkers(memory.availableGb, cores, {
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
  });
  return {
    ...memory,
    cores,
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
    minWorkers,
    workers: Math.max(minWorkers, plannedWorkers),
  };
}

export function formatWorkerSizingLogFields(sizing) {
  return `availableGb=${sizing.availableGb.toFixed(1)} availableSource=${sizing.availableSource} cores=${sizing.cores} reserveGb=${sizing.reserveGb} perWorkerGb=${sizing.perWorkerGb} minWorkers=${sizing.minWorkers}`;
}

function runVitest(args, heapCapMb) {
  const heapFlag = `--max-old-space-size=${heapCapMb}`;
  const env = { ...process.env };
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${heapFlag}` : heapFlag;
  const res = spawnSync(process.execPath, [resolveVitestBin(), ...args], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  return { code: res.status, signal: res.signal };
}

function main() {
  const conf = loadAutonomousYaml();
  const cfg = resolveVerifyConfig(conf.testing);
  const baseBranch = conf.git && typeof conf.git.baseBranch === 'string' ? conf.git.baseBranch : 'main';

  const changedFiles = getChangedFiles(baseBranch);
  const cycleIndexRaw = Number.parseInt(process.env.AGENTFORGE_CYCLE_INDEX ?? '', 10);
  const cycleIndex = Number.isInteger(cycleIndexRaw) && cycleIndexRaw >= 0 ? cycleIndexRaw : 0;

  const mode = selectGateMode({
    changedFiles,
    coreGlobs: cfg.coreGlobs,
    cycleIndex,
    deepGateEveryNCycles: cfg.deepGateEveryNCycles,
    affectedMode: cfg.affectedMode,
  });

  const sizing = resolveWorkerSizing({ cfg });
  let workers = sizing.workers;

  // Forward any args appended by the caller (e.g. RealTestRunner appends
  // `-- --reporter=json --outputFile <path>` so it can parse the report). Strip
  // the bare `--` separator — vitest's CAC parser treats it as end-of-options
  // and would mis-read the following flags as positional file filters.
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--');

  console.error(
    `[verify-gate] mode=${mode} workers=${workers} changedFiles=${changedFiles.length} ${formatWorkerSizingLogFields(sizing)} passthrough=${passthroughArgs.length}`,
  );

  let { code, signal } = runVitest(
    [...buildVitestArgs({ mode, changedFiles, workers }), ...passthroughArgs],
    cfg.heapCapMb,
  );
  let oomRetryCount = 0;

  if (isOomExit(code, signal) && workers > 1) {
    oomRetryCount = 1;
    workers = nextWorkersOnOom(workers);
    console.error(`[verify-gate] OOM (code=${code} signal=${signal}); retrying once at workers=${workers}`);
    ({ code, signal } = runVitest(
      [...buildVitestArgs({ mode, changedFiles, workers }), ...passthroughArgs],
      cfg.heapCapMb,
    ));
  }

  const exitCode = code ?? (signal ? 1 : 0);
  const summary = {
    mode,
    workers,
    oomRetryCount,
    changedFileCount: changedFiles.length,
    exitCode,
    signal: signal ?? null,
  };
  console.error(`[verify-gate] summary ${JSON.stringify(summary)}`);

  const summaryDir = process.env.AGENTFORGE_VERIFY_SUMMARY_DIR;
  if (summaryDir) {
    try {
      writeFileSync(join(summaryDir, 'verify-gate-summary.json'), JSON.stringify(summary, null, 2));
    } catch {
      // best-effort; never fail the gate on a summary-write error
    }
  }

  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
