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
import { freemem, totalmem, cpus, platform } from 'node:os';
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

function parseNonNegativeNumber(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInteger(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDarwinVmStatAvailableGb(totalGb) {
  let out;
  try {
    out = execFileSync('vm_stat', { encoding: 'utf8' });
  } catch {
    return null;
  }

  const pageSizeMatch = out.match(/page size of (\d+) bytes/i);
  const activeMatch = out.match(/Pages active:\s+([\d.]+)/i);
  const wiredMatch = out.match(/Pages wired down:\s+([\d.]+)/i);
  if (!pageSizeMatch || !activeMatch || !wiredMatch) return null;

  const pageSize = Number.parseInt(pageSizeMatch[1], 10);
  const activePages = Number.parseInt(activeMatch[1].replaceAll('.', ''), 10);
  const wiredPages = Number.parseInt(wiredMatch[1].replaceAll('.', ''), 10);
  if (!Number.isFinite(pageSize) || !Number.isFinite(activePages) || !Number.isFinite(wiredPages)) {
    return null;
  }

  const committedGb = ((activePages + wiredPages) * pageSize) / 1e9;
  return Math.max(0, totalGb - committedGb);
}

function parseLinuxMemAvailableGb() {
  let out;
  try {
    out = readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }

  const availableMatch = out.match(/^MemAvailable:\s+(\d+)\s+kB/im);
  if (!availableMatch) return null;

  const availableKb = Number.parseInt(availableMatch[1], 10);
  return Number.isFinite(availableKb) ? (availableKb * 1024) / 1e9 : null;
}

function resolveAvailableMemoryGb({ freeGb, totalGb }) {
  const envAvailableGb = parseNonNegativeNumber(process.env.AGENTFORGE_VERIFY_AVAILABLE_GB);
  if (envAvailableGb !== null) {
    return { availableGb: envAvailableGb, availableSource: 'env' };
  }

  const osPlatform = platform();
  if (osPlatform === 'darwin') {
    const darwinAvailableGb = parseDarwinVmStatAvailableGb(totalGb);
    if (darwinAvailableGb !== null) {
      return { availableGb: darwinAvailableGb, availableSource: 'darwin-vm_stat' };
    }
  }

  if (osPlatform === 'linux') {
    const linuxAvailableGb = parseLinuxMemAvailableGb();
    if (linuxAvailableGb !== null) {
      return { availableGb: linuxAvailableGb, availableSource: 'linux-meminfo' };
    }
  }

  return { availableGb: freeGb, availableSource: 'freemem' };
}

function resolveWorkerSizing(cfg) {
  const freeGb = freemem() / 1e9;
  const totalGb = totalmem() / 1e9;
  const cores = cpus().length;
  const { availableGb, availableSource } = resolveAvailableMemoryGb({ freeGb, totalGb });
  const minWorkers = Math.max(2, parsePositiveInteger(process.env.AGENTFORGE_VERIFY_MIN_WORKERS) ?? 2);
  const computedWorkers = computeWorkers(availableGb, cores, {
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
  });
  const workers = Math.max(minWorkers, computedWorkers);

  return {
    freeGb,
    totalGb,
    availableGb,
    availableSource,
    cores,
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
    minWorkers,
    computedWorkers,
    workers,
  };
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

  const workerSizing = resolveWorkerSizing(cfg);
  let workers = workerSizing.workers;

  // Forward any args appended by the caller (e.g. RealTestRunner appends
  // `-- --reporter=json --outputFile <path>` so it can parse the report). Strip
  // the bare `--` separator — vitest's CAC parser treats it as end-of-options
  // and would mis-read the following flags as positional file filters.
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--');

  console.error(
    `[verify-gate] mode=${mode} workers=${workers} changedFiles=${changedFiles.length} availableGb=${workerSizing.availableGb.toFixed(1)} freeGb=${workerSizing.freeGb.toFixed(1)} passthrough=${passthroughArgs.length}`,
  );
  console.error(`[verify-gate] workerSizing ${JSON.stringify(workerSizing)}`);

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
    workerSizing: { ...workerSizing, workers },
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
