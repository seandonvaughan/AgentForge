import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchRunsRoutes } from '../research-runs.js';

describe('research-runs routes', () => {
  let projectRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-research-route-'));
    app = Fastify({ logger: false });
    await researchRunsRoutes(app, { projectRoot });
  });

  afterEach(async () => {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates a research run, approves an idea, and plans a cycle request', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v5/research-runs',
      payload: {
        prompt: 'Improve AgentForge reliability',
        maxIdeas: 2,
        tags: ['ui'],
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ data: { runId: string; ideas: Array<{ ideaId: string; status: string }> } }>().data;
    expect(created.ideas).toHaveLength(2);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v5/research-runs/${created.runId}/ideas/${created.ideas[0]!.ideaId}/approve`,
      payload: { note: 'operator approved' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ data: { ideas: Array<{ ideaId: string; status: string }> } }>().data.ideas[0]?.status).toBe('approved');

    const plan = await app.inject({
      method: 'POST',
      url: `/api/v5/research-runs/${created.runId}/plan`,
      payload: {
        budgetUsd: 15,
        maxItems: 1,
        maxAgents: 2,
        dryRun: true,
        branchPrefix: 'codex/',
        baseBranch: 'codex/codex-version',
      },
    });
    expect(plan.statusCode).toBe(200);
    const planned = plan.json<{ data: { status: string; plannedCycle: { cycleRequest: Record<string, unknown> } } }>().data;
    expect(planned.status).toBe('planned');
    expect(planned.plannedCycle.cycleRequest).toMatchObject({
      budgetUsd: 15,
      maxItems: 1,
      maxAgents: 2,
      dryRun: true,
      fastMode: true,
      effortCap: 'high',
      branchPrefix: 'codex/',
      baseBranch: 'codex/codex-version',
    });
  });

  it('rejects invalid create payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/research-runs',
      payload: { maxIdeas: 20 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('maxIdeas');
  });

  it('returns 409 when planning without approved ideas', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v5/research-runs',
      payload: { maxIdeas: 1 },
    });
    const runId = create.json<{ data: { runId: string } }>().data.runId;

    const plan = await app.inject({
      method: 'POST',
      url: `/api/v5/research-runs/${runId}/plan`,
      payload: {},
    });

    expect(plan.statusCode).toBe(409);
    expect(plan.json<{ error: string }>().error).toContain('No approved');
  });
});
