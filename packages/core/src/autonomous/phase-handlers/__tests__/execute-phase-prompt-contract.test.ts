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

function writeSprintFile() {
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

async function capturePrompt(): Promise<string> {
  writeSprintFile();
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
});
