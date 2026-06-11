// packages/core/src/autonomous/__tests__/cycle-runner-epic-release.test.ts
//
// Cycle 5242ca92 — epic release resilience helpers on the CycleRunner.
//
// Strategy mirrors the other cycle-runner suites: the mode-branching logic is
// extracted into exported pure functions and pinned directly, without spinning
// up a full CycleRunner.
//
// Coverage:
//   1. readEpicIntegrationFromDisk — the disk fallback for a resumed run whose
//      in-memory execute PhaseResult lost the epicIntegration signal.
//   2. assertObjectiveReleaseIntegration — an objective cycle with NO
//      integration signal must throw instead of entering the legacy main-tree
//      createBranch/stage/commit path (which shipped an untracked .mcp.json
//      as PR #307).
//   3. tryLoadExistingPlanForResume — a resume reuses the existing plan.json
//      instead of regenerating an empty objective-mode shell (totalItems:0).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readEpicIntegrationFromDisk,
  assertObjectiveReleaseIntegration,
  resolveStageVerifyCwd,
  tryLoadExistingPlanForResume,
} from '../cycle-runner.js';
import type { EpicIntegrationResult } from '../phase-scheduler.js';

let projectRoot: string;
const cycleId = 'cycle-5242ca92-test';

function cycleDir(): string {
  return join(projectRoot, '.agentforge', 'cycles', cycleId);
}

function writeExecuteJson(body: unknown): void {
  const dir = join(cycleDir(), 'phases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'execute.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cr-epic-release-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('readEpicIntegrationFromDisk — disk fallback for the release stage', () => {
  it('reads a full epicIntegration signal from phases/execute.json', () => {
    writeExecuteJson({
      phase: 'execute',
      status: 'completed',
      epicIntegration: {
        branch: 'codex/epic-abc12345',
        epicId: 'epic-abc12345',
        mergedBranches: ['codex/agent-a', 'codex/agent-b'],
        hadConflicts: false,
        requiresFullGates: true,
      },
    });

    const integ = readEpicIntegrationFromDisk(projectRoot, cycleId);
    expect(integ).not.toBeNull();
    expect(integ!.branch).toBe('codex/epic-abc12345');
    expect(integ!.epicId).toBe('epic-abc12345');
    expect(integ!.mergedBranches).toEqual(['codex/agent-a', 'codex/agent-b']);
    expect(integ!.hadConflicts).toBe(false);
    expect(integ!.requiresFullGates).toBe(true);
  });

  it('defaults the optional fields defensively', () => {
    writeExecuteJson({
      epicIntegration: { branch: 'codex/epic-x1234567', epicId: 'epic-x1234567' },
    });
    const integ = readEpicIntegrationFromDisk(projectRoot, cycleId);
    expect(integ).not.toBeNull();
    expect(integ!.mergedBranches).toEqual([]);
    expect(integ!.hadConflicts).toBe(false);
    expect('requiresFullGates' in integ!).toBe(false);
  });

  it('returns null when execute.json is absent', () => {
    expect(readEpicIntegrationFromDisk(projectRoot, cycleId)).toBeNull();
  });

  it('returns null when execute.json has no epicIntegration (vacuous resumed run)', () => {
    writeExecuteJson({ phase: 'execute', status: 'completed', totalItems: 0 });
    expect(readEpicIntegrationFromDisk(projectRoot, cycleId)).toBeNull();
  });

  it('returns null on a malformed signal or unparseable file', () => {
    writeExecuteJson({ epicIntegration: { branch: 42, epicId: 'epic-y1234567' } });
    expect(readEpicIntegrationFromDisk(projectRoot, cycleId)).toBeNull();
    writeExecuteJson('{not json');
    expect(readEpicIntegrationFromDisk(projectRoot, cycleId)).toBeNull();
  });
});

describe('assertObjectiveReleaseIntegration — no legacy main-tree release on objective cycles', () => {
  const integration: EpicIntegrationResult = {
    branch: 'codex/epic-abc12345',
    epicId: 'epic-abc12345',
    mergedBranches: [],
    hadConflicts: false,
  };

  it('throws a clear error when an objective cycle has no integration signal', () => {
    expect(() => assertObjectiveReleaseIntegration('build the operator console', null)).toThrow(
      'objective cycle has no integration branch — refusing the legacy main-tree release; inspect phases/execute.json',
    );
  });

  it('does not throw when the integration signal is present', () => {
    expect(() =>
      assertObjectiveReleaseIntegration('build the operator console', integration),
    ).not.toThrow();
  });

  it('does not throw for signal cycles (objective undefined), preserving the legacy path', () => {
    expect(() => assertObjectiveReleaseIntegration(undefined, null)).not.toThrow();
  });
});

describe('resolveStageVerifyCwd — objective verify runs in the integration worktree', () => {
  const integration: EpicIntegrationResult = {
    branch: 'codex/epic-abc12345',
    epicId: 'epic-abc12345',
    mergedBranches: [],
    hadConflicts: false,
  };

  it('uses the deterministic integration worktree for objective cycles', () => {
    expect(resolveStageVerifyCwd(projectRoot, 'build the operator console', integration)).toBe(
      join(projectRoot, '.agentforge', 'worktrees', 'int-codex-epic-abc12345'),
    );
  });

  it('keeps legacy signal cycles on the operator project root', () => {
    expect(resolveStageVerifyCwd(projectRoot, undefined, integration)).toBe(projectRoot);
  });

  it('falls back to the operator project root when no integration signal exists yet', () => {
    expect(resolveStageVerifyCwd(projectRoot, 'build the operator console', null)).toBe(projectRoot);
  });
});

describe('tryLoadExistingPlanForResume — resume reuses the on-disk plan', () => {
  it('returns the existing plan with its items and statuses intact', () => {
    mkdirSync(cycleDir(), { recursive: true });
    writeFileSync(
      join(cycleDir(), 'plan.json'),
      JSON.stringify({
        version: '25.1.0',
        sprintId: 'v25-1-0-autonomous',
        title: 'epic plan',
        items: [
          { id: 'child-004', title: 'four', assignee: 'coder', status: 'failed' },
          { id: 'child-021', title: 'twenty-one', assignee: 'coder', status: 'blocked' },
        ],
        parentEpicId: 'epic-5242ca92',
      }),
    );

    const plan = tryLoadExistingPlanForResume(projectRoot, cycleId);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe('25.1.0');
    expect(plan!.sprintId).toBe('v25-1-0-autonomous');
    expect(plan!.items).toHaveLength(2);
    expect(plan!.items.map((i) => i.id)).toEqual(['child-004', 'child-021']);
  });

  it('returns null when plan.json is absent (fresh cycle regenerates)', () => {
    expect(tryLoadExistingPlanForResume(projectRoot, cycleId)).toBeNull();
  });

  it('returns null when plan.json has no items (empty objective-mode shell)', () => {
    mkdirSync(cycleDir(), { recursive: true });
    writeFileSync(
      join(cycleDir(), 'plan.json'),
      JSON.stringify({ version: '25.1.0', sprintId: 'v25-1-0-autonomous', items: [] }),
    );
    expect(tryLoadExistingPlanForResume(projectRoot, cycleId)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    mkdirSync(cycleDir(), { recursive: true });
    writeFileSync(join(cycleDir(), 'plan.json'), '{broken');
    expect(tryLoadExistingPlanForResume(projectRoot, cycleId)).toBeNull();
  });
});
