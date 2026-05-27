/**
 * Safeguard #4 — difficulty gating + quarantine in the backlog sourcing.
 *
 * The loop repeatedly auto-picked giant `estimatedComplexity: high`, file-less
 * backlog features it could not ship, and re-picked items that had already
 * failed. Gate those out so unattended cycles only attempt small, scoped work,
 * and never re-pick a quarantined item.
 *
 * See docs/superpowers/specs/2026-05-25-loop-safeguards-recommendations.md (#4).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProposalToBacklog, type ProposalAdapter } from '../proposal-to-backlog.js';
import type { CycleConfig } from '../types.js';

const emptyAdapter: ProposalAdapter = {
  getRecentFailedSessions: async () => [],
  getCostAnomalies: async () => [],
  getFailedTaskOutcomes: async () => [],
  getFlakingTests: async () => [],
};

const costAnomalyAdapter: ProposalAdapter = {
  getRecentFailedSessions: async () => [],
  getCostAnomalies: async () => [
    { agent: 'executor-runtime-engineer', anomaly: '3x median cost', confidence: 0.95 },
  ],
  getFailedTaskOutcomes: async () => [],
  getFlakingTests: async () => [],
};

function cfg(): CycleConfig {
  return {
    sourcing: {
      lookbackDays: 7,
      minProposalConfidence: 0.6,
      includeTodoMarkers: false,
      todoMarkerPattern: 'TODO\\(autonomous\\)',
    },
  } as unknown as CycleConfig;
}

let root: string;
let prevUnattended: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-backlog-guard-'));
  mkdirSync(join(root, '.agentforge', 'backlog'), { recursive: true });
  prevUnattended = process.env['AGENTFORGE_UNATTENDED'];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevUnattended === undefined) delete process.env['AGENTFORGE_UNATTENDED'];
  else process.env['AGENTFORGE_UNATTENDED'] = prevUnattended;
});

function writeBacklog(items: unknown[]): void {
  writeFileSync(join(root, '.agentforge', 'backlog', 'b.json'), JSON.stringify({ items }));
}
function writeQuarantine(ids: string[]): void {
  writeFileSync(join(root, '.agentforge', 'backlog', 'quarantine.json'), JSON.stringify({ ids }));
}
function writeCompletedLedger(entries: unknown): void {
  writeFileSync(join(root, '.agentforge', 'backlog', 'completed.json'), JSON.stringify(entries));
}

describe('difficulty gating (unattended)', () => {
  it('excludes high-complexity or file-less backlog items when AGENTFORGE_UNATTENDED=1', async () => {
    process.env['AGENTFORGE_UNATTENDED'] = '1';
    writeBacklog([
      { id: 'big', title: 'Big risky feature', priority: 'P0', estimatedComplexity: 'high' },
      {
        id: 'small',
        title: 'Small scoped fix',
        priority: 'P1',
        estimatedComplexity: 'low',
        files: ['packages/x/y.ts'],
      },
    ]);
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Small scoped fix');
    expect(titles).not.toContain('Big risky feature');
  });

  it('keeps high-complexity items when NOT unattended (a human can still approve)', async () => {
    delete process.env['AGENTFORGE_UNATTENDED'];
    writeBacklog([
      { id: 'big', title: 'Big risky feature', priority: 'P0', estimatedComplexity: 'high' },
    ]);
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    expect(items.map((i) => i.title)).toContain('Big risky feature');
  });

  it('threads estimatedComplexity and files onto the BacklogItem', async () => {
    writeBacklog([
      {
        id: 'small',
        title: 'Small scoped fix',
        priority: 'P1',
        estimatedComplexity: 'low',
        files: ['packages/x/y.ts'],
      },
    ]);
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const item = items.find((i) => i.title === 'Small scoped fix');
    expect(item?.estimatedComplexity).toBe('low');
    expect(item?.files).toEqual(['packages/x/y.ts']);
  });

  it('excludes file-less cost-anomaly investigations when AGENTFORGE_UNATTENDED=1', async () => {
    process.env['AGENTFORGE_UNATTENDED'] = '1';
    const items = await new ProposalToBacklog(costAnomalyAdapter, root, cfg()).build();
    expect(items.map((i) => i.source)).not.toContain('cost-anomaly');
  });
});

describe('quarantine', () => {
  it('excludes items whose id is listed in quarantine.json', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
      { id: 'banned', title: 'Quarantined item', priority: 'P1', estimatedComplexity: 'low', files: ['b.ts'] },
    ]);
    writeQuarantine(['backlog-banned']);
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Keep me');
    expect(titles).not.toContain('Quarantined item');
  });

  it('tolerates a missing quarantine file', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
    ]);
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    expect(items.map((i) => i.title)).toContain('Keep me');
  });
});

describe('completed ledger replay guard', () => {
  it('excludes items whose id is listed in completed.json', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
      { id: 'done', title: 'Already shipped', priority: 'P1', estimatedComplexity: 'low', files: ['b.ts'] },
    ]);
    writeCompletedLedger({
      entries: [
        { itemId: 'backlog-done', completedAt: '2026-05-27T00:00:00.000Z', cycleId: 'c1', prNumber: 123 },
      ],
    });

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Keep me');
    expect(titles).not.toContain('Already shipped');
  });

  it('tolerates a missing completed ledger file', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
    ]);

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    expect(items.map((i) => i.title)).toContain('Keep me');
  });

  it('tolerates malformed completed ledger JSON', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
    ]);
    writeFileSync(join(root, '.agentforge', 'backlog', 'completed.json'), '{ malformed');

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    expect(items.map((i) => i.title)).toContain('Keep me');
  });

  it('normalizes whitespace-padded item ids and legacy id fields in completed.json', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
      { id: 'done', title: 'Done item', priority: 'P1', estimatedComplexity: 'low', files: ['b.ts'] },
      { id: 'legacy', title: 'Legacy done item', priority: 'P1', estimatedComplexity: 'low', files: ['c.ts'] },
    ]);
    writeCompletedLedger({
      entries: [
        { itemId: '  backlog-done  ', completedAt: '2026-05-27T00:00:00.000Z' },
        { id: '\tbacklog-legacy\n', completedAt: '2026-05-27T00:00:00.000Z' },
        { itemId: '   ' },
      ],
    });

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Keep me');
    expect(titles).not.toContain('Done item');
    expect(titles).not.toContain('Legacy done item');
  });
});
