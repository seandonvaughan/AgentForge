/**
 * Tests for scripts/check-no-legacy-src-imports.mjs
 *
 * Verifies:
 * (a) A fixture file containing a deep src/ import causes the script to exit non-zero.
 * (b) The remaining-real-src count reported by the script is below the recorded
 *     baseline of 163 (the count before src/index.ts was converted to a shim),
 *     so any future all-pass allowlist regression fails.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'check-no-legacy-src-imports.mjs');

// Fixture directory that will hold a synthetic file with a deep src/ import.
const fixtureDir = join(repoRoot, 'tests', 'convergence', '__fixtures__');
const fixtureFile = join(fixtureDir, 'bad-import-fixture.ts');

// Clean up after all tests so we never leave generated files around.
afterAll(() => {
  if (existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function runScript(extraArgs: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [scriptPath, ...extraArgs],
    { encoding: 'utf8', cwd: repoRoot }
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-no-legacy-src-imports', () => {
  it('exits non-zero when a file contains a deep src/ import (the violation fixture)', () => {
    // Create a fixture file with a concrete deep-src import.
    mkdirSync(fixtureDir, { recursive: true });
    // The fixture lives at tests/convergence/__fixtures__/bad-import-fixture.ts.
    // From there, 3 levels up (../../../) reaches the repo root, so
    // '../../../src/utils/hello-world.js' is a genuine deep src/ import.
    writeFileSync(
      fixtureFile,
      [
        '// Fixture: intentional deep src/ import — must be detected as a violation',
        "import { helloWorld } from '../../../src/utils/hello-world.js';",
        'export { helloWorld };',
      ].join('\n'),
      'utf8'
    );

    const result = runScript(['--scan-dir', fixtureDir]);
    expect(result.exitCode).not.toBe(0);
    // The output should name the offending file.
    const combined = result.stdout + result.stderr;
    expect(combined.includes('bad-import-fixture')).toBe(true);
  });

  it('remaining-real-src count is below baseline of 163 (prevents all-pass allowlist regressions)', () => {
    // Run the script without any fixture dir so it scans only the real codebase.
    const result = runScript();

    // The script always prints the remaining count in a parseable line:
    //   "Remaining real (non-shim) src/ modules: <N>"
    const combined = result.stdout + result.stderr;
    const match = combined.match(/Remaining real \(non-shim\) src\/ modules:\s*(\d+)/);
    expect(match).not.toBeNull();

    const remaining = parseInt(match![1], 10);
    // Baseline before any convergence work was 163.
    // After converting src/index.ts to a thin re-export shim the count is 162.
    // Assert strictly below 163 so any future allowlist that re-inflates the
    // count to ≥163 will break this test.
    expect(remaining).toBeLessThan(163);
  });
});
