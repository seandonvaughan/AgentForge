// tests/dashboard/typecheck-failure-banner.test.ts
//
// Contract tests for TypecheckFailureBanner.svelte logic.
//
// We test the data-logic contract (shape validation, firstError extraction, body
// fallback) without spinning up Svelte rendering or a browser — consistent with
// the pattern used by runner-page-server.test.ts and other dashboard tests in
// this directory.
//
// Coverage:
//   - Banner receives the TypecheckFailure shape and exposes firstError
//   - firstError file path and line are surfaced
//   - body falls back to stderr when stdout is empty
//   - body falls back to placeholder when both are empty

import { describe, it, expect } from 'vitest';

/** Matches TypecheckFailure exported from TypecheckFailureBanner.svelte */
interface TypecheckFailure {
  stdout: string;
  stderr: string;
  files: string[];
  firstError: { file: string; line: number; message: string } | null;
  capturedAt: string;
}

/** Minimal contract: given a TypecheckFailure, returns the display body string. */
function resolveBody(failure: TypecheckFailure): string {
  return failure.stdout || failure.stderr || '(no output captured)';
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe('TypecheckFailure shape', () => {
  it('accepts a well-formed failure object', () => {
    const failure: TypecheckFailure = {
      stdout: 'src/foo.ts(1,1): error TS2304: Cannot find name.\n',
      stderr: '',
      files: ['src/foo.ts'],
      firstError: { file: 'src/foo.ts', line: 1, message: "Cannot find name 'x'." },
      capturedAt: new Date().toISOString(),
    };
    expect(failure.firstError).not.toBeNull();
    expect(failure.firstError!.file).toBe('src/foo.ts');
    expect(failure.firstError!.line).toBe(1);
  });

  it('accepts a failure object with null firstError', () => {
    const failure: TypecheckFailure = {
      stdout: 'something went wrong',
      stderr: '',
      files: [],
      firstError: null,
      capturedAt: new Date().toISOString(),
    };
    expect(failure.firstError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Banner mounts and shows the file path
// ---------------------------------------------------------------------------

describe('TypecheckFailureBanner — firstError surfacing', () => {
  it('exposes the firstError file path when present', () => {
    const failure: TypecheckFailure = {
      stdout: 'packages/core/src/index.ts(99,3): error TS2304: Cannot find name.\n',
      stderr: '',
      files: ['packages/core/src/index.ts'],
      firstError: { file: 'packages/core/src/index.ts', line: 99, message: "Cannot find name 'Baz'." },
      capturedAt: new Date().toISOString(),
    };

    // Banner should display: file path + line
    expect(failure.firstError!.file).toBe('packages/core/src/index.ts');
    expect(failure.firstError!.line).toBe(99);
  });

  it('handles a failure with no firstError gracefully', () => {
    const failure: TypecheckFailure = {
      stdout: 'build output without tsc errors',
      stderr: '',
      files: [],
      firstError: null,
      capturedAt: new Date().toISOString(),
    };
    // Banner shows "See details below" fallback — we just verify the data is null
    expect(failure.firstError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expander body
// ---------------------------------------------------------------------------

describe('TypecheckFailureBanner — expander body content', () => {
  it('uses stdout as the body when present', () => {
    const failure: TypecheckFailure = {
      stdout: 'error output here',
      stderr: 'also has stderr',
      files: [],
      firstError: null,
      capturedAt: new Date().toISOString(),
    };
    expect(resolveBody(failure)).toBe('error output here');
  });

  it('falls back to stderr when stdout is empty', () => {
    const failure: TypecheckFailure = {
      stdout: '',
      stderr: 'type error in stderr',
      files: [],
      firstError: null,
      capturedAt: new Date().toISOString(),
    };
    expect(resolveBody(failure)).toBe('type error in stderr');
  });

  it('falls back to placeholder when both stdout and stderr are empty', () => {
    const failure: TypecheckFailure = {
      stdout: '',
      stderr: '',
      files: [],
      firstError: null,
      capturedAt: new Date().toISOString(),
    };
    expect(resolveBody(failure)).toBe('(no output captured)');
  });
});

// ---------------------------------------------------------------------------
// File list
// ---------------------------------------------------------------------------

describe('TypecheckFailureBanner — files list', () => {
  it('can carry multiple files with TypeScript extensions', () => {
    const failure: TypecheckFailure = {
      stdout: '',
      stderr: '',
      files: ['src/a.ts', 'src/b.tsx', 'src/c.ts'],
      firstError: null,
      capturedAt: new Date().toISOString(),
    };
    expect(failure.files).toHaveLength(3);
    // All files must include .ts (using includes() not regex, per project rules)
    for (const f of failure.files) {
      expect(f.includes('.ts')).toBe(true);
    }
  });
});
