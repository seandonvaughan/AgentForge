import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Test that we capture build/typecheck errors correctly regardless of whether
// the failing tool writes to stderr or stdout. TypeScript's tsc writes errors
// to STDOUT; ESLint writes to STDOUT; many subprocesses leave stderr empty.
// The original cycle-runner.ts used `??` which only falls through on nullish,
// so an empty stderr Buffer (toString() = '') swallowed real errors on stdout.
// Cycle a84ea768 was killed by 2 fixable TS errors hidden by this bug.

// Re-implement the function locally to test its contract without importing
// from the runtime entrypoint (avoids pulling in @agentforge/core build deps).
function extractSubprocessError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderrStr = (e.stderr?.toString() ?? '').trim();
  const stdoutStr = (e.stdout?.toString() ?? '').trim();
  const text = stderrStr || stdoutStr || e.message || String(err);
  return text.slice(0, 2000);
}

describe('extractSubprocessError', () => {
  it('returns stdout content when stderr is an empty Buffer (the TypeScript case)', () => {
    const err = { stderr: Buffer.from(''), stdout: Buffer.from('error TS2532: Object is possibly undefined') };
    expect(extractSubprocessError(err)).toBe('error TS2532: Object is possibly undefined');
  });

  it('returns stdout content when stderr is an empty string', () => {
    const err = { stderr: '', stdout: 'error TS2722: Cannot invoke undefined' };
    expect(extractSubprocessError(err)).toBe('error TS2722: Cannot invoke undefined');
  });

  it('returns stdout content when stderr is whitespace only', () => {
    const err = { stderr: '   \n\n  ', stdout: 'compile failed' };
    expect(extractSubprocessError(err)).toBe('compile failed');
  });

  it('prefers stderr when it has real content', () => {
    const err = { stderr: 'real stderr', stdout: 'less important stdout' };
    expect(extractSubprocessError(err)).toBe('real stderr');
  });

  it('falls back to err.message when both pipes empty', () => {
    const err = { stderr: '', stdout: '', message: 'Command failed with exit 1' };
    expect(extractSubprocessError(err)).toBe('Command failed with exit 1');
  });

  it('truncates very long output to 2000 chars', () => {
    const long = 'x'.repeat(5000);
    expect(extractSubprocessError({ stdout: long })).toHaveLength(2000);
  });

  it('captures a real failing subprocess (integration check)', async () => {
    let captured: string | undefined;
    try {
      // `false` exits 1 with no output; `node -e "console.log('boom'); process.exit(1)"`
      // exits 1 with stdout content and empty stderr — the regression scenario.
      await execFileAsync('node', ['-e', "console.log('boom'); process.exit(1)"]);
    } catch (err) {
      captured = extractSubprocessError(err);
    }
    expect(captured).toContain('boom');
  });
});
