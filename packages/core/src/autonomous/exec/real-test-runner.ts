// packages/core/src/autonomous/exec/real-test-runner.ts
// Shells `vitest run` with --reporter=json, parses the JSON report into a
// TestResult, and computes regression deltas against a prior snapshot.
//
// Unit tests live at tests/autonomous/unit/real-test-runner.test.ts and use
// a mocked execFile + canned vitest report fixture in __fixtures__/.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §8.1.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { CycleConfig, TestResult, FailedTest } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Base error type for the test runner. Distinct from CycleKilledError so the
 * orchestrator can decide whether a runner blowup should kill the cycle or
 * trigger self-correction.
 */
export class TestRunnerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TestRunnerError';
  }
}

/**
 * Thrown when the underlying vitest process exceeds `config.timeoutMinutes`.
 * The orchestrator treats this as a hard kill condition.
 */
export class TestRunTimeoutError extends TestRunnerError {
  constructor(timeoutMs: number) {
    super(`Test run timed out after ${timeoutMs}ms`);
    this.name = 'TestRunTimeoutError';
  }
}

/**
 * Runs the project's configured test command (e.g. `npm run test:run`),
 * forces vitest to emit a JSON reporter file, parses it, and produces a
 * `TestResult` including the regression delta vs an optional prior snapshot.
 *
 * IMPORTANT: vitest exits non-zero whenever any test fails. That is *not* an
 * error condition for us — it's the normal "tests failed" path. We detect
 * runner failures by checking whether the JSON output file exists. The only
 * thrown errors here are timeouts and missing-output.
 */
export class RealTestRunner {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig['testing'],
    private readonly priorSnapshot: TestResult | null,
  ) {}

  async run(cycleId: string): Promise<TestResult> {
    const outputFile = join(this.cwd, '.agentforge/cycles', cycleId, 'test-results.json');
    mkdirSync(dirname(outputFile), { recursive: true });

    const cmdParts = this.config.command.split(' ');
    const cmd = cmdParts[0]!;
    // When the command invokes vitest directly (e.g. `pnpm exec vitest run`),
    // skip the `--` separator — vitest treats `--` as a test file filter and
    // ignores subsequent flags. Only use `--` for npm/pnpm script wrappers
    // where it separates script args from the inner command's flags.
    const isDirectVitest = cmdParts.some(p => p === 'vitest');
    const args = [
      ...cmdParts.slice(1),
      ...(isDirectVitest ? [] : ['--']),
      '--reporter=json',
      '--outputFile',
      outputFile,
    ];
    const timeoutMs = this.config.timeoutMinutes * 60_000;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const startedAt = Date.now();

    try {
      const result = await execFileAsync(cmd, args, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });
      stdout = result.stdout.toString();
      stderr = result.stderr.toString();
    } catch (err: unknown) {
      const e = err as {
        code?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        killed?: boolean;
        signal?: string;
      };
      exitCode = e.code ?? 1;
      stdout = e.stdout?.toString() ?? '';
      stderr = e.stderr?.toString() ?? '';
      // Distinguish "timed out" from "tests failed". Both throw from
      // execFileAsync, but only the former should propagate as an error.
      if (e.killed || e.signal === 'SIGTERM') {
        throw new TestRunTimeoutError(timeoutMs);
      }
      // Any other thrown error here is just "vitest exited non-zero
      // because tests failed" — fall through to JSON parsing below.
    }

    const rawLogPath = join(this.cwd, '.agentforge/cycles', cycleId, 'tests-raw.log');
    if (this.config.saveRawLog) {
      writeFileSync(rawLogPath, stdout + '\n--- STDERR ---\n' + stderr);
    }

    if (!existsSync(outputFile)) {
      throw new TestRunnerError(
        `vitest did not produce output file (exit ${exitCode}): ${stderr.slice(0, 500)}`,
      );
    }

    const raw = JSON.parse(readFileSync(outputFile, 'utf8'));
    return this.parseVitestJson(raw, rawLogPath, startedAt, exitCode);
  }

  /**
   * Walks vitest's JSON reporter shape (testResults[].assertionResults[]) and
   * builds a flat FailedTest list, then computes newFailures by diffing
   * against the priorSnapshot.
   */
  private parseVitestJson(
    raw: {
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{
        name: string;
        assertionResults?: Array<{
          title: string;
          status: string;
          ancestorTitles?: string[];
          failureMessages?: string[];
        }>;
      }>;
    },
    rawLogPath: string,
    startedAt: number,
    exitCode: number,
  ): TestResult {
    const passed = raw.numPassedTests ?? 0;
    const failed = raw.numFailedTests ?? 0;
    const skipped = raw.numPendingTests ?? 0;
    const total = passed + failed + skipped;

    const failedTests: FailedTest[] = [];
    for (const file of raw.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') {
          const err = assertion.failureMessages?.[0] ?? '';
          failedTests.push({
            file: file.name,
            suite: (assertion.ancestorTitles ?? []).join(' > '),
            name: assertion.title,
            error: err,
            snippet: err.slice(0, 500),
          });
        }
      }
    }

    // Regression delta: a failure is "new" only if no test with the same
    // (file, name) was already failing before this cycle started. Tests that
    // were red on entry don't get attributed to the current cycle.
    const newFailures = this.priorSnapshot
      ? failedTests
          .filter(
            (t) =>
              !this.priorSnapshot!.failedTests.some(
                (p) => p.file === t.file && p.name === t.name,
              ),
          )
          .map((t) => `${t.file}::${t.name}`)
      : [];

    return {
      passed,
      failed,
      skipped,
      total,
      passRate: total > 0 ? passed / total : 0,
      durationMs: Date.now() - startedAt,
      failedTests,
      newFailures,
      rawOutputPath: rawLogPath,
      exitCode,
    };
  }
}
