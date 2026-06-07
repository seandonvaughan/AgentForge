// Acceptance-run fixes (cycle 11955f95): AgentForge must run epic children in
// FOREIGN repositories with zero config. Three bugs failed 4/4 children there:
//   (a) child-verify hardcoded `corepack pnpm exec ...` → typecheck exited 1
//       in an npm repo before the child's code was even considered;
//   (b) the item prompt told agents to use `corepack pnpm` and never to use
//       `npx`, inside an npm project;
//   (c) the item prompt never listed the item's declared files while the
//       deterministic verifier fails ANY out-of-scope edit — children
//       innocently touched the shared barrel (src/index.ts) and were failed.
// These tests pin the repo-neutral behavior: lockfile-detected toolchain and
// an explicit declared-scope section.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectPackageCommands,
  verifyChildWorktree,
  type ChildVerifyCommandResult,
} from '../child-verify.js';
import { buildItemPrompt } from '../execute-phase.js';

/** The (module-local) SprintItem shape buildItemPrompt accepts. */
type PromptItem = Parameters<typeof buildItemPrompt>[0];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-repo-neutral-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectPackageCommands', () => {
  it('pnpm-lock.yaml → corepack pnpm commands (AgentForge-style workspace)', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const d = detectPackageCommands(dir);
    expect(d.packageManager).toBe('pnpm');
    // No --noEmit: tsc -b --noEmit fails TS6310 on project-reference repos.
    expect(d.typeCheckCommand).toBe('corepack pnpm exec tsc -b --pretty false');
    expect(d.testCommand).toBe('corepack pnpm exec vitest');
  });

  it('yarn.lock → yarn commands', () => {
    writeFileSync(join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
    const d = detectPackageCommands(dir);
    expect(d.packageManager).toBe('yarn');
    expect(d.typeCheckCommand).toBe('yarn tsc --noEmit --pretty false');
    expect(d.testCommand).toBe('yarn vitest');
  });

  it('no lockfile (npm / package-lock.json) → npx commands', () => {
    const d = detectPackageCommands(dir);
    expect(d.packageManager).toBe('npm');
    expect(d.typeCheckCommand).toBe('npx tsc --noEmit --pretty false');
    expect(d.testCommand).toBe('npx vitest');
    expect(d.toolingNote).toContain('npx');
  });
});

describe('verifyChildWorktree — lockfile-detected default commands', () => {
  it('runs npx (not corepack pnpm) in an npm worktree', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    const result = await verifyChildWorktree({
      worktreePath: dir, // no lockfile → npm
      changedFiles: ['src/budget.ts', 'tests/budget.test.ts'],
      declaredFiles: ['src/budget.ts', 'tests/budget.test.ts'],
      runner,
    });
    expect(result.ok).toBe(true);
    // First call = typecheck, second = scoped vitest related run.
    expect(calls[0]).toEqual({
      cmd: 'npx',
      args: ['tsc', '--noEmit', '--pretty', 'false'],
    });
    expect(calls[1]?.cmd).toBe('npx');
    expect(calls[1]?.args.slice(0, 3)).toEqual(['vitest', 'related', '--run']);
  });

  it('pnpm worktree without node_modules: installs deps FIRST, then runs the toolchain', async () => {
    // Cycle cbe1ec58: a fresh pnpm worktree has no node_modules, so pnpm exec
    // failed with "Command tsc not found" for all 22 children. The bar now
    // provisions dependencies before the toolchain checks.
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    const result = await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({
      cmd: 'corepack',
      args: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
    });
    expect(calls[1]?.cmd).toBe('corepack');
    expect(calls[1]?.args.slice(0, 2)).toEqual(['pnpm', 'exec']);
  });

  it('pnpm worktree with a COMPLETED install (.modules.yaml marker): no install call', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), 'installed\n');
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
    });
    expect(calls[0]?.args).not.toContain('install');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['pnpm', 'exec']);
  });

  it('PARTIAL node_modules without the completion marker → install runs anyway', async () => {
    // Cycle 72b6b50e: pooled worktrees reused from a killed run carried partial
    // node_modules (no .bin links); a bare directory-existence check skipped
    // provisioning and pnpm exec still failed "tsc not found".
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    mkdirSync(join(dir, 'node_modules', 'half-installed-pkg'), { recursive: true });
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
    });
    expect(calls[0]?.args.slice(0, 2)).toEqual(['pnpm', 'install']);
  });

  it('install failure → single structured deps failure, toolchain not attempted', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: false, code: 1, output: 'ERR_PNPM_NO_OFFLINE store miss' };
    };
    const result = await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.check).toBe('deps');
    expect(result.failures[0]?.message).toContain('dependency install failed');
    expect(calls).toHaveLength(1); // no typecheck/tests after a failed install
  });

  it('npm worktree WITH package-lock.json and no node_modules: runs npm ci first', async () => {
    writeFileSync(join(dir, 'package-lock.json'), '{}\n');
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
    });
    expect(calls[0]).toEqual({ cmd: 'npm', args: ['ci'] });
    expect(calls[1]?.cmd).toBe('npx');
  });

  it('explicit command overrides still win over detection', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
      typeCheckCommand: 'my-tool check',
      testCommand: 'my-tool test',
    });
    expect(calls[0]).toEqual({ cmd: 'my-tool', args: ['check'] });
    expect(calls[1]?.cmd).toBe('my-tool');
  });
});

function makeItem(over: Partial<PromptItem> = {}): PromptItem {
  return {
    id: 'child-1',
    title: 'Add budget types',
    description: 'Add the budget domain types',
    status: 'pending',
    ...over,
  } as PromptItem;
}

describe('buildItemPrompt — repo-neutral tooling + declared scope', () => {
  it('npm repo: prompt instructs npx, never corepack pnpm, and is repo-neutral', () => {
    const prompt = buildItemPrompt(makeItem(), dir);
    expect(prompt).toContain('the repository at');
    expect(prompt).not.toContain('AgentForge repository');
    expect(prompt).toContain('npx');
    expect(prompt).not.toContain('corepack pnpm');
  });

  it('pnpm repo: prompt keeps the corepack pnpm tooling', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const prompt = buildItemPrompt(makeItem(), dir);
    expect(prompt).toContain('corepack pnpm');
  });

  it('declared files render as an ENFORCED scope section', () => {
    const prompt = buildItemPrompt(
      makeItem({ files: ['src/budget.ts', 'tests/budget.test.ts'] }),
      dir,
    );
    expect(prompt).toContain('Declared file scope — ENFORCED');
    expect(prompt).toContain('- src/budget.ts');
    expect(prompt).toContain('- tests/budget.test.ts');
    expect(prompt).toContain('Edit ONLY these files');
  });

  it('no declared files → no scope section (legacy items unchanged)', () => {
    const prompt = buildItemPrompt(makeItem({ files: [] }), dir);
    expect(prompt).not.toContain('Declared file scope');
  });
});

describe('verifyChildWorktree — known-flaky test exclusion (cycle 4e451e22)', () => {
  it('drops excluded files from the force-include list AND passes --exclude globs', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    await verifyChildWorktree({
      worktreePath: dir, // npm, no lockfile → no install
      changedFiles: [
        'src/a.ts',
        'src/__tests__/a.test.ts',
        'packages/cli/src/__tests__/autonomous-worktree.test.ts',
      ],
      declaredFiles: ['src/a.ts', 'src/__tests__/a.test.ts', 'packages/cli/src/__tests__/autonomous-worktree.test.ts'],
      runner,
      excludeTestFiles: ['packages/cli/src/__tests__/autonomous-worktree.test.ts'],
    });
    const testCall = calls.find((c) => c.args.includes('related'));
    expect(testCall).toBeDefined();
    // The flaky path appears EXACTLY once — as the --exclude glob value — and
    // is therefore not in the force-included file list that follows --run.
    const flaky = 'packages/cli/src/__tests__/autonomous-worktree.test.ts';
    const occurrences = testCall!.args.filter((a) => a === flaky);
    expect(occurrences).toHaveLength(1);
    const exIdx = testCall!.args.indexOf('--exclude');
    expect(exIdx).toBeGreaterThan(-1);
    expect(testCall!.args[exIdx + 1]).toBe(flaky);
    // …and the real affected files still run.
    expect(testCall!.args).toContain('src/a.ts');
    expect(testCall!.args).toContain('src/__tests__/a.test.ts');
  });

  it('bare basenames get the **/ prefix in the exclude glob', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]): Promise<ChildVerifyCommandResult> => {
      calls.push({ cmd, args });
      return { ok: true, code: 0, output: '' };
    };
    await verifyChildWorktree({
      worktreePath: dir,
      changedFiles: ['src/a.ts'],
      declaredFiles: ['src/a.ts'],
      runner,
      excludeTestFiles: ['flaky.test.ts'],
    });
    const testCall = calls.find((c) => c.args.includes('related'));
    const exIdx = testCall!.args.indexOf('--exclude');
    expect(testCall!.args[exIdx + 1]).toBe('**/flaky.test.ts');
  });
});
