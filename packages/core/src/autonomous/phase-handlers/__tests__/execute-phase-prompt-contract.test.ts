/**
 * Safeguard #3.1 — execute-phase agent prompt CONTRACT.
 *
 * Every agent prompt must instruct the agent to:
 *   (a) produce the SMALLEST diff and not refactor unrelated code,
 *   (b) add/adjust at least one test that fails without the change, and
 *   (c) self-verify (type-check + targeted tests) BEFORE reporting done.
 *
 * This reduces gate rejections at the source — agents were returning large,
 * unverified diffs that the gate then (correctly) rejected, and the loop could
 * not recover. See docs/superpowers/specs/2026-05-25-loop-safeguards-recommendations.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-prompt-contract-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  return {
    publish: (_t: string, _p: unknown) => {},
    subscribe: (_t: string, _cb: (e: unknown) => void) => () => {},
  };
}

function writeSprintFile(itemOverrides: Record<string, unknown> = {}) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-pc-1',
    items: [
      {
        id: 'item-1',
        title: 'Add a logging helper',
        assignee: 'coder',
        status: 'planned',
        tags: ['typescript'],
        description: 'Add a small logging helper.',
        ...itemOverrides,
      },
    ],
  };
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-pc-1');
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

function makeCtx(runtime: unknown): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-pc-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-pc-1',
    adapter: undefined as never,
    bus: makeBus(),
    runtime,
  } as PhaseContext;
}

async function capturePrompt(itemOverrides: Record<string, unknown> = {}): Promise<string> {
  writeSprintFile(itemOverrides);
  const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };
  await runExecutePhase(makeCtx(runtime), {
    maxParallelism: 1,
    maxItemRetries: 0,
    disableWorktrees: true,
    selfEvalDisabled: true,
  });
  expect(runtime.run).toHaveBeenCalledTimes(1);
  return runtime.run.mock.calls[0]![1] as string;
}

describe('execute-phase agent prompt contract', () => {
  it('instructs the agent to produce the smallest diff', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('smallest diff');
  });

  it('requires adding a test that fails without the change', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('at least one test that fails without your change');
  });

  it('requires self-verification (type-check + targeted tests) before reporting done', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('Self-verify before you report done');
    // Toolchain-agnostic since the repo-neutral fix: the exact tsc invocation is
    // lockfile-detected (corepack pnpm exec tsc -b … / npx tsc …) — assert the
    // type-check requirement itself, not one package manager's spelling.
    expect(prompt).toContain('tsc');
    expect(prompt).toContain('--noEmit');
  });

  it('normalizes nonexistent planned leaf files to existing directory scopes before dispatch', async () => {
    mkdirSync(join(tmpRoot, 'packages', 'dashboard', 'src'), { recursive: true });

    const prompt = await capturePrompt({
      files: ['packages/dashboard/src/App.tsx', 'packages/dashboard/src/api.ts'],
    });

    expect(prompt).toContain('- packages/dashboard/src');
    expect(prompt).not.toContain('packages/dashboard/src/App.tsx');
    expect(prompt).not.toContain('packages/dashboard/src/api.ts');
  });

  it('fails invalid declared scopes before invoking the runtime', async () => {
    writeSprintFile({ files: ['../outside.ts'] });
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };

    const result = await runExecutePhase(makeCtx(runtime), {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).not.toHaveBeenCalled();
    const [item] = (result.itemResults ?? []) as Array<{
      status: string;
      failureClass?: string;
      error?: string;
    }>;
    expect(item?.status).toBe('failed');
    expect(item?.failureClass).toBe('scope');
    expect(item?.error).toContain('Declared scope validation failed before dispatch');
  });

  it('enforce mode fails before dispatch when a missing leaf would be widened', async () => {
    mkdirSync(join(tmpRoot, 'packages', 'dashboard', 'src'), { recursive: true });
    writeSprintFile({ files: ['packages/dashboard/src/App.tsx'] });
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };
    const prior = process.env.AF_PLAN_SCOPE_VALIDATION;
    process.env.AF_PLAN_SCOPE_VALIDATION = 'enforce';
    try {
      const result = await runExecutePhase(makeCtx(runtime), {
        maxParallelism: 1,
        maxItemRetries: 0,
        disableWorktrees: true,
        selfEvalDisabled: true,
      });

      expect(runtime.run).not.toHaveBeenCalled();
      const [item] = (result.itemResults ?? []) as Array<{
        status: string;
        failureClass?: string;
        error?: string;
      }>;
      expect(item?.status).toBe('failed');
      expect(item?.failureClass).toBe('scope');
      expect(item?.error).toContain('packages/dashboard/src/App.tsx -> packages/dashboard/src');
    } finally {
      if (prior === undefined) {
        delete process.env.AF_PLAN_SCOPE_VALIDATION;
      } else {
        process.env.AF_PLAN_SCOPE_VALIDATION = prior;
      }
    }
  });

  it('tells dashboard/readiness UI claim agents which visible surface must exercise the claim', async () => {
    const surface = join(
      tmpRoot,
      'packages',
      'dashboard',
      'src',
      'routes',
      'cycles',
      '+page.svelte',
    );
    mkdirSync(join(tmpRoot, 'packages', 'dashboard', 'src', 'routes', 'cycles'), { recursive: true });
    writeFileSync(surface, '<script lang="ts"></script>\n');

    const prompt = await capturePrompt({
      title: 'Gate dashboard readiness UI claims',
      description: 'Make the dashboard cycle page show readiness status.',
      tags: ['dashboard', 'ui'],
      files: ['packages/dashboard/src/routes/cycles/+page.svelte'],
    });

    expect(prompt).toContain('Dashboard/readiness UI claim gate');
    expect(prompt).toContain('Visible dashboard surface to exercise: packages/dashboard/src/routes/cycles/+page.svelte');
    expect(prompt).toContain('verifier-discoverable `*.test.*` or `*.spec.*`');
  });
});
