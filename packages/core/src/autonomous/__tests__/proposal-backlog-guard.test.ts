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
function writeResearchRun(runId: string, run: unknown): void {
  mkdirSync(join(root, '.agentforge', 'research-runs', runId), { recursive: true });
  writeFileSync(join(root, '.agentforge', 'research-runs', runId, 'run.json'), JSON.stringify(run));
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

  it('excludes high-risk or file-less research-plan items when AGENTFORGE_UNATTENDED=1', async () => {
    process.env['AGENTFORGE_UNATTENDED'] = '1';
    writeResearchRun('rd-run-guard', {
      runId: 'rd-run-guard',
      plannedCycle: { ideaIds: ['idea-low', 'idea-high', 'idea-noscope'] },
      ideas: [
        {
          ideaId: 'idea-low',
          title: 'Scoped low-risk idea',
          problem: 'P',
          hypothesis: 'H',
          expectedImpact: 'E',
          acceptanceChecks: ['A'],
          touchedAreas: ['packages/core/src/autonomous/proposal-to-backlog.ts'],
          risk: 'low',
          status: 'planned',
        },
        {
          ideaId: 'idea-high',
          title: 'High-risk idea',
          problem: 'P',
          hypothesis: 'H',
          expectedImpact: 'E',
          acceptanceChecks: ['A'],
          touchedAreas: ['packages/core/src/autonomous/proposal-to-backlog.ts'],
          risk: 'high',
          status: 'planned',
        },
        {
          ideaId: 'idea-noscope',
          title: 'No scope idea',
          problem: 'P',
          hypothesis: 'H',
          expectedImpact: 'E',
          acceptanceChecks: ['A'],
          touchedAreas: [],
          risk: 'medium',
          status: 'planned',
        },
      ],
    });
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const researchItems = items.filter((i) => i.source === 'research-plan').map((i) => i.title);
    expect(researchItems).toContain('Scoped low-risk idea');
    expect(researchItems).not.toContain('High-risk idea');
    expect(researchItems).not.toContain('No scope idea');
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

  it('normalizes whitespace/punctuation/case quarantine ids and drops blank/un-normalizable ids', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
      { id: 'sPaCe Case!!!', title: 'Quarantined item', priority: 'P1', estimatedComplexity: 'low', files: ['b.ts'] },
      { id: 'backlog', title: 'Prefix only item', priority: 'P1', estimatedComplexity: 'low', files: ['c.ts'] },
    ]);
    writeQuarantine(['  Backlog Space Case  ', '!!!', '   ']);

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Keep me');
    expect(titles).not.toContain('Quarantined item');
    expect(titles).not.toContain('Prefix only item');
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

  it('normalizes mixed raw/canonical completed ids across itemId and legacy id fields', async () => {
    writeBacklog([
      { id: 'keep', title: 'Keep me', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
      { id: 'Raw Done', title: 'Raw done item', priority: 'P1', estimatedComplexity: 'low', files: ['b.ts'] },
      { id: 'backlog-canonical-done', title: 'Canonical done item', priority: 'P1', estimatedComplexity: 'low', files: ['c.ts'] },
      { id: 'legacy done', title: 'Legacy done item', priority: 'P1', estimatedComplexity: 'low', files: ['d.ts'] },
    ]);
    writeCompletedLedger({
      entries: [
        { itemId: '  raw done  ', completedAt: '2026-05-27T00:00:00.000Z' },
        { itemId: '\tBACKLOG-canonical-done\n', completedAt: '2026-05-27T00:00:00.000Z' },
        { id: ' Legacy Done!!! ', completedAt: '2026-05-27T00:00:00.000Z' },
        { itemId: '   ' },
      ],
    });

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Keep me');
    expect(titles).not.toContain('Raw done item');
    expect(titles).not.toContain('Canonical done item');
    expect(titles).not.toContain('Legacy done item');
  });

  it('filters duplicate backlog items that normalize to the same completed id', async () => {
    writeBacklog([
      { id: 'alpha', title: 'Alpha one', priority: 'P1', estimatedComplexity: 'low', files: ['a.ts'] },
      { id: 'ALPHA!!!', title: 'Alpha two', priority: 'P1', estimatedComplexity: 'low', files: ['b.ts'] },
      { id: 'beta', title: 'Beta keep', priority: 'P1', estimatedComplexity: 'low', files: ['c.ts'] },
    ]);
    writeCompletedLedger({
      entries: [{ itemId: ' backlog alpha ', completedAt: '2026-05-27T00:00:00.000Z' }],
    });

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Beta keep');
    expect(titles).not.toContain('Alpha one');
    expect(titles).not.toContain('Alpha two');
  });

  it('filters completed research-plan ids using the same normalization path', async () => {
    writeResearchRun('rd-run-completed', {
      runId: 'rd-run-completed',
      plannedCycle: { ideaIds: ['idea-01', 'idea-02'] },
      ideas: [
        {
          ideaId: 'idea-01',
          title: 'Completed research idea',
          problem: 'P',
          hypothesis: 'H',
          expectedImpact: 'E',
          acceptanceChecks: ['A'],
          touchedAreas: ['packages/core/src/autonomous/proposal-to-backlog.ts'],
          risk: 'low',
          status: 'planned',
        },
        {
          ideaId: 'idea-02',
          title: 'Visible research idea',
          problem: 'P',
          hypothesis: 'H',
          expectedImpact: 'E',
          acceptanceChecks: ['A'],
          touchedAreas: ['packages/core/src/autonomous/proposal-to-backlog.ts'],
          risk: 'medium',
          status: 'planned',
        },
      ],
    });
    writeCompletedLedger({
      entries: [{ itemId: '  research rd run completed idea 01  ', completedAt: '2026-05-27T00:00:00.000Z' }],
    });

    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    const titles = items.filter((i) => i.source === 'research-plan').map((i) => i.title);
    expect(titles).toContain('Visible research idea');
    expect(titles).not.toContain('Completed research idea');
  });

  it('tolerates a missing backlog directory', async () => {
    rmSync(join(root, '.agentforge', 'backlog'), { recursive: true, force: true });
    const items = await new ProposalToBacklog(emptyAdapter, root, cfg()).build();
    expect(items).toEqual([]);
  });
});
