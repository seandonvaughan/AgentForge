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
    const res = spawnSync(process.execPath, [RUNNER], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, AGENTFORGE_VERIFY_SUMMARY_DIR: fixture, AGENTFORGE_CHANGED_FILES: '' },
    });

    expect(res.status, res.stderr).toBe(0);
    const summaryPath = join(fixture, 'verify-gate-summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    // Non-repo fixture → git diff fails → empty changed files → full gate.
    expect(summary.mode).toBe('full');
    expect(summary.exitCode).toBe(0);
    expect(summary.oomRetryCount).toBe(0);
    expect(summary.workers).toBeGreaterThanOrEqual(1);
    expect(summary.workerSizing.workers).toBe(summary.workers);
    expect(summary.workerSizing.availableGb).toBeGreaterThanOrEqual(0);
    expect(summary.workerSizing.freeGb).toBeGreaterThanOrEqual(0);
    expect(summary.workerSizing.totalGb).toBeGreaterThan(0);
    expect(summary.workerSizing.cores).toBeGreaterThan(0);
    expect(summary.workerSizing.reserveGb).toBe(1);
    expect(summary.workerSizing.perWorkerGb).toBe(1);
    expect(summary.workerSizing.minWorkers).toBe(2);
    expect(summary.workerSizing.computedWorkers).toBeGreaterThanOrEqual(1);
    expect(res.stderr).toContain('[verify-gate] workerSizing ');
    expect(res.stderr).toContain('availableGb=');
  });

  it('honors available-memory and minimum-worker environment overrides', () => {
    const res = spawnSync(process.execPath, [RUNNER], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFORGE_VERIFY_SUMMARY_DIR: fixture,
        AGENTFORGE_CHANGED_FILES: '',
        AGENTFORGE_VERIFY_AVAILABLE_GB: '1',
        AGENTFORGE_VERIFY_MIN_WORKERS: '4',
      },
    });

    expect(res.status, res.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(fixture, 'verify-gate-summary.json'), 'utf8'));
    expect(summary.workers).toBe(4);
    expect(summary.workerSizing.availableGb).toBe(1);
    expect(summary.workerSizing.availableSource).toBe('env');
    expect(summary.workerSizing.minWorkers).toBe(4);
    expect(summary.workerSizing.computedWorkers).toBe(1);
    expect(res.stderr).toContain('"availableSource":"env"');
    expect(res.stderr).toContain('"minWorkers":4');
    expect(res.stderr).toContain('"workers":4');
  });

  it('clamps workers to at least two when available memory is low', () => {
    const res = spawnSync(process.execPath, [RUNNER], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFORGE_VERIFY_SUMMARY_DIR: fixture,
        AGENTFORGE_CHANGED_FILES: '',
        AGENTFORGE_VERIFY_AVAILABLE_GB: '0',
      },
    });

    expect(res.status, res.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(fixture, 'verify-gate-summary.json'), 'utf8'));
    expect(summary.workers).toBe(2);
    expect(summary.workerSizing.availableGb).toBe(0);
    expect(summary.workerSizing.minWorkers).toBe(2);
    expect(summary.workerSizing.computedWorkers).toBe(1);
  });

  it('forwards appended --reporter=json --outputFile to vitest (the RealTestRunner contract)', () => {
    const reportPath = join(fixture, 'test-results.json');
    // Mimic EXACTLY how RealTestRunner invokes a non-`vitest` command: it inserts
    // a `--` separator then appends the json reporter args. The runner must strip
    // the separator and forward the reporter flags so the JSON report is written.
    const res = spawnSync(
      process.execPath,
      [RUNNER, '--', '--reporter=json', '--outputFile', reportPath],
      { cwd: fixture, encoding: 'utf8', env: { ...process.env, AGENTFORGE_CHANGED_FILES: '' } },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    // The vitest JSON-reporter shape that RealTestRunner.parseVitestJson consumes.
    expect(typeof report.numTotalTests).toBe('number');
    expect(report.numTotalTests).toBeGreaterThanOrEqual(1);
    expect(report.numPassedTests).toBe(report.numTotalTests);
  });
});
