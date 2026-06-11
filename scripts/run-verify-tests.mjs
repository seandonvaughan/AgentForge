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
import { fileURLToPath } from 'node:url';
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
const THIS_FILE = fileURLToPath(import.meta.url);
const GB = 1e9;
const WORKER_FLOOR = 2;

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

function parsePositiveInt(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function roundGb(value) {
  return Math.round(value * 1000) / 1000;
}

function parseDarwinVmStat(text) {
  const pageSizeMatch = String(text).match(/page size of (\d+) bytes/i);
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : null;
  if (!pageSize || !Number.isFinite(pageSize) || pageSize <= 0) return null;

  const pages = {};
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^Pages\s+(.+?):\s+([0-9]+)\.?$/);
    if (match) pages[match[1].toLowerCase()] = Number.parseInt(match[2], 10);
  }

  const activePages = pages.active;
  const wiredPages = pages['wired down'];
  if (!Number.isFinite(activePages) || !Number.isFinite(wiredPages)) return null;

  return {
    activeGb: (activePages * pageSize) / GB,
    wiredGb: (wiredPages * pageSize) / GB,
  };
}

function readDarwinVmStat() {
  try {
    return execFileSync('vm_stat', { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function resolveAvailableMemory({ env, platformName, freeBytes, totalBytes, darwinVmStatText }) {
  const envAvailableGb = parsePositiveNumber(env.AGENTFORGE_VERIFY_AVAILABLE_GB);
  const freeGb = freeBytes / GB;
  const totalGb = totalBytes / GB;

  if (envAvailableGb !== null) {
    return {
      source: 'env',
      availableGb: envAvailableGb,
      freeGb,
      totalGb,
      envAvailableGbRaw: env.AGENTFORGE_VERIFY_AVAILABLE_GB,
      darwinActiveGb: null,
      darwinWiredGb: null,
    };
  }

  if (platformName === 'darwin') {
    const darwin = parseDarwinVmStat(darwinVmStatText ?? '');
    if (darwin) {
      return {
        source: 'darwin-estimate',
        availableGb: Math.max(0, totalGb - darwin.wiredGb - darwin.activeGb),
        freeGb,
        totalGb,
        envAvailableGbRaw: env.AGENTFORGE_VERIFY_AVAILABLE_GB ?? null,
        darwinActiveGb: darwin.activeGb,
        darwinWiredGb: darwin.wiredGb,
      };
    }
  }

  return {
    source: 'freemem',
    availableGb: freeGb,
    freeGb,
    totalGb,
    envAvailableGbRaw: env.AGENTFORGE_VERIFY_AVAILABLE_GB ?? null,
    darwinActiveGb: null,
    darwinWiredGb: null,
  };
}

function selectVerifyWorkers({ env, platformName, freeBytes, totalBytes, cores, reserveGb, perWorkerGb, darwinVmStatText }) {
  const memory = resolveAvailableMemory({ env, platformName, freeBytes, totalBytes, darwinVmStatText });
  const configuredMinWorkers = parsePositiveInt(env.AGENTFORGE_VERIFY_MIN_WORKERS);
  const floorWorkers = Math.max(WORKER_FLOOR, configuredMinWorkers ?? WORKER_FLOOR);
  const plannerWorkers = computeWorkers(memory.availableGb, cores, { reserveGb, perWorkerGb });
  const workers = Math.max(floorWorkers, plannerWorkers);

  return {
    platform: platformName,
    source: memory.source,
    envAvailableGbRaw: memory.envAvailableGbRaw,
    envMinWorkersRaw: env.AGENTFORGE_VERIFY_MIN_WORKERS ?? null,
    freeGb: roundGb(memory.freeGb),
    totalGb: roundGb(memory.totalGb),
    availableGb: roundGb(memory.availableGb),
    darwinActiveGb: memory.darwinActiveGb === null ? null : roundGb(memory.darwinActiveGb),
    darwinWiredGb: memory.darwinWiredGb === null ? null : roundGb(memory.darwinWiredGb),
    cores,
    reserveGb,
    perWorkerGb,
    plannerWorkers,
    floorWorkers,
    workers,
  };
}

function formatWorkerSelectionLog(decision) {
  return `[verify-gate] worker-selection ${JSON.stringify(decision)}`;
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

  const platformName = platform();
  const darwinVmStatText = platformName === 'darwin' ? readDarwinVmStat() : null;
  const workerDecision = selectVerifyWorkers({
    env: process.env,
    platformName,
    freeBytes: freemem(),
    totalBytes: totalmem(),
    cores: cpus().length,
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
    darwinVmStatText,
  });
  let workers = workerDecision.workers;

  // Forward any args appended by the caller (e.g. RealTestRunner appends
  // `-- --reporter=json --outputFile <path>` so it can parse the report). Strip
  // the bare `--` separator — vitest's CAC parser treats it as end-of-options
  // and would mis-read the following flags as positional file filters.
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--');

  console.error(formatWorkerSelectionLog(workerDecision));
  console.error(
    `[verify-gate] mode=${mode} workers=${workers} changedFiles=${changedFiles.length} availableGb=${workerDecision.availableGb.toFixed(1)} passthrough=${passthroughArgs.length}`,
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

async function registerVitestTests() {
  const { describe, it } = await import('vitest');

  describe('run-verify-tests worker selection', () => {
    it('proves env overrides, Darwin estimate, floor clamp, and structured logging', async () => {
      await runSelfTestAssertions({ log: false });
    });
  });
}

async function runSelfTestAssertions({ log = true } = {}) {
  const assert = await import('node:assert/strict');

  const envDecision = selectVerifyWorkers({
    env: { AGENTFORGE_VERIFY_AVAILABLE_GB: '9', AGENTFORGE_VERIFY_MIN_WORKERS: '5' },
    platformName: 'linux',
    freeBytes: 2 * GB,
    totalBytes: 16 * GB,
    cores: 8,
    reserveGb: 1,
    perWorkerGb: 2,
  });
  assert.equal(envDecision.source, 'env');
  assert.equal(envDecision.availableGb, 9);
  assert.equal(envDecision.workers, 5);

  const darwinDecision = selectVerifyWorkers({
    env: {},
    platformName: 'darwin',
    freeBytes: 2 * GB,
    totalBytes: 32 * GB,
    cores: 16,
    reserveGb: 2,
    perWorkerGb: 2,
    darwinVmStatText: [
      'Mach Virtual Memory Statistics: (page size of 1000000000 bytes)',
      'Pages active: 10.',
      'Pages wired down: 6.',
    ].join('\n'),
  });
  assert.equal(darwinDecision.source, 'darwin-estimate');
  assert.equal(darwinDecision.availableGb, 16);
  assert.equal(darwinDecision.workers, 7);

  const floorDecision = selectVerifyWorkers({
    env: {},
    platformName: 'linux',
    freeBytes: 1 * GB,
    totalBytes: 8 * GB,
    cores: 2,
    reserveGb: 2,
    perWorkerGb: 2,
  });
  assert.equal(floorDecision.plannerWorkers, 1);
  assert.equal(floorDecision.workers, 2);

  const logLine = formatWorkerSelectionLog(envDecision);
  const parsed = JSON.parse(logLine.slice('[verify-gate] worker-selection '.length));
  assert.equal(parsed.envAvailableGbRaw, '9');
  assert.equal(parsed.envMinWorkersRaw, '5');
  assert.equal(parsed.freeGb, 2);
  assert.equal(parsed.totalGb, 16);
  assert.equal(parsed.workers, 5);
  if (log) console.error('[verify-gate] self-test assertions passed');
}

if (process.argv[1] === THIS_FILE) {
  if (process.env.AGENTFORGE_VERIFY_SELF_TEST === '1') {
    await runSelfTestAssertions();
  } else {
    main();
  }
} else if (process.env.VITEST) {
  await registerVitestTests();
}
