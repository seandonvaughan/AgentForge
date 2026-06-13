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

  it('honors memory and worker floor overrides in the verify gate', () => {
    const res = spawnSync(process.execPath, [RUNNER], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFORGE_CHANGED_FILES: '',
        AGENTFORGE_VERIFY_SUMMARY_DIR: fixture,
        AGENTFORGE_VERIFY_AVAILABLE_GB: '0.1',
        AGENTFORGE_VERIFY_MIN_WORKERS: '2',
      },
    });

    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('availableSource=env:AGENTFORGE_VERIFY_AVAILABLE_GB');
    const summary = JSON.parse(readFileSync(join(fixture, 'verify-gate-summary.json'), 'utf8'));
    expect(summary.baseWorkers).toBe(1);
    expect(summary.minWorkers).toBe(2);
    expect(summary.workers).toBe(2);
    expect(summary.availableMemoryGb).toBe(0.1);
    expect(summary.availableMemorySource).toBe('env:AGENTFORGE_VERIFY_AVAILABLE_GB');
  });

  it('fails related mode with summary findings when package and dashboard tests are not selected', () => {
    mkdirSync(join(fixture, 'packages/core/src/__tests__'), { recursive: true });
    mkdirSync(join(fixture, 'packages/dashboard/src/lib/__tests__'), { recursive: true });
    writeFileSync(join(fixture, 'packages/core/src/feature.ts'), 'export const feature = 1;\n', 'utf8');
    writeFileSync(join(fixture, 'packages/dashboard/src/lib/widget.ts'), 'export const widget = 1;\n', 'utf8');
    writeFileSync(
      join(fixture, 'packages/core/src/__tests__/feature.test.ts'),
      "import { expect, it } from 'vitest';\nimport { feature } from '../feature';\nit('feature', () => expect(feature).toBe(1));\n",
      'utf8',
    );
    writeFileSync(
      join(fixture, 'packages/dashboard/src/lib/__tests__/widget.test.ts'),
      "import { expect, it } from 'vitest';\nimport { widget } from '../widget';\nit('widget', () => expect(widget).toBe(1));\n",
      'utf8',
    );
    writeFileSync(
      join(fixture, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['example.test.ts', 'packages/**/*.test.ts'] } });\n",
      'utf8',
    );
    writeFileSync(
      join(fixture, '.agentforge', 'autonomous.yaml'),
      'testing:\n  affectedMode: related\n  memory:\n    reserveGb: 1\n    perWorkerGb: 1\n    heapCapMb: 1024\n',
      'utf8',
    );

    const changedFiles = [
      'packages/core/src/feature.ts',
      'packages/dashboard/src/lib/widget.ts',
    ].join('\n');
    const res = spawnSync(process.execPath, [RUNNER], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFORGE_CHANGED_FILES: changedFiles,
        AGENTFORGE_VERIFY_SUMMARY_DIR: fixture,
        AGENTFORGE_VERIFY_AVAILABLE_GB: '2',
        AGENTFORGE_VERIFY_MIN_WORKERS: '1',
      },
    });

    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain('changed file: packages/core/src/feature.ts');
    expect(res.stderr).toContain('expected test pattern: packages/core/src/__tests__/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}');
    expect(res.stderr).toContain('selected args:');
    expect(res.stderr).toContain('remediation: Add packages/core/src/__tests__/feature.test.ts');

    const summary = JSON.parse(readFileSync(join(fixture, 'verify-gate-summary.json'), 'utf8'));
    expect(summary.exitCode).toBe(1);
    expect(summary.uncollectedTestCount).toBe(2);
    expect(summary.uncollectedTestFiles).toEqual([
      'packages/core/src/__tests__/feature.test.ts',
      'packages/dashboard/src/lib/__tests__/widget.test.ts',
    ]);
    expect(summary.uncollectedTestFindings[0]).toMatchObject({
      changedFile: 'packages/core/src/feature.ts',
      uncollectedTestFile: 'packages/core/src/__tests__/feature.test.ts',
      expectedTestPattern: 'packages/core/src/__tests__/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs} or packages/core/src/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
      remediation: 'Add packages/core/src/__tests__/feature.test.ts to the selected vitest inputs or run the verify gate in full mode.',
    });
    expect(summary.uncollectedTestFindings[0].selectedArgs).toEqual(expect.arrayContaining([
      'related',
      '--run',
      'packages/core/src/feature.ts',
      'packages/dashboard/src/lib/widget.ts',
      '--maxWorkers=1',
    ]));
  });
});
