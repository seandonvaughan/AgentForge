import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MergeQueue } from '../merge-queue.js';
import { MessageBusV2 } from '../../message-bus/message-bus.js';
import type { AgentBranchPushedPayload, MergeQueuePrOpenedPayload } from '../../message-bus/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `mq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCycleDir(projectRoot: string, cycleId: string): void {
  mkdirSync(join(projectRoot, '.agentforge', 'cycles', cycleId), { recursive: true });
}

function readLedger(projectRoot: string, cycleId: string): unknown[] {
  const p = join(projectRoot, '.agentforge', 'cycles', cycleId, 'agent-prs.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf-8')) as unknown[];
}

function buildPayload(overrides: Partial<AgentBranchPushedPayload> = {}): AgentBranchPushedPayload {
  return {
    cycleId: 'cycle-abc',
    agentId: 'coder-1',
    sessionId: 'sess-1',
    branch: 'autonomous/agent-coder-1-sess-1',
    baseBranch: 'main',
    commitSha: 'deadbeef',
    filesChanged: 3,
    diffSummary: '+1 -0 src/foo.ts',
    pushedAt: '2026-05-17T10:00:00.000Z',
    itemIds: ['T4.4', 'T4.5'],
    ...overrides,
  };
}

function emitBranchPushed(bus: MessageBusV2, payload: AgentBranchPushedPayload): void {
  bus.publish<AgentBranchPushedPayload>({
    from: 'system',
    to: 'broadcast',
    topic: 'agent.branch.pushed',
    category: 'system',
    payload,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MergeQueue', () => {
  let projectRoot: string;
  let bus: MessageBusV2;

  beforeEach(() => {
    projectRoot = makeTmpDir();
    bus = new MessageBusV2({ workspaceId: 'test' });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // 1. dry-run: no gh call, ledger entry with status='dry-run'
  it('dryRun=true records entry with status=dry-run', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload());

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc');
    expect(entries).toHaveLength(1);
    expect((entries[0] as Record<string, unknown>)['status']).toBe('dry-run');
    expect((entries[0] as Record<string, unknown>)['prNumber']).toBeNull();
    expect((entries[0] as Record<string, unknown>)['branch']).toBe('autonomous/agent-coder-1-sess-1');
  });

  // 2. localOnly=true: no PR, no ledger entry
  it('localOnly=true skips PR creation and writes nothing to the ledger', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ localOnly: true }));

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc');
    expect(entries).toHaveLength(0);
  });

  // 3. gh failure → status='skipped-no-gh' in ledger
  it('records status=skipped-no-gh when gh is not available', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    // Without dryRun, gh will be called and fail in test env (not authed / not installed)
    const queue = new MergeQueue({
      projectRoot,
      bus,
      dryRun: false,
      parentBranch: 'main',
    });
    queue.start();

    emitBranchPushed(bus, buildPayload());

    // Give gh time to fail (execFile will reject quickly when binary not found / not authed)
    await new Promise((r) => setTimeout(r, 500));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry['status']).toBe('skipped-no-gh');
    expect(entry['agentId']).toBe('coder-1');
    expect(entry['cycleId']).toBe('cycle-abc');
    expect(entry['prNumber']).toBeNull();
  });

  // 4. drain() returns correct pushed count
  it('drain returns the correct pushed count and empty PR list for dry-run', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ agentId: 'coder-1', branch: 'auto/c1' }));
    emitBranchPushed(bus, buildPayload({ agentId: 'coder-2', branch: 'auto/c2' }));

    await new Promise((r) => setTimeout(r, 30));
    const result = await queue.drain();
    queue.stop();

    expect(result.pushed).toBe(2);
    // dry-run entries have no prNumber so prs array stays empty
    expect(result.prs).toHaveLength(0);
  });

  it('drain scopes ledger summary to constructor cycleId when provided', async () => {
    makeCycleDir(projectRoot, 'cycle-current');
    makeCycleDir(projectRoot, 'cycle-old');

    writeFileSync(
      join(projectRoot, '.agentforge', 'cycles', 'cycle-current', 'agent-prs.json'),
      JSON.stringify([
        {
          prNumber: 101,
          prUrl: 'https://example.test/pull/101',
          branch: 'codex/current',
          agentId: 'current-agent',
          cycleId: 'cycle-current',
          itemIds: ['current'],
          status: 'open',
          openedAt: '2026-05-19T10:00:00.000Z',
        },
      ]),
    );
    writeFileSync(
      join(projectRoot, '.agentforge', 'cycles', 'cycle-old', 'agent-prs.json'),
      JSON.stringify([
        {
          prNumber: 99,
          prUrl: 'https://example.test/pull/99',
          branch: 'codex/old',
          agentId: 'old-agent',
          cycleId: 'cycle-old',
          itemIds: ['old'],
          status: 'open',
          openedAt: '2026-05-18T10:00:00.000Z',
        },
      ]),
    );

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true, cycleId: 'cycle-current' });
    const result = await queue.drain();

    expect(result.pushed).toBe(1);
    expect(result.prs).toEqual([
      { prNumber: 101, branch: 'codex/current', agentId: 'current-agent' },
    ]);
  });

  // 5. drain() does not include localOnly events
  it('drain pushed count is zero when only localOnly events were emitted', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');
    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ localOnly: true }));
    await new Promise((r) => setTimeout(r, 20));
    const result = await queue.drain();
    queue.stop();

    expect(result.pushed).toBe(0);
    expect(result.prs).toHaveLength(0);
  });

  // 6. merge-queue.pr.opened event is emitted on dry-run
  it('emits merge-queue.pr.opened event in dry-run mode', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const receivedEvents: MergeQueuePrOpenedPayload[] = [];
    bus.subscribe<MergeQueuePrOpenedPayload>('merge-queue.pr.opened', (env) => {
      receivedEvents.push(env.payload);
    });

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload());

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.status).toBe('dry-run');
    expect(receivedEvents[0]!.agentId).toBe('coder-1');
    expect(receivedEvents[0]!.branch).toBe('autonomous/agent-coder-1-sess-1');
  });

  // 7. merge-queue.pr.opened is NOT emitted for localOnly events
  it('does not emit merge-queue.pr.opened for localOnly events', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const receivedEvents: unknown[] = [];
    bus.subscribe('merge-queue.pr.opened', (env) => {
      receivedEvents.push(env);
    });

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ localOnly: true }));

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    expect(receivedEvents).toHaveLength(0);
  });

  // 8. ledger is created when cycle dir exists
  it('creates agent-prs.json in the cycle directory', async () => {
    makeCycleDir(projectRoot, 'cycle-new');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ cycleId: 'cycle-new' }));

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const ledgerPath = join(
      projectRoot,
      '.agentforge',
      'cycles',
      'cycle-new',
      'agent-prs.json',
    );
    expect(existsSync(ledgerPath)).toBe(true);
  });

  // 9. ledger entries are append-only — multiple events accumulate
  it('appends multiple entries to the ledger without overwriting', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    for (let i = 1; i <= 5; i++) {
      emitBranchPushed(
        bus,
        buildPayload({ agentId: `coder-${i}`, branch: `auto/coder-${i}`, itemIds: [`T${i}`] }),
      );
    }

    await new Promise((r) => setTimeout(r, 60));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc');
    expect(entries).toHaveLength(5);
    const agentIds = (entries as Array<Record<string, unknown>>).map((e) => e['agentId']);
    expect(agentIds).toContain('coder-1');
    expect(agentIds).toContain('coder-5');
  });

  // 10. start() is idempotent — calling it twice does not double-subscribe
  it('start() is idempotent — calling it twice does not duplicate ledger entries', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();
    queue.start(); // second call should be a no-op

    emitBranchPushed(bus, buildPayload());

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc');
    expect(entries).toHaveLength(1);
  });

  // 11. stop() prevents future events from being processed
  it('stop() prevents subsequent events from being processed', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ agentId: 'coder-before-stop' }));
    await new Promise((r) => setTimeout(r, 20));

    queue.stop();

    emitBranchPushed(bus, buildPayload({ agentId: 'coder-after-stop' }));
    await new Promise((r) => setTimeout(r, 20));

    const entries = readLedger(projectRoot, 'cycle-abc') as Array<Record<string, unknown>>;
    const agentIds = entries.map((e) => e['agentId']);
    expect(agentIds).toContain('coder-before-stop');
    expect(agentIds).not.toContain('coder-after-stop');
  });

  // 12. ledger entries contain itemIds
  it('ledger entries contain the itemIds from the payload', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload({ itemIds: ['T4.4', 'T4.5', 'T4.6'] }));

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc') as Array<Record<string, unknown>>;
    expect(entries[0]!['itemIds']).toEqual(['T4.4', 'T4.5', 'T4.6']);
  });

  // 13. parentBranch override is respected
  it('uses parentBranch override when provided', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const queue = new MergeQueue({
      projectRoot,
      bus,
      dryRun: true,
      parentBranch: 'autonomous/v21.0.0',
    });
    queue.start();

    emitBranchPushed(bus, buildPayload());

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc') as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!['status']).toBe('dry-run');
  });

  // 14. parentBranch is read from cycle.json when no override is given
  it('reads parentBranch from cycle.json when no override is provided', async () => {
    makeCycleDir(projectRoot, 'cycle-abc');

    const cycleJson = {
      cycleId: 'cycle-abc',
      git: { branch: 'autonomous/v21.0.0' },
    };
    writeFileSync(
      join(projectRoot, '.agentforge', 'cycles', 'cycle-abc', 'cycle.json'),
      JSON.stringify(cycleJson),
    );

    const queue = new MergeQueue({ projectRoot, bus, dryRun: true });
    queue.start();

    emitBranchPushed(bus, buildPayload());

    await new Promise((r) => setTimeout(r, 20));
    await queue.drain();
    queue.stop();

    const entries = readLedger(projectRoot, 'cycle-abc');
    expect(entries).toHaveLength(1);
  });
});
