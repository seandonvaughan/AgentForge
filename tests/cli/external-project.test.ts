/**
 * CLI integration test — AgentForge scanner against an external project
 *
 * T5.4 (Cycle 5 / v22.0.0) — Project-root portability
 *
 * These tests verify that:
 *  1. `runFullScan(projectRoot)` walks the EXTERNAL project, not the AgentForge monorepo
 *  2. `resolveProjectRoot()` correctly finds the external project root
 *  3. Template paths stay inside the AgentForge installation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runFullScan, resolveProjectRoot, NoProjectRootError, getRepositoryTemplatesDir } from '@agentforge/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupExternalProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-ext-project-test-'));

  // Minimal project structure
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.agentforge'), { recursive: true });

  // Write a sample TypeScript file specific to this external project
  writeFileSync(
    join(root, 'src', 'widget.ts'),
    `// External project widget\nexport function buildWidget(name: string): string {\n  return \`widget:\${name}\`;\n}\n`,
  );
  writeFileSync(
    join(root, 'src', 'index.ts'),
    `export { buildWidget } from './widget.js';\n`,
  );

  // package.json for the external project
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'my-external-project', version: '0.1.0', type: 'module' }, null, 2),
  );

  // Minimal .agentforge/team.yaml placeholder
  writeFileSync(
    join(root, '.agentforge', 'team.yaml'),
    'name: my-external-project\nagents: {}\n',
  );

  // git init so git-analyzer does not throw
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'pipe' });
  } catch { /* git may not be available in all CI environments */ }

  return root;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let externalRoot: string;

beforeAll(() => {
  externalRoot = setupExternalProject();
});

afterAll(() => {
  try { rmSync(externalRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Test 1: scanner walks the external project, not the AgentForge monorepo
// ---------------------------------------------------------------------------

describe('runFullScan against external project root', () => {
  it('scan result contains files from the external project', async () => {
    const result = await runFullScan(externalRoot);
    // The external project has src/widget.ts and src/index.ts
    const filePaths = result.files.files.map(f => f.file_path);
    const hasWidget = filePaths.some(p => p.includes('widget'));
    expect(hasWidget).toBe(true);
  });

  it('scan result does NOT contain files from the AgentForge monorepo', async () => {
    const result = await runFullScan(externalRoot);
    const filePaths = result.files.files.map(f => f.file_path);
    // AgentForge-specific files should not appear
    const hasMonorepoFile = filePaths.some(p =>
      p.includes('packages/core') ||
      p.includes('packages/server') ||
      p.includes('packages/cli'),
    );
    expect(hasMonorepoFile).toBe(false);
  });

  it('file paths in scan result are relative to the external project root', async () => {
    const result = await runFullScan(externalRoot);
    const filePaths = result.files.files.map(f => f.file_path);
    // Relative paths must not point into the AgentForge monorepo
    for (const fp of filePaths) {
      expect(fp).not.toMatch(/packages\/core/);
      expect(fp).not.toMatch(/packages\/server/);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: resolveProjectRoot finds external project
// ---------------------------------------------------------------------------

describe('resolveProjectRoot with external project', () => {
  it('explicit path returns the external project root', () => {
    const resolved = resolveProjectRoot({ explicit: externalRoot });
    expect(resolved).toBe(resolve(externalRoot));
  });

  it('cwd pointing to external project (with .agentforge/) returns it', () => {
    const resolved = resolveProjectRoot({ cwd: externalRoot, env: {} });
    expect(resolved).toBe(resolve(externalRoot));
  });

  it('subdirectory of external project traverses upward to find .agentforge/', () => {
    const subdir = join(externalRoot, 'src');
    const resolved = resolveProjectRoot({ cwd: subdir, env: {} });
    expect(resolved).toBe(resolve(externalRoot));
  });

  it('throws NoProjectRootError for a completely unrelated tmp dir', () => {
    const unrelated = mkdtempSync(join(tmpdir(), 'af-unrelated-'));
    try {
      expect(() => resolveProjectRoot({ cwd: unrelated, env: {} })).toThrow(NoProjectRootError);
    } finally {
      try { rmSync(unrelated, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: template path stays inside AgentForge package regardless of project root
// ---------------------------------------------------------------------------

describe('getRepositoryTemplatesDir — stable regardless of external project', () => {
  it('templates dir does not point into the external project', () => {
    const templatesDir = getRepositoryTemplatesDir();
    expect(templatesDir).not.toContain(externalRoot);
  });

  it('templates dir is inside the AgentForge package tree', () => {
    const templatesDir = getRepositoryTemplatesDir();
    // The AgentForge packages root is determined by import.meta.url in path-utils.
    // We just verify it contains the expected "templates" segment.
    expect(templatesDir).toMatch(/templates/);
  });
});
