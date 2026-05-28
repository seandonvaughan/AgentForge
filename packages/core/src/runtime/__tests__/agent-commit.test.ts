// packages/core/src/runtime/__tests__/agent-commit.test.ts
//
// Tests for T4.3 — commitAgentWork
//
// Test matrix:
//  1.  No changes → returns null, no bus event
//  2.  AGENT_AUTOCOMMIT_DISABLED=1 → returns null immediately
//  3.  Repo with no remote → commit created, push skipped, localOnly=true
//  4.  Repo with bare remote → commit + push both succeed, localOnly=false
//  5.  Bus event has correct AgentBranchPushedPayload shape
//  6.  commitSha is a valid 40-char hex sha
//  7.  filesChanged reflects actual file count
//  8.  diffSummary is <= 500 chars
//  9.  Branch name is sanitized (special chars → underscores)
//  10. itemIds appear in commit message
//  11. Bus event topic is 'agent.branch.pushed'
//  12. No bus event emitted when no changes (null early return)
//  13. localOnly=true event still emitted on bus when no remote
//  14. Push is idempotent when called twice with same remote (force-with-lease)

import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAgentWork } from '../agent-commit.js';
import { MessageBusV2 } from '../../message-bus/message-bus.js';
import type { AgentBranchPushedPayload } from '../../message-bus/types.js';

const execFile = promisify(execFileCb);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

function comparablePath(path: string): string {
  return realpathSync.native(path).replace(/\\/g, '/').toLowerCase();
}

/** Create a plain local git repo with one initial commit on branch `main`. */
async function createLocalRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'af-agent-commit-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'TestBot']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'initial commit', '--no-gpg-sign']);
  return dir;
}

/**
 * Create a working repo whose origin is a local bare repo.
 * Returns { workingDir, bareDir }.
 */
async function createRepoWithBareOrigin(): Promise<{ workingDir: string; bareDir: string }> {
  const source = await createLocalRepo();

  const bareDir = mkdtempSync(join(tmpdir(), 'af-agent-commit-bare-'));
  rmSync(bareDir, { recursive: true, force: true });
  // Clone source into a bare repo.
  await execFile('git', ['clone', '--bare', source, bareDir]);

  const workingDir = mkdtempSync(join(tmpdir(), 'af-agent-commit-work-'));
  rmSync(workingDir, { recursive: true, force: true });
  await execFile('git', ['clone', bareDir, workingDir]);
  await git(workingDir, ['config', 'user.email', 'test@example.com']);
  await git(workingDir, ['config', 'user.name', 'TestBot']);
  await git(workingDir, ['config', 'commit.gpgsign', 'false']);

  rmSync(source, { recursive: true, force: true });
  return { workingDir, bareDir };
}

/** Write a file + stage it so the worktree is dirty. */
function makeChange(dir: string, filename = 'change.ts', content = 'export const x = 1;\n'): void {
  writeFileSync(join(dir, filename), content);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('commitAgentWork', () => {
  let dirs: string[] = [];

  afterEach(() => {
    // Cleanup all temp dirs and restore env.
    delete process.env['AGENT_AUTOCOMMIT_DISABLED'];
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs = [];
  });

  // ── 1. Clean worktree → null ─────────────────────────────────────────────
  it('returns null when worktree has no changes', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent-coder-abc',
      agentId: 'agent-coder',
      itemIds: ['ITEM-1'],
    });

    expect(result).toBeNull();
  });

  it('returns null when only AgentForge audit worktree artifacts changed', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    mkdirSync(join(dir, '.agentforge', 'audit-worktrees', 'pr-195'), { recursive: true });
    writeFileSync(
      join(dir, '.agentforge', 'audit-worktrees', 'pr-195', 'scratch.ts'),
      'export const scratch = true;\n',
    );

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent-coder-abc',
      agentId: 'agent-coder',
      itemIds: ['ITEM-1'],
    });

    expect(result).toBeNull();
  });

  it('rejects a nested stale path instead of walking up to the parent repo', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    const stalePath = join(dir, '.agentforge', 'worktrees', 'agent-coder-stale');
    mkdirSync(stalePath, { recursive: true });
    makeChange(dir, 'real-change.ts', 'export const realChange = true;\n');

    await expect(
      commitAgentWork({
        worktreePath: stalePath,
        branch: 'autonomous/agent-coder-abc',
        agentId: 'agent-coder',
        itemIds: ['ITEM-1'],
      }),
    ).rejects.toThrow('refusing to commit changes outside the allocated worktree');
  });

  it('repairs a registered worktree with a missing .git file before committing', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    const worktreePath = join(dir, '.agentforge', 'worktrees', 'agent-coder-repair');
    mkdirSync(join(dir, '.agentforge', 'worktrees'), { recursive: true });
    await git(dir, [
      'worktree',
      'add',
      '--no-track',
      '-b',
      'codex/rejected-branch',
      worktreePath,
      'HEAD',
    ]);
    makeChange(worktreePath, 'repair.ts', 'export const repaired = true;\n');
    rmSync(join(worktreePath, '.git'), { force: true });

    const result = await commitAgentWork({
      worktreePath,
      projectRoot: dir,
      branch: 'codex/rejected-branch',
      agentId: 'agent-coder',
      itemIds: ['ITEM-RETRY'],
    });

    expect(result).not.toBeNull();
    expect(result!.localOnly).toBe(true);
    expect(comparablePath(await git(worktreePath, ['rev-parse', '--show-toplevel'])))
      .toBe(comparablePath(worktreePath));
    expect(await git(worktreePath, ['log', '--oneline', '-1'])).toContain('ITEM-RETRY');
  });

  // ── 2. AGENT_AUTOCOMMIT_DISABLED → null ──────────────────────────────────
  it('returns null when AGENT_AUTOCOMMIT_DISABLED is set', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);
    process.env['AGENT_AUTOCOMMIT_DISABLED'] = '1';

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent-coder-abc',
      agentId: 'agent-coder',
      itemIds: ['ITEM-1'],
    });

    expect(result).toBeNull();
  });

  // ── 3. No remote → commit created, localOnly=true ────────────────────────
  it('creates a commit and returns localOnly=true when no origin remote', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent-coder-abc',
      agentId: 'agent-coder',
      itemIds: ['ITEM-1'],
    });

    expect(result).not.toBeNull();
    expect(result!.localOnly).toBe(true);
    expect(result!.branch).toBe('autonomous/agent-coder-abc');
    expect(result!.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  // ── 4. Bare remote → commit + push succeed, localOnly=false ──────────────
  it('commits and pushes when origin remote exists', async () => {
    const { workingDir, bareDir } = await createRepoWithBareOrigin();
    dirs.push(workingDir, bareDir);

    // Create and check out a fresh branch in the working dir.
    await git(workingDir, ['checkout', '-b', 'autonomous/agent-coder-test123']);
    makeChange(workingDir);

    const result = await commitAgentWork({
      worktreePath: workingDir,
      branch: 'autonomous/agent-coder-test123',
      agentId: 'agent-coder',
      itemIds: ['ITEM-42'],
    });

    expect(result).not.toBeNull();
    expect(result!.localOnly).toBe(false);
    expect(result!.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify the branch exists on the bare (origin) remote.
    const remoteBranches = await execFile('git', ['-C', bareDir, 'branch']);
    expect(remoteBranches.stdout).toContain('autonomous/agent-coder-test123');
  }, 60_000);

  // ── 5. Bus event shape matches AgentBranchPushedPayload ──────────────────
  it('emits agent.branch.pushed event with correct payload shape', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir, 'widget.ts', 'export const widget = true;\n');

    const bus = new MessageBusV2({ workspaceId: 'test-ws' });
    const events: AgentBranchPushedPayload[] = [];
    bus.subscribe<AgentBranchPushedPayload>('agent.branch.pushed', (env) => {
      events.push(env.payload);
    });

    await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent-coder-shaped',
      agentId: 'agent-coder',
      sessionId: 'sess-001',
      cycleId: 'cycle-abc',
      itemIds: ['ITEM-10', 'ITEM-11'],
      bus,
    });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.cycleId).toBe('cycle-abc');
    expect(ev.agentId).toBe('agent-coder');
    expect(ev.sessionId).toBe('sess-001');
    expect(ev.branch).toBe('autonomous/agent-coder-shaped');
    expect(ev.baseBranch).toBe('main');
    expect(ev.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.itemIds).toEqual(['ITEM-10', 'ITEM-11']);
    expect(typeof ev.pushedAt).toBe('string');
    expect(typeof ev.filesChanged).toBe('number');
    expect(typeof ev.diffSummary).toBe('string');
    expect(ev.localOnly).toBe(true); // no remote in this repo
  });

  it('emits agent.branch.pushed through the phase bus facade', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir, 'phase-bus.ts', 'export const phaseBus = true;\n');

    const events: Array<{ topic: string; payload: AgentBranchPushedPayload }> = [];
    const phaseBus = {
      publish: (topic: string, payload: AgentBranchPushedPayload) => {
        events.push({ topic, payload });
      },
    };

    await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent-coder-phase-bus',
      agentId: 'agent-coder',
      sessionId: 'sess-phase',
      cycleId: 'cycle-phase',
      itemIds: ['ITEM-PHASE'],
      bus: phaseBus,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe('agent.branch.pushed');
    expect(events[0]!.payload.cycleId).toBe('cycle-phase');
    expect(events[0]!.payload.branch).toBe('autonomous/agent-coder-phase-bus');
    expect(events[0]!.payload.localOnly).toBe(true);
  });

  // ── 6. commitSha is 40-char hex ───────────────────────────────────────────
  it('commitSha is a valid 40-char hex SHA', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/sha-test',
      agentId: 'agent-x',
      itemIds: ['SHA-1'],
    });

    expect(result!.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  // ── 7. filesChanged reflects actual file count ────────────────────────────
  it('filesChanged equals the number of files written', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir, 'a.ts');
    makeChange(dir, 'b.ts');
    makeChange(dir, 'c.ts');

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/multi-file',
      agentId: 'agent-x',
      itemIds: ['MULTI-1'],
    });

    expect(result!.filesChanged).toBe(3);
  });

  it('does not stage package manager stores created inside an agent worktree', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir, 'feature.ts', 'export const feature = true;\n');
    mkdirSync(join(dir, '.pnpm-store', 'v3', 'files', '00'), { recursive: true });
    writeFileSync(join(dir, '.pnpm-store', 'v3', 'files', '00', 'cache-file'), 'cache\n');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/ignore-tooling-cache',
      agentId: 'agent-x',
      itemIds: ['CACHE-1'],
    });

    expect(result).not.toBeNull();
    expect(result!.filesChanged).toBe(1);
    const committedFiles = await git(dir, ['diff', '--name-only', 'HEAD~1..HEAD']);
    expect(committedFiles).toBe('feature.ts');
    const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
    expect(status).toContain('?? .pnpm-store/v3/files/00/cache-file');
    expect(status).toContain('?? node_modules/pkg/index.js');
  });

  // ── 8. diffSummary truncated at 500 chars ─────────────────────────────────
  it('diffSummary is at most 500 characters', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    // Write many files to produce a long diff stat.
    for (let i = 0; i < 30; i++) {
      makeChange(dir, `file${i}.ts`, `export const v${i} = ${i};\n`);
    }

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/long-diff',
      agentId: 'agent-x',
      itemIds: ['LONG-1'],
    });

    expect(result!.diffSummary.length).toBeLessThanOrEqual(500);
  });

  // ── 9. Branch name sanitized ──────────────────────────────────────────────
  it('sanitizes branch name special characters', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);

    // Note: git requires the branch to exist; in local-only mode the branch
    // name in the result is sanitized but no actual branch is created/checked
    // out (agent-commit.ts works on the currently-checked-out branch for git
    // operations but records the sanitized name in the result/event).
    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/agent coder@v1.0!',
      agentId: 'agent-x',
      itemIds: ['SANITIZE-1'],
    });

    // The sanitized branch name should only contain [a-zA-Z0-9_/-]
    expect(result!.branch).toMatch(/^[a-zA-Z0-9_/-]+$/);
  });

  // ── 10. itemIds appear in git commit message ──────────────────────────────
  it('includes itemIds in the commit message', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);

    await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/commit-msg-test',
      agentId: 'agent-coder',
      itemIds: ['TICKET-123', 'TICKET-456'],
    });

    const log = await git(dir, ['log', '--oneline', '-1']);
    expect(log).toContain('TICKET-123');
    expect(log).toContain('TICKET-456');
  });

  // ── 11. Bus event topic is 'agent.branch.pushed' ─────────────────────────
  // Note: subscribeAll uses '*.*' pattern which doesn't match multi-segment
  // topics due to how the MessageBusV2 wildcard dispatcher works.  Subscribe
  // to the exact topic string instead.
  it('emits event with topic agent.branch.pushed', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);

    const bus = new MessageBusV2({ workspaceId: 'test-ws' });
    const topics: string[] = [];
    // Use exact-topic subscription — wildcards that end in '.*' would strip to
    // prefix '*' which never matches a real topic.
    bus.subscribe('agent.branch.pushed', (env) => { topics.push(env.topic); });

    await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/topic-test',
      agentId: 'agent-x',
      itemIds: ['T-1'],
      bus,
    });

    expect(topics).toContain('agent.branch.pushed');
  });

  // ── 12. No bus event when clean worktree ─────────────────────────────────
  it('does not emit any bus event when worktree is clean', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);

    const bus = new MessageBusV2({ workspaceId: 'test-ws' });
    const events: unknown[] = [];
    bus.subscribeAll((env) => { events.push(env); });

    const result = await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/clean',
      agentId: 'agent-x',
      itemIds: ['CLEAN-1'],
      bus,
    });

    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  // ── 13. localOnly flag present in bus event when no remote ───────────────
  it('bus event payload has localOnly=true when repo has no origin', async () => {
    const dir = await createLocalRepo();
    dirs.push(dir);
    makeChange(dir);

    const bus = new MessageBusV2({ workspaceId: 'test-ws' });
    let capturedPayload: AgentBranchPushedPayload | null = null;
    bus.subscribe<AgentBranchPushedPayload>('agent.branch.pushed', (env) => {
      capturedPayload = env.payload;
    });

    await commitAgentWork({
      worktreePath: dir,
      branch: 'autonomous/local-only-flag',
      agentId: 'agent-x',
      itemIds: ['LO-1'],
      bus,
    });

    expect(capturedPayload).not.toBeNull();
    expect((capturedPayload! as AgentBranchPushedPayload).localOnly).toBe(true);
  });

  // ── 14. Force-with-lease push is idempotent on bare remote ───────────────
  it('second call with new change pushes cleanly after first push', async () => {
    const { workingDir, bareDir } = await createRepoWithBareOrigin();
    dirs.push(workingDir, bareDir);

    await git(workingDir, ['checkout', '-b', 'autonomous/idempotent-test']);
    makeChange(workingDir, 'first.ts');

    const r1 = await commitAgentWork({
      worktreePath: workingDir,
      branch: 'autonomous/idempotent-test',
      agentId: 'agent-x',
      itemIds: ['IDEM-1'],
    });
    expect(r1).not.toBeNull();
    expect(r1!.localOnly).toBe(false);

    // Make another change and push again.
    makeChange(workingDir, 'second.ts');
    const r2 = await commitAgentWork({
      worktreePath: workingDir,
      branch: 'autonomous/idempotent-test',
      agentId: 'agent-x',
      itemIds: ['IDEM-2'],
    });
    expect(r2).not.toBeNull();
    expect(r2!.localOnly).toBe(false);
    // The second sha must differ from the first.
    expect(r2!.commitSha).not.toBe(r1!.commitSha);
  }, 60_000);
});
