// packages/core/src/autonomous/__tests__/pre-verify-typecheck.test.ts
//
// Unit tests for runPreVerifyTypeCheck() and CycleLogger.logTypecheckFailure().
//
// Strategy:
//   - CycleLogger tests: real filesystem writes in a temp dir.
//   - runPreVerifyTypeCheck tests: inject a fake execFileFn so no real subprocesses
//     are spawned and no child_process mocking is needed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecFileAsyncFn } from '../pre-verify-typecheck.js';

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
