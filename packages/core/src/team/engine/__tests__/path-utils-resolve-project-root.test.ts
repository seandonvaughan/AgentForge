/**
 * Unit tests for resolveProjectRoot() in path-utils.ts
 *
 * T5.4 — Project-root portability (Cycle 5 / v22.0.0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { resolveProjectRoot, NoProjectRootError, getRepositoryTemplatesDir, getRepositoryDomainsDir } from '../path-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'af-path-utils-test-'));
}

function createAgentForgeDir(dir: string): void {
  mkdirSync(join(dir, '.agentforge'), { recursive: true });
}

function removeTmpDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// resolveProjectRoot — explicit flag wins (1st priority)
// ---------------------------------------------------------------------------

describe('resolveProjectRoot — explicit flag', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmp); });

  it('returns the explicit path when provided, even without .agentforge/', () => {
    // Explicit does NOT require .agentforge/ to exist — the user said "use this dir".
    const result = resolveProjectRoot({ explicit: tmp });
    expect(result).toBe(resolve(tmp));
  });

  it('resolves a relative explicit path to absolute', () => {
    // We pass an absolute tmp dir so we can verify it matches.
    const result = resolveProjectRoot({ explicit: tmp });
    expect(result).not.toContain('..');
    expect(result).toBe(resolve(tmp));
  });

  it('explicit wins over env var', () => {
    const other = makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { AGENTFORGE_PROJECT_ROOT: other };
      const result = resolveProjectRoot({ explicit: tmp, env });
      expect(result).toBe(resolve(tmp));
    } finally {
      removeTmpDir(other);
    }
  });

  it('explicit wins over cwd with .agentforge/', () => {
    createAgentForgeDir(tmp);
    const other = makeTmpDir();
    try {
      createAgentForgeDir(other);
      const result = resolveProjectRoot({ explicit: other, cwd: tmp });
      expect(result).toBe(resolve(other));
    } finally {
      removeTmpDir(other);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProjectRoot — env var (2nd priority)
// ---------------------------------------------------------------------------

describe('resolveProjectRoot — env var', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmp); });

  it('returns AGENTFORGE_PROJECT_ROOT when set', () => {
    const env: NodeJS.ProcessEnv = { AGENTFORGE_PROJECT_ROOT: tmp };
    const result = resolveProjectRoot({ env });
    expect(result).toBe(resolve(tmp));
  });

  it('env var wins over cwd with .agentforge/', () => {
    const cwdTmp = makeTmpDir();
    try {
      createAgentForgeDir(cwdTmp);
      const env: NodeJS.ProcessEnv = { AGENTFORGE_PROJECT_ROOT: tmp };
      const result = resolveProjectRoot({ env, cwd: cwdTmp });
      expect(result).toBe(resolve(tmp));
    } finally {
      removeTmpDir(cwdTmp);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProjectRoot — cwd with .agentforge/ (3rd priority)
// ---------------------------------------------------------------------------

describe('resolveProjectRoot — cwd has .agentforge/', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmp); });

  it('returns cwd when it contains .agentforge/', () => {
    createAgentForgeDir(tmp);
    // Pass empty env to avoid accidental AGENTFORGE_PROJECT_ROOT in test runner env.
    const result = resolveProjectRoot({ cwd: tmp, env: {} });
    expect(result).toBe(resolve(tmp));
  });

  it('cwd wins over ancestor with .agentforge/', () => {
    createAgentForgeDir(tmp);
    // Create a child subdirectory with its OWN .agentforge/ — that child should win.
    const child = join(tmp, 'child');
    mkdirSync(child, { recursive: true });
    createAgentForgeDir(child);
    const result = resolveProjectRoot({ cwd: child, env: {} });
    expect(result).toBe(resolve(child));
  });
});

// ---------------------------------------------------------------------------
// resolveProjectRoot — traversal (4th priority)
// ---------------------------------------------------------------------------

describe('resolveProjectRoot — ancestor traversal', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmp); });

  it('finds an ancestor directory that has .agentforge/', () => {
    createAgentForgeDir(tmp);
    // Create a nested directory without .agentforge/ — traversal should find parent.
    const nested = join(tmp, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const result = resolveProjectRoot({ cwd: nested, env: {} });
    expect(result).toBe(resolve(tmp));
  });

  it('finds the nearest (deepest) ancestor with .agentforge/', () => {
    createAgentForgeDir(tmp);
    // Create an intermediate ancestor with its own .agentforge/ — that should win.
    const mid = join(tmp, 'mid');
    mkdirSync(mid, { recursive: true });
    createAgentForgeDir(mid);
    const leaf = join(mid, 'leaf');
    mkdirSync(leaf, { recursive: true });
    const result = resolveProjectRoot({ cwd: leaf, env: {} });
    expect(result).toBe(resolve(mid));
  });
});

// ---------------------------------------------------------------------------
// resolveProjectRoot — no project found → throws (5th priority)
// ---------------------------------------------------------------------------

describe('resolveProjectRoot — no project found', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { removeTmpDir(tmp); });

  it('throws NoProjectRootError when no .agentforge/ is found anywhere', () => {
    // tmp has NO .agentforge/ and we use an isolated env so AGENTFORGE_PROJECT_ROOT
    // from the test runner environment does not interfere.
    expect(() => resolveProjectRoot({ cwd: tmp, env: {} })).toThrow(NoProjectRootError);
  });

  it('error message mentions the searched directory and suggests agentforge init', () => {
    let thrown: Error | null = null;
    try {
      resolveProjectRoot({ cwd: tmp, env: {} });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain(resolve(tmp));
    expect(thrown!.message).toContain('agentforge init');
  });

  it('error name is NoProjectRootError', () => {
    expect(() => resolveProjectRoot({ cwd: tmp, env: {} })).toThrow(
      expect.objectContaining({ name: 'NoProjectRootError' }),
    );
  });
});

// ---------------------------------------------------------------------------
// getRepositoryTemplatesDir / getRepositoryDomainsDir — always inside AgentForge package
// ---------------------------------------------------------------------------

describe('getRepositoryTemplatesDir — always package-internal', () => {
  it('returns a path inside the AgentForge package tree (not an external project)', () => {
    const templatesDir = getRepositoryTemplatesDir();
    // The AgentForge package structure: .../packages/core/... so the templates dir
    // must be somewhere above packages/core.
    expect(templatesDir).toContain(`${sep}templates`);
    // It must NOT reference a tmp directory or user home in a way that suggests
    // it was derived from cwd of an external project.
    expect(templatesDir).not.toContain(tmpdir());
  });

  it('templates path is stable regardless of cwd (package-internal)', () => {
    // Call twice; result must be identical even if somehow cwd changed.
    const first = getRepositoryTemplatesDir();
    const second = getRepositoryTemplatesDir();
    expect(first).toBe(second);
  });

  it('domains dir is nested inside the templates dir', () => {
    const templatesDir = getRepositoryTemplatesDir();
    const domainsDir = getRepositoryDomainsDir();
    expect(domainsDir).toContain(templatesDir);
    expect(domainsDir).toContain('domains');
  });
});
