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

  it('sources only planned research ideas from research runs', async () => {
    mkdirSync(join(projectRoot, '.agentforge', 'research-runs', 'rd-run-001'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'research-runs', 'rd-run-001', 'run.json'),
      JSON.stringify({
        runId: 'rd-run-001',
        plannedCycle: { ideaIds: ['idea-01', 'idea-04'] },
        ideas: [
          {
            ideaId: 'idea-01',
            title: 'Planned idea',
            problem: 'P',
            hypothesis: 'H',
            expectedImpact: 'E',
            acceptanceChecks: ['A1', 'A2'],
            touchedAreas: ['packages/core/src/autonomous/proposal-to-backlog.ts'],
            risk: 'medium',
            status: 'planned',
          },
          {
            ideaId: 'idea-02',
            title: 'Rejected idea',
            problem: 'P2',
            hypothesis: 'H2',
            expectedImpact: 'E2',
            acceptanceChecks: ['B1'],
            touchedAreas: ['README.md'],
            risk: 'low',
            status: 'rejected',
          },
          {
            ideaId: 'idea-03',
            title: 'Proposed idea',
            problem: 'P3',
            hypothesis: 'H3',
            expectedImpact: 'E3',
            acceptanceChecks: ['C1'],
            touchedAreas: ['README.md'],
            risk: 'low',
            status: 'proposed',
          },
          {
            ideaId: 'idea-04',
            title: 'Executed idea',
            problem: 'P4',
            hypothesis: 'H4',
            expectedImpact: 'E4',
            acceptanceChecks: ['D1'],
            touchedAreas: ['README.md'],
            risk: 'low',
            status: 'executed',
          },
        ],
      }),
    );

    const backlog = await new ProposalToBacklog(adapter, projectRoot, config).build();
    const planned = backlog.filter((item) => item.source === 'research-plan');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      id: 'backlog-research-rd-run-001-idea-01',
      title: 'Planned idea',
      source: 'research-plan',
      estimatedComplexity: 'medium',
      files: ['packages/core/src/autonomous/proposal-to-backlog.ts'],
    });
    expect(planned[0]?.description).toContain('Problem: P');
    expect(planned[0]?.description).toContain('Hypothesis: H');
    expect(planned[0]?.description).toContain('Expected impact: E');
    expect(planned[0]?.description).toContain('Acceptance checks: - A1; - A2');
    expect(planned.some((item) => item.title === 'Executed idea')).toBe(false);
  });

  it('ignores malformed and partial research runs', async () => {
    mkdirSync(join(projectRoot, '.agentforge', 'research-runs', 'rd-bad-json'), { recursive: true });
    writeFileSync(join(projectRoot, '.agentforge', 'research-runs', 'rd-bad-json', 'run.json'), '{ bad');
    mkdirSync(join(projectRoot, '.agentforge', 'research-runs', 'rd-missing-plan'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'research-runs', 'rd-missing-plan', 'run.json'),
      JSON.stringify({ runId: 'rd-missing-plan', ideas: [] }),
    );
    mkdirSync(join(projectRoot, '.agentforge', 'research-runs', 'rd-empty-plan'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'research-runs', 'rd-empty-plan', 'run.json'),
      JSON.stringify({ runId: 'rd-empty-plan', plannedCycle: { ideaIds: [] }, ideas: [] }),
    );

    const backlog = await new ProposalToBacklog(adapter, projectRoot, config).build();
    expect(backlog.filter((item) => item.source === 'research-plan')).toEqual([]);
  });
});
