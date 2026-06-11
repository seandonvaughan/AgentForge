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
import { freemem, totalmem, cpus } from 'node:os';
import { join, dirname } from 'node:path';
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

function parsePositiveNumber(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInteger(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDarwinVmStat(vmStat) {
  const pageSize = Number.parseInt(vmStat.match(/page size of (\d+) bytes/)?.[1] ?? '', 10);
  const activePages = Number.parseInt(vmStat.match(/Pages active:\s+(\d+)\./)?.[1] ?? '', 10);
  const wiredPages = Number.parseInt(vmStat.match(/Pages wired down:\s+(\d+)\./)?.[1] ?? '', 10);
  if (!Number.isInteger(pageSize) || !Number.isInteger(activePages) || !Number.isInteger(wiredPages)) {
    return null;
  }
  return {
    darwinActiveGb: (activePages * pageSize) / BYTES_PER_GB,
    darwinWiredGb: (wiredPages * pageSize) / BYTES_PER_GB,
  };
}

function readDarwinVmStat() {
  if (typeof process.env.AGENTFORGE_VERIFY_TEST_VM_STAT === 'string') {
    return process.env.AGENTFORGE_VERIFY_TEST_VM_STAT;
  }
  try {
    return execFileSync('vm_stat', [], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function resolveAvailableMemory() {
  const platform = process.env.AGENTFORGE_VERIFY_TEST_PLATFORM || process.platform;
  const freeGb = freemem() / BYTES_PER_GB;
  const totalGb = parsePositiveNumber(process.env.AGENTFORGE_VERIFY_TEST_TOTAL_GB) ?? totalmem() / BYTES_PER_GB;
  const availableGbOverride = parsePositiveNumber(process.env.AGENTFORGE_VERIFY_AVAILABLE_GB);

  if (availableGbOverride !== null) {
    return {
      source: 'env',
      platform,
      freeGb,
      totalGb,
      darwinActiveGb: null,
      darwinWiredGb: null,
      availableGbOverrideRaw: process.env.AGENTFORGE_VERIFY_AVAILABLE_GB ?? null,
      availableGb: availableGbOverride,
    };
  }

  if (platform === 'darwin') {
    const vmStat = readDarwinVmStat();
    const parsed = typeof vmStat === 'string' ? parseDarwinVmStat(vmStat) : null;
    if (parsed) {
      return {
        source: 'darwin-total-minus-active-wired',
        platform,
        freeGb,
        totalGb,
        ...parsed,
        availableGbOverrideRaw: null,
        availableGb: Math.max(0, totalGb - parsed.darwinActiveGb - parsed.darwinWiredGb),
      };
    }
  }

  return {
    source: 'freemem',
    platform,
    freeGb,
    totalGb,
    darwinActiveGb: null,
    darwinWiredGb: null,
    availableGbOverrideRaw: null,
    availableGb: freeGb,
  };
}

function selectVerifyWorkers(cfg) {
  const memory = resolveAvailableMemory();
  const cores = cpus().length;
  const minWorkersOverride = parsePositiveInteger(process.env.AGENTFORGE_VERIFY_MIN_WORKERS);
  const minWorkers = Math.max(2, minWorkersOverride ?? 2);
  const plannerWorkers = computeWorkers(memory.availableGb, cores, {
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
  });
  const workers = Math.max(minWorkers, plannerWorkers);

  return {
    workers,
    decision: {
      ...memory,
      reserveGb: cfg.reserveGb,
      perWorkerGb: cfg.perWorkerGb,
      cores,
      minWorkersOverrideRaw: process.env.AGENTFORGE_VERIFY_MIN_WORKERS ?? null,
      minWorkersOverride,
      minWorkers,
      plannerWorkers,
      workers,
    },
  };
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

  let { workers, decision: workerSelection } = selectVerifyWorkers(cfg);

  // Forward any args appended by the caller (e.g. RealTestRunner appends
  // `-- --reporter=json --outputFile <path>` so it can parse the report). Strip
  // the bare `--` separator — vitest's CAC parser treats it as end-of-options
  // and would mis-read the following flags as positional file filters.
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--');

  console.error(
    `[verify-gate] worker-selection ${JSON.stringify(workerSelection)}`,
  );
  console.error(
    `[verify-gate] mode=${mode} workers=${workers} changedFiles=${changedFiles.length} availableGb=${workerSelection.availableGb.toFixed(1)} passthrough=${passthroughArgs.length}`,
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

main();
