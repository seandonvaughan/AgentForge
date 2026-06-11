/**
 * Subprocess integration test for the VERIFY-gate entry runner.
 *
 * Spawns scripts/run-verify-tests.mjs against a tiny temp fixture project and
 * asserts it selects the right gate mode, runs vitest green, and writes a
 * summary. This is where vitest-bin resolution and arg construction surface if
 * wrong (per the plan's flagged risk).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Absolute path to the runner in THIS repo; createRequire inside it resolves
// vitest from this repo's node_modules even when run with a fixture cwd.
const RUNNER = resolve(process.cwd(), 'scripts/run-verify-tests.mjs');

let fixture: string;

function runFixture(env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, AGENTFORGE_CHANGED_FILES: '', ...env },
  });
}

function parseWorkerSelection(stderr: string) {
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith('[verify-gate] worker-selection '));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice('[verify-gate] worker-selection '.length));
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'verify-gate-fixture-'));
  // A trivial passing test so the gate has something to run.
  writeFileSync(
    join(fixture, 'example.test.ts'),
    "import { expect, it } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n",
    'utf8',
  );
  // Minimal vitest config scoped to the fixture file.
  writeFileSync(
    join(fixture, 'vitest.config.ts'),
    "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['example.test.ts'] } });\n",
    'utf8',
  );
  // Autonomous config with a testing block (empty diff in a non-repo → full gate).
  mkdirSync(join(fixture, '.agentforge'), { recursive: true });
  writeFileSync(
    join(fixture, '.agentforge', 'autonomous.yaml'),
    'testing:\n  affectedMode: auto\n  memory:\n    reserveGb: 1\n    perWorkerGb: 1\n    heapCapMb: 1024\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('run-verify-tests.mjs (subprocess)', () => {
  it('runs the fixture suite green and writes a full-gate summary', () => {
    const res = runFixture({ AGENTFORGE_VERIFY_SUMMARY_DIR: fixture });

    expect(res.status, res.stderr).toBe(0);
    const summaryPath = join(fixture, 'verify-gate-summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    // Non-repo fixture → git diff fails → empty changed files → full gate.
    expect(summary.mode).toBe('full');
    expect(summary.exitCode).toBe(0);
    expect(summary.oomRetryCount).toBe(0);
    expect(summary.workers).toBeGreaterThanOrEqual(2);
  });

  it('uses AGENTFORGE_VERIFY_AVAILABLE_GB and AGENTFORGE_VERIFY_MIN_WORKERS overrides', () => {
    const res = runFixture({
      AGENTFORGE_VERIFY_AVAILABLE_GB: '2.5',
      AGENTFORGE_VERIFY_MIN_WORKERS: '4',
    });

    expect(res.status, res.stderr).toBe(0);
    const decision = parseWorkerSelection(res.stderr);
    expect(decision.source).toBe('env');
    expect(decision.availableGbOverrideRaw).toBe('2.5');
    expect(decision.availableGb).toBe(2.5);
    expect(decision.minWorkersOverrideRaw).toBe('4');
    expect(decision.minWorkersOverride).toBe(4);
    expect(decision.workers).toBeGreaterThanOrEqual(4);
  });

  it('derives darwin available memory from total minus active and wired estimates', () => {
    const res = runFixture({
      AGENTFORGE_VERIFY_TEST_PLATFORM: 'darwin',
      AGENTFORGE_VERIFY_TEST_TOTAL_GB: '16',
      AGENTFORGE_VERIFY_TEST_VM_STAT: [
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
        'Pages active: 262144.',
        'Pages wired down: 131072.',
      ].join('\n'),
    });

    expect(res.status, res.stderr).toBe(0);
    const decision = parseWorkerSelection(res.stderr);
    expect(decision.source).toBe('darwin-total-minus-active-wired');
    expect(decision.platform).toBe('darwin');
    expect(decision.totalGb).toBe(16);
    expect(decision.darwinActiveGb).toBeCloseTo(4.294967296, 6);
    expect(decision.darwinWiredGb).toBeCloseTo(2.147483648, 6);
    expect(decision.availableGb).toBeCloseTo(9.557549056, 6);
  });

  it('clamps the initial worker decision to at least two workers', () => {
    const res = runFixture({ AGENTFORGE_VERIFY_AVAILABLE_GB: '0.25' });

    expect(res.status, res.stderr).toBe(0);
    const decision = parseWorkerSelection(res.stderr);
    expect(decision.plannerWorkers).toBe(1);
    expect(decision.minWorkers).toBe(2);
    expect(decision.workers).toBe(2);
  });

  it('forwards appended --reporter=json --outputFile to vitest (the RealTestRunner contract)', () => {
    const reportPath = join(fixture, 'test-results.json');
    // Mimic EXACTLY how RealTestRunner invokes a non-`vitest` command: it inserts
    // a `--` separator then appends the json reporter args. The runner must strip
    // the separator and forward the reporter flags so the JSON report is written.
    const res = runFixture({}, ['--', '--reporter=json', '--outputFile', reportPath]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    // The vitest JSON-reporter shape that RealTestRunner.parseVitestJson consumes.
    expect(typeof report.numTotalTests).toBe('number');
    expect(report.numTotalTests).toBeGreaterThanOrEqual(1);
    expect(report.numPassedTests).toBe(report.numTotalTests);
  });
});
