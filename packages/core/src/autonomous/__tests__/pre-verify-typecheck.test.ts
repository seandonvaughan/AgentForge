// packages/core/src/autonomous/__tests__/pre-verify-typecheck.test.ts
//
// Unit tests for runPreVerifyTypeCheck() and CycleLogger.logTypecheckFailure().
//
// Strategy:
//   - CycleLogger tests: real filesystem writes in a temp dir.
//   - runPreVerifyTypeCheck tests: inject a fake execFileFn so no real subprocesses
//     are spawned and no child_process mocking is needed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { ExecFileAsyncFn } from '../pre-verify-typecheck.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'pre-verify-test-'));
}

function cycleDir(root: string, cycleId: string): string {
  return join(root, '.agentforge', 'cycles', cycleId);
}

function makeTestingConfig(overrides?: Partial<{ buildCommand: string; typeCheckCommand: string }>) {
  return {
    command: 'pnpm exec vitest run',
    timeoutMinutes: 20,
    reporter: 'json',
    saveRawLog: false,
    buildCommand: '',
    typeCheckCommand: '',
    ...overrides,
  };
}

/** Fake execFn that always resolves (simulates a successful command). */
const okExecFn: ExecFileAsyncFn = async () => ({ stdout: '', stderr: '' });

/** Build a fake execFn that fails on the nth call (1-indexed). */
function failOnCall(n: number, stdout: string, stderr = ''): ExecFileAsyncFn {
  let calls = 0;
  return async () => {
    calls++;
    if (calls === n) {
      const err = Object.assign(new Error('process exited non-zero'), { stdout, stderr, code: 1 });
      throw err;
    }
    return { stdout: '', stderr: '' };
  };
}

// ---------------------------------------------------------------------------
// CycleLogger.logTypecheckFailure
// ---------------------------------------------------------------------------

describe('CycleLogger.logTypecheckFailure', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = tmpDir();
    mkdirSync(join(cycleDir(tmp, 'test-cycle-id'), 'phases'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes typecheck-failure.json with expected shape', async () => {
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'test-cycle-id');

    const stdout = "src/foo.ts(12,3): error TS2304: Cannot find name 'bar'.\n";
    logger.logTypecheckFailure({ stdout, stderr: '', files: ['src/foo.ts'] });

    const artifactPath = join(cycleDir(tmp, 'test-cycle-id'), 'typecheck-failure.json');
    expect(existsSync(artifactPath)).toBe(true);

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
      stdout: string;
      stderr: string;
      files: string[];
      firstError: { file: string; line: number; message: string } | null;
      capturedAt: string;
    };

    expect(artifact.stdout).toBe(stdout);
    expect(artifact.stderr).toBe('');
    expect(artifact.files).toEqual(['src/foo.ts']);
    expect(artifact.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('extracts firstError.file and firstError.line from stdout', async () => {
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'test-cycle-id');

    const stdout = "packages/core/src/foo.ts(42,7): error TS2345: Argument of type X is not assignable.\n";
    logger.logTypecheckFailure({ stdout, stderr: '', files: [] });

    const artifact = JSON.parse(
      readFileSync(join(cycleDir(tmp, 'test-cycle-id'), 'typecheck-failure.json'), 'utf-8'),
    ) as { firstError: { file: string; line: number; message: string } | null };

    expect(artifact.firstError).not.toBeNull();
    expect(artifact.firstError!.file).toBe('packages/core/src/foo.ts');
    expect(artifact.firstError!.line).toBe(42);
    expect(artifact.firstError!.message).toContain('Argument of type X');
  });

  it('falls back to stderr when stdout has no tsc error pattern', async () => {
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'test-cycle-id');

    const stderr = "src/bar.ts(5,1): error TS1005: ';' expected.\n";
    logger.logTypecheckFailure({ stdout: 'no errors here', stderr, files: [] });

    const artifact = JSON.parse(
      readFileSync(join(cycleDir(tmp, 'test-cycle-id'), 'typecheck-failure.json'), 'utf-8'),
    ) as { firstError: { file: string; line: number; message: string } | null };

    expect(artifact.firstError).not.toBeNull();
    expect(artifact.firstError!.file).toBe('src/bar.ts');
    expect(artifact.firstError!.line).toBe(5);
  });

  it('sets firstError to null when neither stdout nor stderr contains a tsc error', async () => {
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'test-cycle-id');

    logger.logTypecheckFailure({ stdout: 'something went wrong', stderr: '', files: [] });

    const artifact = JSON.parse(
      readFileSync(join(cycleDir(tmp, 'test-cycle-id'), 'typecheck-failure.json'), 'utf-8'),
    ) as { firstError: null };

    expect(artifact.firstError).toBeNull();
  });

  it('emits a typecheck.failure event to events.jsonl', async () => {
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'test-cycle-id');

    logger.logTypecheckFailure({ stdout: 'src/x.ts(1,1): error TS0001: x', stderr: '', files: [] });

    const eventsPath = join(cycleDir(tmp, 'test-cycle-id'), 'events.jsonl');
    const lines = readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
    const typecheckEvents = lines
      .map((l) => JSON.parse(l) as { type: string })
      .filter((e) => e.type === 'typecheck.failure');

    expect(typecheckEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// runPreVerifyTypeCheck
// ---------------------------------------------------------------------------

describe('runPreVerifyTypeCheck', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = tmpDir();
    mkdirSync(join(cycleDir(tmp, 'tc-cycle'), 'phases'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns buildOk=true and typeCheckOk=true when commands are empty (skipped)', async () => {
    const { runPreVerifyTypeCheck } = await import('../pre-verify-typecheck.js');
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'tc-cycle');

    const result = await runPreVerifyTypeCheck(
      tmp,
      makeTestingConfig({ buildCommand: '', typeCheckCommand: '' }),
      logger,
      okExecFn,
    );

    expect(result.buildOk).toBe(true);
    expect(result.typeCheckOk).toBe(true);
    expect(result.buildError).toBeUndefined();
    expect(result.typeCheckError).toBeUndefined();
  });

  it('returns buildOk=true and typeCheckOk=true when both commands succeed', async () => {
    const { runPreVerifyTypeCheck } = await import('../pre-verify-typecheck.js');
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'tc-cycle');

    const result = await runPreVerifyTypeCheck(
      tmp,
      makeTestingConfig({ buildCommand: 'pnpm build', typeCheckCommand: 'pnpm exec tsc --noEmit' }),
      logger,
      okExecFn,
    );

    expect(result.buildOk).toBe(true);
    expect(result.typeCheckOk).toBe(true);
  });

  it('returns typeCheckOk=false and writes typecheck-failure.json when typecheck fails', async () => {
    const { runPreVerifyTypeCheck } = await import('../pre-verify-typecheck.js');
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'tc-cycle');

    // Build is call 1 (succeeds), typecheck is call 2 (fails).
    const execFn = failOnCall(2, "src/index.ts(3,5): error TS2304: Cannot find name 'Foo'.\n");

    const result = await runPreVerifyTypeCheck(
      tmp,
      makeTestingConfig({ buildCommand: 'pnpm build', typeCheckCommand: 'pnpm exec tsc --noEmit' }),
      logger,
      execFn,
    );

    expect(result.buildOk).toBe(true);
    expect(result.typeCheckOk).toBe(false);
    expect(result.typeCheckError).toBeTruthy();

    const artifactPath = join(cycleDir(tmp, 'tc-cycle'), 'typecheck-failure.json');
    expect(existsSync(artifactPath)).toBe(true);

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
      firstError: { file: string; line: number } | null;
    };
    expect(artifact.firstError).not.toBeNull();
    expect(artifact.firstError!.file).toBe('src/index.ts');
    expect(artifact.firstError!.line).toBe(3);
  });

  it('deduplicates repeated TS2554 callsite errors for the same file in typecheck artifacts', async () => {
    const { runPreVerifyTypeCheck } = await import('../pre-verify-typecheck.js');
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'tc-cycle');

    const stdout = [
      'packages/server/src/routes/search.ts(81,18): error TS2554: Expected 4 arguments, but got 3.',
      'packages/server/src/routes/search.ts(134,24): error TS2554: Expected 4 arguments, but got 3.',
      'packages/server/src/routes/search.ts(205,29): error TS2554: Expected 4 arguments, but got 3.',
      'packages/core/src/autonomous/cycle-runner.ts(55,9): error TS2322: Type string is not assignable to number.',
    ].join('\n');

    const execFn = failOnCall(1, stdout);

    const result = await runPreVerifyTypeCheck(
      tmp,
      makeTestingConfig({ buildCommand: '', typeCheckCommand: 'pnpm exec tsc --noEmit' }),
      logger,
      execFn,
    );

    expect(result.typeCheckOk).toBe(false);

    const artifactPath = join(cycleDir(tmp, 'tc-cycle'), 'typecheck-failure.json');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
      files: string[];
      firstError: { file: string; line: number } | null;
    };

    expect(artifact.firstError).toMatchObject({
      file: 'packages/server/src/routes/search.ts',
      line: 81,
    });
    expect(artifact.files).toEqual([
      'packages/server/src/routes/search.ts',
      'packages/core/src/autonomous/cycle-runner.ts',
    ]);
  });

  it('does NOT write typecheck-failure.json when typecheck succeeds', async () => {
    const { runPreVerifyTypeCheck } = await import('../pre-verify-typecheck.js');
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'tc-cycle');

    await runPreVerifyTypeCheck(
      tmp,
      makeTestingConfig({ typeCheckCommand: 'pnpm exec tsc --noEmit' }),
      logger,
      okExecFn,
    );

    const artifactPath = join(cycleDir(tmp, 'tc-cycle'), 'typecheck-failure.json');
    expect(existsSync(artifactPath)).toBe(false);
  });

  it('returns buildOk=false when build command fails', async () => {
    const { runPreVerifyTypeCheck } = await import('../pre-verify-typecheck.js');
    const { CycleLogger } = await import('../cycle-logger.js');
    const logger = new CycleLogger(tmp, 'tc-cycle');

    // Build is call 1 (fails).
    const execFn = failOnCall(1, 'Build error output');

    const result = await runPreVerifyTypeCheck(
      tmp,
      makeTestingConfig({ buildCommand: 'pnpm build', typeCheckCommand: '' }),
      logger,
      execFn,
    );

    expect(result.buildOk).toBe(false);
    expect(result.buildError).toBeTruthy();
    expect(result.typeCheckOk).toBe(true); // typecheck was skipped (no command)
  });
});

describe('resolveCommandForExecFile', () => {
  it('wraps Windows Node shims with cmd.exe for execFile', async () => {
    const { resolveCommandForExecFile } = await import('../pre-verify-typecheck.js');
    const tmp = tmpDir();
    try {
      writeFileSync(join(tmp, 'corepack.cmd'), '@echo off\n');
      const resolved = resolveCommandForExecFile('corepack', ['pnpm', 'build'], 'win32', join(tmp, 'node.exe'), { ComSpec: 'cmd.exe' });
      expect(resolved.command).toBe('cmd.exe');
      expect(resolved.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(resolved.args[3]).toContain('call');
      expect(resolved.args[3]).toContain('corepack.cmd');
      expect(resolved.args[3]).toContain('pnpm');
      expect(resolved.args[3]).toContain('build');
      expect(resolved.windowsVerbatimArguments).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves POSIX commands unchanged', async () => {
    const { resolveCommandForExecFile } = await import('../pre-verify-typecheck.js');
    expect(resolveCommandForExecFile('corepack', ['pnpm'], 'linux', '/usr/bin/node')).toEqual({
      command: 'corepack',
      args: ['pnpm'],
    });
  });

  const winIt = process.platform === 'win32' ? it : it.skip;

  winIt('executes resolved .cmd shims through cmd.exe on Windows', async () => {
    const { resolveCommandForExecFile } = await import('../pre-verify-typecheck.js');
    const tmp = tmpDir();
    try {
      writeFileSync(join(tmp, 'fake-shim.cmd'), '@echo off\necho ok %1 %2\n');
      const resolved = resolveCommandForExecFile('fake-shim', ['one', 'two'], 'win32', join(tmp, 'node.exe'), { ComSpec: process.env['ComSpec'] });

      const result = await execFile(resolved.command, resolved.args, {
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });

      expect(result.stdout.toString().trim()).toBe('ok one two');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
