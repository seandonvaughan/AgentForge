// packages/core/src/autonomous/pre-verify-typecheck.ts
//
// Reusable pre-verify typecheck function extracted from CycleRunner.defaultTypeCheck().
//
// Runs `testing.buildCommand` then `testing.typeCheckCommand` via execFile (not exec,
// so no shell injection surface). On either failure writes typecheck-failure.json
// via the logger so operators get rich error context in the dashboard.
//
// NOT wired into cycle-runner.ts here — that integration is handled by a separate task.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CycleConfig } from './types.js';
import type { CycleLogger } from './cycle-logger.js';
import { parseCommandArgs } from './cycle-runner.js';

const execFileAsync = promisify(execFile);

/** Result returned by runPreVerifyTypeCheck. */
export interface PreVerifyTypeCheckResult {
  buildOk: boolean;
  buildError?: string;
  typeCheckOk: boolean;
  typeCheckError?: string;
  /** Raw stdout from the tsc run (empty string when skipped). */
  typeCheckStdout: string;
  /** Raw stderr from the tsc run (empty string when skipped). */
  typeCheckStderr: string;
}

/**
 * Extract a useful error message + raw output from a failed execFileAsync call.
 * TypeScript writes errors to stdout, not stderr, so we keep both separately.
 */
function extractOutput(err: unknown): { stdout: string; stderr: string; message: string } {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stdout = (e.stdout?.toString() ?? '').trim();
  const stderr = (e.stderr?.toString() ?? '').trim();
  const message = (stderr || stdout || e.message || String(err)).slice(0, 2000);
  return { stdout, stderr, message };
}

/** Internal execFile-style signature used for dependency injection in tests. */
export type ExecFileAsyncFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number; env: Record<string, string | undefined> },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Run the pre-verify typecheck step: buildCommand then typeCheckCommand.
 *
 * On typecheck failure, writes `typecheck-failure.json` via logger.logTypecheckFailure()
 * so the dashboard can surface file + error context to the operator.
 *
 * @param cwd               Project root (passed to execFile as working directory).
 * @param testing           Testing config slice from CycleConfig.
 * @param logger            CycleLogger instance — used only to persist failure artifacts.
 * @param _execFileFn       Optional execFile replacement for unit tests. Omit in production.
 * @returns                 PreVerifyTypeCheckResult (never throws).
 */
export async function runPreVerifyTypeCheck(
  cwd: string,
  testing: CycleConfig['testing'],
  logger: CycleLogger,
  _execFileFn?: ExecFileAsyncFn,
): Promise<PreVerifyTypeCheckResult> {
  const execFn: ExecFileAsyncFn = _execFileFn ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts));
  // ── STEP 1: build ────────────────────────────────────────────────────────────
  let buildOk = true;
  let buildError: string | undefined;

  if (testing.buildCommand) {
    const parts = parseCommandArgs(testing.buildCommand);
    try {
      await execFn(parts[0]!, parts.slice(1), {
        cwd,
        timeout: 5 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });
    } catch (err: unknown) {
      buildOk = false;
      const out = extractOutput(err);
      buildError = out.message;
    }
  }

  // ── STEP 2: typecheck ────────────────────────────────────────────────────────
  let typeCheckOk = true;
  let typeCheckError: string | undefined;
  let typeCheckStdout = '';
  let typeCheckStderr = '';

  if (testing.typeCheckCommand) {
    const parts = parseCommandArgs(testing.typeCheckCommand);
    try {
      const result = await execFn(parts[0]!, parts.slice(1), {
        cwd,
        timeout: 3 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });
      // On success, result.stdout / result.stderr may still contain warnings.
      typeCheckStdout = (result.stdout?.toString() ?? '').trim();
      typeCheckStderr = (result.stderr?.toString() ?? '').trim();
    } catch (err: unknown) {
      typeCheckOk = false;
      const out = extractOutput(err);
      typeCheckError = out.message;
      typeCheckStdout = out.stdout;
      typeCheckStderr = out.stderr;

      // Persist rich failure artifact so the dashboard can show file/line context.
      // Collect changed files from the combined output (lines ending in .ts / .tsx).
      const combinedOutput = out.stdout || out.stderr;
      const changedFiles: string[] = [];
      for (const line of combinedOutput.split('\n')) {
        const trimmed = line.trim();
        // Use String.includes() for user-controlled input (CodeQL js/redos compliance).
        if (trimmed.includes('.ts') && (trimmed.endsWith('.ts') || trimmed.endsWith('.tsx') || trimmed.includes('.ts('))) {
          // Extract the file portion only — take the content up to the first '(' if present.
          const parenIdx = trimmed.indexOf('(');
          const candidate = parenIdx !== -1 ? trimmed.slice(0, parenIdx) : trimmed;
          if (!changedFiles.includes(candidate)) changedFiles.push(candidate);
        }
      }

      logger.logTypecheckFailure({
        stdout: out.stdout,
        stderr: out.stderr,
        files: changedFiles,
      });
    }
  }

  return {
    buildOk,
    ...(buildError !== undefined ? { buildError } : {}),
    typeCheckOk,
    ...(typeCheckError !== undefined ? { typeCheckError } : {}),
    typeCheckStdout,
    typeCheckStderr,
  };
}
