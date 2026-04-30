import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealTestRunner, TestRunnerError } from '../../../packages/core/src/autonomous/exec/real-test-runner.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(
  __dirname,
  '../../../packages/core/src/autonomous/exec/__fixtures__/vitest-report.json',
);

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
        cb(null, { stdout: '', stderr: '' });
      },
    );
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    await expect(runner.run(cycleId)).rejects.toThrow(TestRunnerError);
  });
});
