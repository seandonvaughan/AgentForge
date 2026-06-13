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
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { freemem, cpus, platform, totalmem } from 'node:os';
import { join, dirname, relative } from 'node:path';
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
  isTestFile,
  normalizeRepoPath,
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

function getGitTrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const SKIPPED_INVENTORY_DIRS = new Set([
  '.agentforge',
  '.git',
  '.svelte-kit',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function walkFiles(dir) {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_INVENTORY_DIRS.has(entry.name)) {
        files.push(...walkFiles(join(dir, entry.name)));
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizeRepoPath(relative(ROOT, join(dir, entry.name))));
    }
  }
  return files;
}

function collectTestInventory() {
  const trackedFiles = getGitTrackedFiles();
  const files = trackedFiles.length > 0 ? trackedFiles : walkFiles(ROOT);
  return files.map(normalizeRepoPath).filter((file) => file.startsWith('packages/') && isTestFile(file));
}

function repoDirname(file) {
  const idx = file.lastIndexOf('/');
  return idx === -1 ? '' : file.slice(0, idx);
}

function isInventorySourceFile(file) {
  if (isTestFile(file)) return false;
  const exts = ['.svelte', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  return exts.some((ext) => file.endsWith(ext));
}

function adjacentTestDirFor(file) {
  const dir = repoDirname(file);
  return dir.length === 0 ? '__tests__/' : `${dir}/__tests__/`;
}

function isCandidateTestForChangedFile(testFile, changedFile) {
  if (testFile === changedFile && isTestFile(changedFile)) return true;
  if (!isInventorySourceFile(changedFile)) return false;
  if (!changedFile.startsWith('packages/')) return false;

  const adjacentTestDir = adjacentTestDirFor(changedFile);
  if (testFile.startsWith(adjacentTestDir)) return true;

  const sourceDir = repoDirname(changedFile);
  return sourceDir.length > 0 && testFile.startsWith(`${sourceDir}/`) && isTestFile(testFile);
}

function expectedTestPatternFor(changedFile) {
  const dir = repoDirname(changedFile);
  const prefix = dir.length === 0 ? '' : `${dir}/`;
  return `${prefix}__tests__/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs} or ` +
    `${prefix}*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}`;
}

function selectedFilesFromVitestArgs(args) {
  return args
    .filter((arg) => arg !== 'related' && arg !== 'run' && arg !== '--run' && !arg.startsWith('-'))
    .map(normalizeRepoPath)
    .filter(Boolean);
}

function buildUncollectedTestFindings({ changedFiles, selectedFiles, selectedArgs, testFiles }) {
  const selected = new Set(selectedFiles.map(normalizeRepoPath).filter(Boolean));
  const findings = [];
  const seen = new Set();
  for (const changedFile of changedFiles.map(normalizeRepoPath).filter(Boolean)) {
    for (const testFile of testFiles) {
      if (!isCandidateTestForChangedFile(testFile, changedFile)) continue;
      if (selected.has(testFile)) continue;

      const key = `${changedFile}\n${testFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        changedFile,
        uncollectedTestFile: testFile,
        expectedTestPattern: expectedTestPatternFor(changedFile),
        selectedArgs,
        remediation: `Add ${testFile} to the selected vitest inputs or run the verify gate in full mode.`,
      });
    }
  }
  return findings;
}

function formatUncollectedFindingsError(findings) {
  return [
    '[verify-gate] uncollected package/dashboard tests detected',
    ...findings.flatMap((finding) => [
      `- changed file: ${finding.changedFile}`,
      `  expected test pattern: ${finding.expectedTestPattern}`,
      `  uncollected test: ${finding.uncollectedTestFile}`,
      `  selected args: ${JSON.stringify(finding.selectedArgs)}`,
      `  remediation: ${finding.remediation}`,
    ]),
  ].join('\n');
}

function resolveVitestBin() {
  const pkgJson = require.resolve('vitest/package.json');
  return join(dirname(pkgJson), 'vitest.mjs');
}

function parsePositiveFloat(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInt(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveMinWorkers() {
  return parsePositiveInt(process.env.AGENTFORGE_VERIFY_MIN_WORKERS) ?? 2;
}

function parseDarwinVmStatAvailableGb(output, totalBytes) {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : 4096;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const pagesFor = (label) => {
    const line = output.split('\n').find((entry) => entry.trim().startsWith(label));
    if (!line) return null;
    const match = line.match(/:\s+(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
  };

  const activePages = pagesFor('Pages active');
  const wiredPages = pagesFor('Pages wired down');
  if (activePages === null || wiredPages === null) return null;
  const compressorPages = pagesFor('Pages occupied by compressor') ?? 0;

  const pinnedBytes = (activePages + wiredPages + compressorPages) * pageSize;
  return Math.max(0, (totalBytes - pinnedBytes) / BYTES_PER_GB);
}

function resolveAvailableMemory() {
  const envAvailableGb = parsePositiveFloat(process.env.AGENTFORGE_VERIFY_AVAILABLE_GB);
  const freeGb = freemem() / BYTES_PER_GB;
  const totalBytes = totalmem();
  const totalGb = totalBytes / BYTES_PER_GB;
  if (envAvailableGb !== null) {
    return {
      availableGb: Math.min(envAvailableGb, totalGb),
      source: 'env:AGENTFORGE_VERIFY_AVAILABLE_GB',
      freeGb,
      totalGb,
    };
  }

  if (platform() === 'darwin') {
    try {
      const vmStat = spawnSync('vm_stat', [], { encoding: 'utf8' });
      if (vmStat.status === 0 && typeof vmStat.stdout === 'string') {
        const darwinAvailableGb = parseDarwinVmStatAvailableGb(vmStat.stdout, totalBytes);
        if (darwinAvailableGb !== null) {
          return {
            availableGb: Math.max(freeGb, darwinAvailableGb),
            source: 'darwin:vm_stat-total-minus-active-wired',
            freeGb,
            totalGb,
          };
        }
      }
    } catch {
      // Fall through to os.freemem(); worker sizing remains conservative.
    }
  }

  return {
    availableGb: freeGb,
    source: 'os.freemem',
    freeGb,
    totalGb,
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

  const memory = resolveAvailableMemory();
  const cores = cpus().length;
  const minWorkers = resolveMinWorkers();
  const baseWorkers = computeWorkers(memory.availableGb, cores, {
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
  });
  let workers = Math.max(1, Math.min(cores, Math.max(minWorkers, baseWorkers)));

  // Forward any args appended by the caller (e.g. RealTestRunner appends
  // `-- --reporter=json --outputFile <path>` so it can parse the report). Strip
  // the bare `--` separator — vitest's CAC parser treats it as end-of-options
  // and would mis-read the following flags as positional file filters.
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--');

  console.error(
    `[verify-gate] mode=${mode} workers=${workers} baseWorkers=${baseWorkers} minWorkers=${minWorkers} ` +
      `changedFiles=${changedFiles.length} availableGb=${memory.availableGb.toFixed(1)} ` +
      `availableSource=${memory.source} freeGb=${memory.freeGb.toFixed(1)} totalGb=${memory.totalGb.toFixed(1)} ` +
      `cores=${cores} reserveGb=${cfg.reserveGb} perWorkerGb=${cfg.perWorkerGb} ` +
      `passthrough=${passthroughArgs.length}`,
  );

  const gateArgs = buildVitestArgs({ mode, changedFiles, workers });
  const vitestArgs = [...gateArgs, ...passthroughArgs];
  const uncollectedTestFindings = mode === 'related'
    ? buildUncollectedTestFindings({
      changedFiles,
      selectedFiles: selectedFilesFromVitestArgs(gateArgs),
      selectedArgs: vitestArgs,
      testFiles: collectTestInventory(),
    })
    : [];

  if (uncollectedTestFindings.length > 0) {
    const exitCode = 1;
    const summary = {
      mode,
      workers,
      baseWorkers,
      minWorkers,
      availableMemoryGb: Number(memory.availableGb.toFixed(3)),
      availableMemorySource: memory.source,
      oomRetryCount: 0,
      changedFileCount: changedFiles.length,
      exitCode,
      signal: null,
      uncollectedTestCount: uncollectedTestFindings.length,
      uncollectedTestFiles: Array.from(new Set(uncollectedTestFindings.map((finding) => finding.uncollectedTestFile))),
      uncollectedTestFindings,
    };
    console.error(formatUncollectedFindingsError(uncollectedTestFindings));
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

  let { code, signal } = runVitest(vitestArgs, cfg.heapCapMb);
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
    baseWorkers,
    minWorkers,
    availableMemoryGb: Number(memory.availableGb.toFixed(3)),
    availableMemorySource: memory.source,
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
