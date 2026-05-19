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
import { existsSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';
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

export function resolveCommandForExecFile(
  cmd: string,
  args: string[] = [],
  platform: NodeJS.Platform = process.platform,
  nodeExecPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecFileCommand {
  if (platform !== 'win32') return { command: cmd, args };

  const explicitExt = extname(cmd).toLowerCase();
  if (explicitExt === '.cmd' || explicitExt === '.bat') {
    return windowsBatchInvocation(cmd, args, env);
  }
  if (cmd.includes('/') || cmd.includes('\\') || explicitExt) {
    return { command: cmd, args };
  }

  const resolved = findWindowsCommand(cmd, nodeExecPath, env);
  if (resolved?.endsWith('.cmd') || resolved?.endsWith('.bat')) {
    return windowsBatchInvocation(resolved, args, env);
  }
  if (resolved) return { command: resolved, args };

  // Fall back to cmd.exe so PATHEXT can resolve package-manager shims.
  return windowsBatchInvocation(cmd, args, env);
}

export interface ResolvedExecFileCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function findWindowsCommand(
  cmd: string,
  nodeExecPath: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const nodeDir = dirname(nodeExecPath);
  const pathDirs = (env['PATH'] ?? env['Path'] ?? '')
    .split(delimiter)
    .filter(Boolean);
  const dirs = [nodeDir, ...pathDirs];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = join(dir, `${cmd}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function windowsBatchInvocation(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ResolvedExecFileCommand {
  return {
    command: env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', ['call', quoteWindowsCmdArg(cmd), ...args.map(quoteWindowsCmdArg)].join(' ')],
    windowsVerbatimArguments: true,
  };
}

function quoteWindowsCmdArg(value: string): string {
  if (/^[A-Za-z0-9._=:/\\~\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

/** Internal execFile-style signature used for dependency injection in tests. */
export type ExecFileAsyncFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    env: Record<string, string | undefined>;
    windowsVerbatimArguments?: boolean;
  },
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
      const invocation = resolveCommandForExecFile(parts[0]!, parts.slice(1));
      await execFn(invocation.command, invocation.args, {
        cwd,
        timeout: 5 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
      const invocation = resolveCommandForExecFile(parts[0]!, parts.slice(1));
      const result = await execFn(invocation.command, invocation.args, {
        cwd,
        timeout: 3 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
