import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealTestRunner, TestRunnerError, DEFAULT_CYCLE_CONFIG } from '@agentforge/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(
  __dirname,
  '../../../packages/core/src/autonomous/exec/__fixtures__/vitest-report.json',
);

function findOutputFileArg(args: string[]): string {
  const directIdx = args.findIndex((a) => a === '--outputFile');
  if (directIdx >= 0 && args[directIdx + 1]) return args[directIdx + 1]!;

  const commandLine = args[args.findIndex((a) => a.toLowerCase() === '/c') + 1];
  const match = commandLine?.match(/(?:^|\s)--outputFile\s+(?:"((?:\\"|[^"])*)"|(\S+))/);
  const outputFile = match ? (match[1]?.replace(/\\"/g, '"') ?? match[2] ?? null) : null;
  if (!outputFile) throw new Error('missing --outputFile arg');
  return outputFile;
}

function writeZeroTestReport(outputFile: string): void {
  writeFileSync(outputFile, JSON.stringify({
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [],
  }));
}

async function captureRunnerError(run: () => Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(TestRunnerError);
  return (thrown as Error).message;
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const findOutputFile = (args: string[]): string | null => {
    const directIdx = args.findIndex((a) => a === '--outputFile');
    if (directIdx >= 0) return args[directIdx + 1] ?? null;

    const commandLine = args[args.findIndex((a) => a.toLowerCase() === '/c') + 1];
    const match = commandLine?.match(/(?:^|\s)--outputFile\s+(?:"((?:\\"|[^"])*)"|(\S+))/);
    return match ? (match[1]?.replace(/\\"/g, '"') ?? match[2] ?? null) : null;
  };

  return {
    ...actual,
    execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
      // Simulate vitest producing an output file
      const outputFile = findOutputFile(args);
      if (outputFile) {
        const fixture = readFileSync(FIXTURE_PATH, 'utf8');
        writeFileSync(outputFile, fixture);
      }
      cb(null, { stdout: 'mock stdout', stderr: '' });
    }),
  };
});

describe('RealTestRunner (unit, mocked execFile)', () => {
  let tmpDir: string;
  const cycleId = 'test-rtr-cycle';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-rtr-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses vitest JSON report into TestResult', async () => {
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const result = await runner.run(cycleId);

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.passRate).toBeCloseTo(0.667, 2);
    expect(result.failedTests).toHaveLength(1);
    expect(result.failedTests[0]!.name).toBe('fails deliberately');
  });

  it('returns rawOutputPath pointing to saved log', async () => {
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const result = await runner.run(cycleId);
    expect(result.rawOutputPath).toContain(cycleId);
    expect(result.rawOutputPath).toMatch(/\.log$/);
  });

  it('computes newFailures against a prior snapshot', async () => {
    const priorSnapshot = {
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
      passRate: 1.0,
      durationMs: 1000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: '',
      exitCode: 0,
    };
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, priorSnapshot);
    const result = await runner.run(cycleId);
    expect(result.newFailures.length).toBeGreaterThan(0);
    expect(result.newFailures[0]).toContain('fails deliberately');
  });

  it('newFailures excludes pre-existing failures', async () => {
    const priorSnapshot = {
      passed: 2,
      failed: 1,
      skipped: 0,
      total: 3,
      passRate: 0.667,
      durationMs: 1000,
      failedTests: [
        {
          file: 'sample.test.ts',
          suite: 'sample',
          name: 'fails deliberately',
          error: 'old',
          snippet: 'old',
        },
      ],
      newFailures: [],
      rawOutputPath: '',
      exitCode: 1,
    };
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, priorSnapshot);
    const result = await runner.run(cycleId);
    expect(result.newFailures).toHaveLength(0);
  });

  it('throws TestRunnerError when output file missing', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
        const err = Object.assign(new Error('vitest exited before writing json'), {
          code: 1,
          stdout: '',
          stderr: 'reporter setup failed',
        });
        cb(err, { stdout: '', stderr: 'reporter setup failed' });
      },
    );
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const expectedSummaryPath = join(tmpDir, '.agentforge/cycles', cycleId, 'test-results.json');
    const message = await captureRunnerError(() => runner.run(cycleId));

    expect(message).toContain(expectedSummaryPath);
    expect(message).toContain('exit code 1');
    expect(message).toContain('Remediation:');
    expect(message).toContain('reporter setup failed');
  });

  it('throws actionable TestRunnerError when vitest collects zero tests', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
        writeZeroTestReport(findOutputFileArg(args));
        cb(null, { stdout: 'No test files found', stderr: '' });
      },
    );

    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const expectedSummaryPath = join(tmpDir, '.agentforge/cycles', cycleId, 'test-results.json');
    const message = await captureRunnerError(() => runner.run(cycleId));

    expect(message).toContain('Vitest JSON report collected zero tests');
    expect(message).toContain(expectedSummaryPath);
    expect(message).toContain('exit code 0');
    expect(message).toContain('Remediation:');
  });

  it('throws verify-gate diagnostics when the gate reports uncollected tests', async () => {
    const { execFile } = await import('node:child_process');
    const verifySummary = {
      mode: 'related',
      changedFileCount: 1,
      exitCode: 1,
      uncollectedTestFiles: ['tests/new-contract.test.ts'],
    };
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
        writeZeroTestReport(findOutputFileArg(args));
        const err = Object.assign(new Error('verify gate failed'), {
          code: 1,
          stdout: '',
          stderr: `[verify-gate] summary ${JSON.stringify(verifySummary)}`,
        });
        cb(err, { stdout: '', stderr: err.stderr });
      },
    );

    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const expectedSummaryPath = join(tmpDir, '.agentforge/cycles', cycleId, 'test-results.json');
    const message = await captureRunnerError(() => runner.run(cycleId));

    expect(message).toContain('Verify-gate reported uncollected tests');
    expect(message).toContain(expectedSummaryPath);
    expect(message).toContain('exit code 1');
    expect(message).toContain('tests/new-contract.test.ts');
    expect(message).toContain('Remediation:');
  });

  it('does not leak unattended cycle control env into the vitest process', async () => {
    const { execFile } = await import('node:child_process');
    const previous = process.env['AGENTFORGE_UNATTENDED'];
    process.env['AGENTFORGE_UNATTENDED'] = '1';

    try {
      const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
      await runner.run(cycleId);

      const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const [, , opts] = calls.at(-1)!;
      const env = (opts as { env: NodeJS.ProcessEnv }).env;
      expect(env['CI']).toBe('1');
      expect(env['NO_COLOR']).toBe('1');
      expect(env['AGENTFORGE_UNATTENDED']).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env['AGENTFORGE_UNATTENDED'];
      } else {
        process.env['AGENTFORGE_UNATTENDED'] = previous;
      }
    }
  });

  it('does not leak autonomous cycle-control env into the vitest process', async () => {
    const { execFile } = await import('node:child_process');
    const keys = [
      'AUTONOMOUS_EFFORT_CAP',
      'AUTONOMOUS_MODEL_CAP',
      'AUTONOMOUS_MAX_AGENTS',
      'AUTONOMOUS_CYCLE_ID',
      'AGENTFORGE_UNATTENDED',
      'AGENTFORGE_MAX_FAILED_CYCLES',
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));

    try {
      for (const key of keys) {
        process.env[key] = key === 'AUTONOMOUS_EFFORT_CAP' ? 'max' : 'cycle-control';
      }

      const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
      await runner.run(cycleId);

      const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const [, , opts] = calls.at(-1)!;
      const env = (opts as { env: NodeJS.ProcessEnv }).env;
      expect(env['CI']).toBe('1');
      expect(env['NO_COLOR']).toBe('1');
      for (const key of keys) {
        expect(env[key]).toBeUndefined();
      }
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
