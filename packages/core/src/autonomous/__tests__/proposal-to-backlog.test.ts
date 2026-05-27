import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProposalToBacklog, type ProposalAdapter } from '../proposal-to-backlog.js';
import type { CycleConfig } from '../types.js';

const adapter: ProposalAdapter = {
  getRecentFailedSessions: async () => [],
  getCostAnomalies: async () => [],
  getFailedTaskOutcomes: async () => [],
  getFlakingTests: async () => [],
};

const config = {
  sourcing: {
    lookbackDays: 7,
    minProposalConfidence: 0.6,
    includeTodoMarkers: false,
    todoMarkerPattern: 'TODO\\(autonomous\\)|FIXME\\(autonomous\\)',
  },
} as CycleConfig;

describe('ProposalToBacklog', () => {
  let projectRoot: string;
  let previousUnattended: string | undefined;

  beforeEach(() => {
    previousUnattended = process.env['AGENTFORGE_UNATTENDED'];
    delete process.env['AGENTFORGE_UNATTENDED'];
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-proposal-backlog-'));
    mkdirSync(join(projectRoot, '.agentforge', 'backlog'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (previousUnattended === undefined) {
      delete process.env['AGENTFORGE_UNATTENDED'];
    } else {
      process.env['AGENTFORGE_UNATTENDED'] = previousUnattended;
    }
  });

  it('loads checked-in .agentforge/backlog JSON items as cycle candidates', async () => {
    writeFileSync(
      join(projectRoot, '.agentforge', 'backlog', 'codex.json'),
      JSON.stringify({
        items: [
          {
            id: 'codex-ui-cycle',
            title: 'Verify Codex cycle management UI',
            description: 'Make sure the Codex dashboard can launch and inspect cycles.',
            priority: 'P1',
            estimatedComplexity: 'low',
            tags: ['ui', 'codex'],
          },
        ],
      }),
    );

    const backlog = await new ProposalToBacklog(adapter, projectRoot, config).build();

    expect(backlog).toHaveLength(1);
    expect(backlog[0]).toMatchObject({
      id: 'backlog-codex-ui-cycle',
      title: 'Verify Codex cycle management UI',
      priority: 'P1',
      source: 'backlog-file',
      tags: ['ui', 'codex'],
      estimatedCostUsd: 1,
    });
  });
});
