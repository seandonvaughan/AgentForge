import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResearchRun,
  listResearchRuns,
  planApprovedResearchIdeas,
  readResearchRun,
  researchRunsDir,
  updateResearchIdeaStatus,
} from '../research-run-store.js';

describe('research-run-store', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-research-store-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates durable R&D run and idea artifacts', async () => {
    const run = await createResearchRun({
      projectRoot,
      prompt: 'Find reliability work',
      maxIdeas: 2,
      tags: ['launch'],
    });

    expect(run.runId).toMatch(/^rd-/);
    expect(run.ideas).toHaveLength(2);
    expect(run.tags).toContain('rd');
    expect(existsSync(join(researchRunsDir(projectRoot), run.runId, 'run.json'))).toBe(true);
    expect(existsSync(join(researchRunsDir(projectRoot), run.runId, 'ideas', 'idea-01.json'))).toBe(true);

    const events = readFileSync(join(researchRunsDir(projectRoot), run.runId, 'events.jsonl'), 'utf-8');
    expect(events).toContain('research.created');
    expect(events).toContain('research.ideas.ready');
  });

  it('approves an idea and converts approved ideas into a cycle request', async () => {
    const run = await createResearchRun({ projectRoot, maxIdeas: 2 });
    const approved = await updateResearchIdeaStatus({
      projectRoot,
      runId: run.runId,
      ideaId: 'idea-01',
      status: 'approved',
      note: 'ship it',
    });

    expect(approved.ideas.find((idea) => idea.ideaId === 'idea-01')?.status).toBe('approved');

    const planned = await planApprovedResearchIdeas({
      projectRoot,
      runId: run.runId,
      budgetUsd: 12,
      maxItems: 1,
      maxAgents: 3,
      dryRun: true,
      modelCap: 'sonnet',
      effortCap: 'high',
    });

    expect(planned.status).toBe('planned');
    expect(planned.plannedCycle?.ideaIds).toEqual(['idea-01']);
    expect(planned.plannedCycle?.cycleRequest).toMatchObject({
      budgetUsd: 12,
      maxItems: 1,
      maxAgents: 3,
      dryRun: true,
      fastMode: true,
      modelCap: 'sonnet',
      effortCap: 'high',
    });
    expect(readResearchRun(projectRoot, run.runId)?.plannedCycle?.title).toBeTruthy();
    expect(listResearchRuns(projectRoot)).toHaveLength(1);
  });

  it('refuses to plan when no ideas are approved', async () => {
    const run = await createResearchRun({ projectRoot });

    await expect(planApprovedResearchIdeas({ projectRoot, runId: run.runId })).rejects.toThrow(
      'No approved research ideas',
    );
  });

  it('uses high effort for default fast-mode plans', async () => {
    const run = await createResearchRun({ projectRoot, maxIdeas: 1 });
    await updateResearchIdeaStatus({
      projectRoot,
      runId: run.runId,
      ideaId: 'idea-01',
      status: 'approved',
    });

    const planned = await planApprovedResearchIdeas({ projectRoot, runId: run.runId });

    expect(planned.plannedCycle?.cycleRequest.fastMode).toBe(true);
    expect(planned.plannedCycle?.cycleRequest.effortCap).toBe('high');
  });
});
