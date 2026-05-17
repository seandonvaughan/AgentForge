/**
 * Demo command tests — `agentforge demo --project <path>`
 *
 * Tests the full runDemo() flow against a minimal tmp git repo so we can
 * verify: scan ran, corpus built, forge succeeded, team.yaml exists, exit 0.
 *
 * Strategy: use a real temp directory with `git init` + minimal source files
 * so the legacy scan/corpus/forge pipeline runs end-to-end without any LLM
 * calls (the demo command always uses strategy:'legacy').
 *
 * The heavier scan/forge calls are fast against a near-empty project and do
 * not require any network access.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDemo } from '../src/commands/demo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal git-initialised project in a temp directory.
 * Returns the absolute path.
 */
function createGitProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agentforge-demo-test-${name}-`));

  // git init (bare minimum, no user config needed for the scan)
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });

  // Add a few source files so the scanner has something to analyse
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'demo-test-project',
    version: '1.0.0',
    description: 'Minimal project for demo smoke test',
  }, null, 2));

  writeFileSync(join(dir, 'index.ts'), [
    '// Entry point',
    'export function hello(name: string): string {',
    "  return `Hello, ${name}!`;",
    '}',
  ].join('\n'));

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'util.ts'), [
    '// Utility module',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
  ].join('\n'));

  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022' },
  }, null, 2));

  return dir;
}

/**
 * Create a temp directory WITHOUT a .git folder.
 */
function createNonGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-demo-test-nogit-'));
  writeFileSync(join(dir, 'README.md'), '# Not a git repo\n');
  return dir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let consoleLog: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

const tmpDirs: string[] = [];

function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleLog.mockRestore();
  consoleError.mockRestore();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Helper: collect console.log output
// ---------------------------------------------------------------------------

function logOutput(): string {
  return consoleLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function errOutput(): string {
  return consoleError.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('demo command — valid git project', () => {
  it('returns exit code 0 on success', async () => {
    const dir = trackDir(createGitProject('exit0'));
    const code = await runDemo({ project: dir });
    expect(code).toBe(0);
  }, 30_000);

  it('prints the project path in the header', async () => {
    const dir = trackDir(createGitProject('header'));
    await runDemo({ project: dir });
    expect(logOutput()).toContain(dir);
  }, 30_000);

  it('reports scan summary with file count', async () => {
    const dir = trackDir(createGitProject('scan-summary'));
    await runDemo({ project: dir });
    const out = logOutput();
    // Should contain something like "3 files, N subsystems, primary language: TypeScript"
    expect(out).toMatch(/\d+ files,\s+\d+ subsystems,\s+primary language:/i);
  }, 30_000);

  it('reports corpus file and char counts', async () => {
    const dir = trackDir(createGitProject('corpus'));
    await runDemo({ project: dir });
    const out = logOutput();
    expect(out).toMatch(/\d+ files,\s+\d+ chars chosen/i);
  }, 30_000);

  it('writes .agentforge/team.yaml and reports agent count', async () => {
    const dir = trackDir(createGitProject('team-yaml'));
    const code = await runDemo({ project: dir });

    expect(code).toBe(0);
    expect(existsSync(join(dir, '.agentforge', 'team.yaml'))).toBe(true);

    // Output should contain "N agents generated"
    const out = logOutput();
    expect(out).toMatch(/\d+ agents generated/i);
  }, 30_000);

  it('prints sample agent IDs when agents are generated', async () => {
    const dir = trackDir(createGitProject('sample-ids'));
    await runDemo({ project: dir });
    const out = logOutput();
    // Should list sample IDs
    expect(out).toMatch(/Sample agent IDs:/i);
  }, 30_000);

  it('prints the completion message with cycle hint', async () => {
    const dir = trackDir(createGitProject('completion'));
    await runDemo({ project: dir });
    const out = logOutput();
    expect(out).toContain('Demo complete.');
    expect(out).toContain('agentforge cycle');
  }, 30_000);
});

describe('demo command — --legacy flag', () => {
  it('returns exit code 0 with --legacy flag', async () => {
    const dir = trackDir(createGitProject('legacy'));
    const code = await runDemo({ project: dir, legacy: true });
    expect(code).toBe(0);
  }, 30_000);

  it('writes team.yaml when --legacy is set', async () => {
    const dir = trackDir(createGitProject('legacy-yaml'));
    await runDemo({ project: dir, legacy: true });
    expect(existsSync(join(dir, '.agentforge', 'team.yaml'))).toBe(true);
  }, 30_000);
});

describe('demo command — missing .git directory', () => {
  it('returns exit code 1 when no .git directory present', async () => {
    const dir = trackDir(createNonGitDir());
    const code = await runDemo({ project: dir });
    expect(code).toBe(1);
  });

  it('prints a clear error message about missing .git', async () => {
    const dir = trackDir(createNonGitDir());
    await runDemo({ project: dir });
    const err = errOutput();
    expect(err).toMatch(/not a git repository/i);
    expect(err).toContain('.git');
  });
});

describe('demo command — non-existent path', () => {
  it('returns exit code 1 for a non-existent project path', async () => {
    const code = await runDemo({ project: '/tmp/this-path-absolutely-does-not-exist-agentforge-test' });
    expect(code).toBe(1);
  });

  it('prints a clear error about the missing path', async () => {
    await runDemo({ project: '/tmp/this-path-absolutely-does-not-exist-agentforge-test' });
    const err = errOutput();
    expect(err).toMatch(/does not exist/i);
  });
});
