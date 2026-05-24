import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createResearchRun,
  listResearchRuns,
  planApprovedResearchIdeas,
  readResearchRun,
  updateResearchIdeaStatus,
  type ResearchRunMode,
} from '@agentforge/core';

interface ResearchRoutesOptions {
  projectRoot: string;
}

interface CreateResearchRunBody {
  prompt?: unknown;
  mode?: unknown;
  maxIdeas?: unknown;
  tags?: unknown;
  sourceCycleId?: unknown;
}

interface IdeaDecisionBody {
  note?: unknown;
}

interface PlanResearchRunBody {
  budgetUsd?: unknown;
  maxItems?: unknown;
  maxAgents?: unknown;
  branchPrefix?: unknown;
  baseBranch?: unknown;
  dryRun?: unknown;
  fastMode?: unknown;
  modelCap?: unknown;
  effortCap?: unknown;
  fallbackEnabled?: unknown;
}

const SAFE_ID = /^[A-Za-z0-9_-]{3,80}$/;

export async function researchRunsRoutes(app: FastifyInstance, opts: ResearchRoutesOptions): Promise<void> {
  app.get('/api/v5/research-runs', async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = normalizeLimit(query.limit);
    const runs = listResearchRuns(opts.projectRoot, limit);
    return reply.send({ data: runs, meta: { total: runs.length, timestamp: new Date().toISOString() } });
  });

  app.post<{ Body: CreateResearchRunBody }>('/api/v5/research-runs', async (req, reply) => {
    const parsed = parseCreateBody(req.body ?? {});
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error });

    const run = await createResearchRun({
      projectRoot: opts.projectRoot,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      mode: parsed.mode,
      maxIdeas: parsed.maxIdeas,
      tags: parsed.tags,
      ...(parsed.sourceCycleId ? { sourceCycleId: parsed.sourceCycleId } : {}),
    });

    return reply.status(201).send({ data: run, meta: { timestamp: new Date().toISOString() } });
  });

  app.get<{ Params: { runId: string } }>('/api/v5/research-runs/:runId', async (req, reply) => {
    const { runId } = req.params;
    if (!SAFE_ID.test(runId)) return reply.status(400).send({ error: 'Invalid research run id' });
    const run = readResearchRun(opts.projectRoot, runId);
    if (!run) return reply.status(404).send({ error: 'Research run not found', runId });
    return reply.send({ data: run, meta: { timestamp: new Date().toISOString() } });
  });

  app.post<{ Params: { runId: string; ideaId: string }; Body: IdeaDecisionBody }>(
    '/api/v5/research-runs/:runId/ideas/:ideaId/approve',
    async (req, reply) => updateIdea(req, reply, opts.projectRoot, 'approved'),
  );

  app.post<{ Params: { runId: string; ideaId: string }; Body: IdeaDecisionBody }>(
    '/api/v5/research-runs/:runId/ideas/:ideaId/reject',
    async (req, reply) => updateIdea(req, reply, opts.projectRoot, 'rejected'),
  );

  app.post<{ Params: { runId: string }; Body: PlanResearchRunBody }>(
    '/api/v5/research-runs/:runId/plan',
    async (req, reply) => {
      const { runId } = req.params;
      if (!SAFE_ID.test(runId)) return reply.status(400).send({ error: 'Invalid research run id' });
      const parsed = parsePlanBody(req.body ?? {});
      if ('error' in parsed) return reply.status(400).send({ error: parsed.error });

      try {
        const run = await planApprovedResearchIdeas({
          projectRoot: opts.projectRoot,
          runId,
          ...parsed,
        });
        return reply.send({ data: run, meta: { timestamp: new Date().toISOString() } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('not found') ? 404 : 409;
        return reply.status(status).send({ error: message, runId });
      }
    },
  );
}

async function updateIdea(
  req: {
    params: { runId: string; ideaId: string };
    body?: IdeaDecisionBody;
  },
  reply: FastifyReply,
  projectRoot: string,
  status: 'approved' | 'rejected',
): Promise<unknown> {
  const { runId, ideaId } = req.params;
  if (!SAFE_ID.test(runId)) return reply.status(400).send({ error: 'Invalid research run id' });
  if (!SAFE_ID.test(ideaId)) return reply.status(400).send({ error: 'Invalid research idea id' });
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;

  try {
    const run = await updateResearchIdeaStatus({
      projectRoot,
      runId,
      ideaId,
      status,
      ...(note ? { note } : {}),
    });
    return reply.send({ data: run, meta: { timestamp: new Date().toISOString() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const responseStatus = message.includes('not found') ? 404 : 409;
    return reply.status(responseStatus).send({ error: message, runId, ideaId });
  }
}

function parseCreateBody(body: CreateResearchRunBody):
  | { prompt?: string; mode: ResearchRunMode; maxIdeas: number; tags: string[]; sourceCycleId?: string }
  | { error: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
  if (body.prompt !== undefined && typeof body.prompt !== 'string') return { error: 'prompt must be a string' };
  const mode = body.mode === undefined ? 'operator-seeded' : body.mode;
  if (mode !== 'operator-seeded' && mode !== 'autonomous') return { error: 'mode must be operator-seeded or autonomous' };
  const maxIdeas = body.maxIdeas === undefined ? 3 : body.maxIdeas;
  if (typeof maxIdeas !== 'number' || !Number.isInteger(maxIdeas) || maxIdeas <= 0 || maxIdeas > 6) {
    return { error: 'maxIdeas must be an integer from 1 to 6' };
  }
  const tags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    return { error: 'tags must be an array of strings' };
  }
  const sourceCycleId = typeof body.sourceCycleId === 'string' && body.sourceCycleId.trim()
    ? body.sourceCycleId.trim()
    : undefined;
  return {
    ...(prompt ? { prompt } : {}),
    mode,
    maxIdeas,
    tags: tags.map((tag) => tag.trim()).filter(Boolean),
    ...(sourceCycleId ? { sourceCycleId } : {}),
  };
}

function parsePlanBody(body: PlanResearchRunBody):
  | {
      budgetUsd?: number;
      maxItems?: number;
      maxAgents?: number;
      branchPrefix?: string;
      baseBranch?: string;
      dryRun?: boolean;
      modelCap?: 'opus' | 'sonnet' | 'haiku';
      effortCap?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      fastMode?: boolean;
      fallbackEnabled?: boolean;
    }
  | { error: string } {
  const parsed: {
    budgetUsd?: number;
    maxItems?: number;
    maxAgents?: number;
    branchPrefix?: string;
    baseBranch?: string;
    dryRun?: boolean;
    modelCap?: 'opus' | 'sonnet' | 'haiku';
    effortCap?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    fastMode?: boolean;
    fallbackEnabled?: boolean;
  } = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === 'budgetUsd') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { error: 'budgetUsd must be a positive number' };
      parsed.budgetUsd = value;
    } else if (key === 'maxItems') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return { error: `${key} must be a positive integer` };
      parsed.maxItems = value;
    } else if (key === 'maxAgents') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return { error: `${key} must be a positive integer` };
      parsed.maxAgents = value;
    } else if (key === 'branchPrefix') {
      if (typeof value !== 'string') return { error: `${key} must be a string` };
      parsed.branchPrefix = value.trim();
    } else if (key === 'baseBranch') {
      if (typeof value !== 'string') return { error: `${key} must be a string` };
      parsed.baseBranch = value.trim();
    } else if (key === 'dryRun') {
      if (typeof value !== 'boolean') return { error: `${key} must be a boolean` };
      parsed.dryRun = value;
    } else if (key === 'fastMode') {
      if (typeof value !== 'boolean') return { error: `${key} must be a boolean` };
      parsed.fastMode = value;
    } else if (key === 'fallbackEnabled') {
      if (typeof value !== 'boolean') return { error: `${key} must be a boolean` };
      parsed.fallbackEnabled = value;
    } else if (key === 'modelCap') {
      if (value !== 'opus' && value !== 'sonnet' && value !== 'haiku') return { error: 'modelCap must be one of: opus, sonnet, haiku' };
      parsed.modelCap = value;
    } else if (key === 'effortCap') {
      if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'xhigh' && value !== 'max') {
        return { error: 'effortCap must be one of: low, medium, high, xhigh, max' };
      }
      parsed.effortCap = value;
    }
  }

  return parsed;
}

function normalizeLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '50', 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
}
