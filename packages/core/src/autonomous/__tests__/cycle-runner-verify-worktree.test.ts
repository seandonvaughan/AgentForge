import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readEpicIntegrationFromDisk,
  resolveVerifyCwd,
} from '../cycle-runner.js';

let projectRoot: string;
const cycleId = 'cycle-verify-worktree';

function cycleDir(): string {
  return join(projectRoot, '.agentforge', 'cycles', cycleId);
}

function writeExecuteJson(body: unknown): void {
  const dir = join(cycleDir(), 'phases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'execute.json'), JSON.stringify(body));
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cr-verify-worktree-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('objective VERIFY cwd resolution', () => {
  it('uses the epic integration worktree for objective cycles', () => {
    const worktreePath = join(projectRoot, '.agentforge', 'worktrees', 'epic-abc12345');
    const integration = {
      branch: 'codex/epic-abc12345',
      epicId: 'epic-abc12345',
      worktreePath,
      mergedBranches: ['codex/child-a'],
      hadConflicts: false,
    };

    expect(resolveVerifyCwd(projectRoot, 'ship the epic', integration)).toBe(worktreePath);
  });

  it('keeps legacy signal cycles on the operator project root', () => {
    const integration = {
      branch: 'codex/epic-abc12345',
      epicId: 'epic-abc12345',
      worktreePath: join(projectRoot, '.agentforge', 'worktrees', 'epic-abc12345'),
      mergedBranches: [],
      hadConflicts: false,
    };

    expect(resolveVerifyCwd(projectRoot, undefined, integration)).toBe(projectRoot);
  });

  it('derives the standard integration worktree path when a resumed signal lacks one', () => {
    const integration = {
      branch: 'codex/epic-abc12345',
      epicId: 'epic-abc12345',
      mergedBranches: [],
      hadConflicts: false,
    };

    expect(resolveVerifyCwd(projectRoot, 'resume this epic', integration)).toBe(
      join(projectRoot, '.agentforge', 'worktrees', 'int-codex-epic-abc12345'),
    );
  });

  it('preserves worktreePath when recovering epicIntegration from execute.json', () => {
    const worktreePath = join(projectRoot, '.agentforge', 'worktrees', 'epic-resume');
    writeExecuteJson({
      phase: 'execute',
      status: 'completed',
      epicIntegration: {
        branch: 'codex/epic-resume',
        epicId: 'epic-resume',
        worktreePath,
        mergedBranches: ['codex/child-a'],
        hadConflicts: false,
      },
    });

    const integration = readEpicIntegrationFromDisk(projectRoot, cycleId);
    expect(integration?.worktreePath).toBe(worktreePath);
    expect(resolveVerifyCwd(projectRoot, 'resume this epic', integration)).toBe(worktreePath);
  });
});
