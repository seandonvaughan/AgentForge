import type { FastifyInstance } from 'fastify';
import {
  AgentRuntime,
  loadAgentConfig,
  recordManualInvokeMemory,
  resolveProviderModelProfile,
  type AgentRuntimeConfig,
  type RunResult,
  type RuntimeMode,
} from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { join } from 'node:path';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { safeJoin } from '../../lib/safe-join.js';

/** Agent IDs must be kebab-case slugs — no path separators, no traversal. */
const SAFE_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type CapabilityTier = 'fable' | 'opus' | 'sonnet' | 'haiku';

function normalizeCapabilityTier(value: unknown): CapabilityTier {
  return value === 'fable' || value === 'opus' || value === 'haiku' ? value : 'sonnet';
}

function toCodexModelProfile(
  projectRoot: string,
  tier: CapabilityTier,
  effort: string | null,
): { provider: 'codex-cli'; tier: CapabilityTier; modelId: string; effort: string } {
  const profile = resolveProviderModelProfile('codex-cli', tier, effort ?? undefined, process.env, projectRoot);
  return {
    provider: 'codex-cli',
    tier,
    modelId: profile.modelId,
    effort: profile.effort ?? effort ?? '',
  };
}

function manualMemorySkills(config: AgentRuntimeConfig, agentId: string): string[] {
  if (config.skillIds?.length) return config.skillIds;
  if (config.resolvedSkills?.length) return config.resolvedSkills.map((skill) => skill.id);
  return agentId.toLowerCase().split(/[-_]/).filter(Boolean);
}

function recordAgentRouteInvokeMemory(input: {
  projectRoot: string;
  agentId: string;
  config: AgentRuntimeConfig;
  task: string;
  result?: RunResult;
  error?: string;
}): void {
  try {
    recordManualInvokeMemory({
      projectRoot: input.projectRoot,
      agent: {
        agentId: input.agentId,
        skills: manualMemorySkills(input.config, input.agentId),
      },
      task: input.task,
      ...(input.result ? { result: input.result } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
  } catch {
    // Memory writes must not break invoke responses.
  }
}

export async function agentRoutes(
  app: FastifyInstance,
  opts: { adapter?: WorkspaceAdapter; projectRoot: string },
): Promise<void> {
  const agentforgeDir = join(opts.projectRoot, '.agentforge');

  // GET /api/v5/agents — list agents from .agentforge/agents/*.yaml
  // Returns rich display data (name, model, description, role) from YAML directly.
  app.get('/api/v5/agents', async (_req, reply) => {
    try {
      const agentsDir = join(agentforgeDir, 'agents');
      if (!existsSync(agentsDir)) return reply.send({ data: [], meta: { total: 0 } });

      const files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
      const data = files.flatMap(f => {
        const agentId = f.replace(/\.ya?ml$/, '');
        try {
          const raw = yaml.load(readFileSync(join(agentsDir, f), 'utf-8')) as Record<string, unknown> | null;
          if (!raw || typeof raw !== 'object') return [];
          const model = normalizeCapabilityTier(raw.model);
          const effort = typeof raw.effort === 'string' ? raw.effort : null;
          return [{
            agentId,
            name: typeof raw.name === 'string' ? raw.name : agentId,
            model,
            capabilityTier: model,
            modelProfile: toCodexModelProfile(opts.projectRoot, model, effort),
            description: typeof raw.description === 'string' ? raw.description.trim() : null,
            role: typeof raw.role === 'string' ? raw.role : null,
            team: typeof raw.team === 'string' ? raw.team : null,
            effort,
          }];
        } catch {
          return [];
        }
      });

      data.sort((a, b) => a.agentId.localeCompare(b.agentId));
      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v5/agents/:id
  app.get<{ Params: { id: string } }>('/api/v5/agents/:id', async (req, reply) => {
    const agentId = req.params.id;
    if (!SAFE_AGENT_ID.test(agentId)) return reply.status(400).send({ error: 'Invalid agent id' });
    const filePath = safeJoin(join(agentforgeDir, 'agents'), `${agentId}.yaml`);
    if (!filePath || !existsSync(filePath)) return reply.status(404).send({ error: 'Agent not found' });
    try {
      const raw = yaml.load(readFileSync(filePath, 'utf-8')) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') return reply.status(404).send({ error: 'Agent not found' });
      const model = normalizeCapabilityTier(raw.model);
      const effort = typeof raw.effort === 'string' ? raw.effort : null;
      const skillsRaw = Array.isArray(raw.skills) ? raw.skills : [];
      const skills = skillsRaw.filter((s): s is string => typeof s === 'string');

      // Extract collaboration fields from YAML collaboration block
      const collabRaw = raw.collaboration && typeof raw.collaboration === 'object'
        ? raw.collaboration as Record<string, unknown>
        : {};
      const reportsTo = typeof collabRaw.reports_to === 'string' ? collabRaw.reports_to : null;
      const canDelegateTo = Array.isArray(collabRaw.can_delegate_to)
        ? collabRaw.can_delegate_to.filter((s): s is string => typeof s === 'string')
        : [];

      return reply.send({
        data: {
          agentId,
          name: typeof raw.name === 'string' ? raw.name : agentId,
          model,
          capabilityTier: model,
          modelProfile: toCodexModelProfile(opts.projectRoot, model, effort),
          description: typeof raw.description === 'string' ? raw.description.trim() : null,
          role: typeof raw.role === 'string' ? raw.role : null,
          effort,
          systemPrompt: typeof raw.system_prompt === 'string' ? raw.system_prompt : null,
          skills,
          version: typeof raw.version === 'string' ? raw.version : null,
          seniority: typeof raw.seniority === 'string' ? raw.seniority : null,
          layer: typeof raw.layer === 'string' ? raw.layer : null,
          reportsTo,
          canDelegateTo,
        },
      });
    } catch {
      return reply.status(404).send({ error: 'Agent not found' });
    }
  });

  // POST /api/v5/agents/:id/run — invoke an agent
  app.post<{ Params: { id: string } }>('/api/v5/agents/:id/run', async (req, reply) => {
    const agentIdParam = req.params.id;
    if (!SAFE_AGENT_ID.test(agentIdParam)) return reply.status(400).send({ error: 'Invalid agent id' });

    const { task, context, parentSessionId, budgetUsd, runtimeMode } = req.body as {
      task: string;
      context?: string;
      parentSessionId?: string;
      budgetUsd?: number;
      runtimeMode?: RuntimeMode;
    };

    if (!task) return reply.status(400).send({ error: 'task is required' });

    // Thread the workspace adapter into config-loading so any DMs queued for
    // this agent are picked up + marked delivered before the run starts.
    const config = await loadAgentConfig(
      agentIdParam,
      agentforgeDir,
      opts.adapter ? { adapter: opts.adapter } : {},
    );
    if (!config) return reply.status(404).send({ error: 'Agent not found' });

    config.workspaceId = 'default';
    const runtime = new AgentRuntime(config, opts.adapter);
    const runOpts = {
      task,
      ...(context !== undefined ? { context } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      runtimeMode: runtimeMode ?? ('codex-cli' as RuntimeMode),
    };
    let result;
    try {
      result = await runtime.run(runOpts);
    } catch (err) {
      recordAgentRouteInvokeMemory({
        projectRoot: opts.projectRoot,
        agentId: agentIdParam,
        config,
        task,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    recordAgentRouteInvokeMemory({
      projectRoot: opts.projectRoot,
      agentId: agentIdParam,
      config,
      task,
      result,
    });

    return reply.send({ data: result });
  });

  // GET /api/v5/agents/:id/scorecard — performance score (requires adapter)
  app.get<{ Params: { id: string } }>('/api/v5/agents/:id/scorecard', async (req, reply) => {
    if (!SAFE_AGENT_ID.test(req.params.id)) return reply.status(400).send({ error: 'Invalid agent id' });
    if (!opts.adapter) return reply.status(503).send({ error: 'No adapter configured' });
    const score = opts.adapter.getAgentScore(req.params.id);
    if (!score) return reply.status(404).send({ error: 'No scorecard data for this agent' });
    return reply.send({ data: score });
  });

  // GET /api/v5/scorecards — list all agent scores (requires adapter)
  app.get('/api/v5/scorecards', async (_req, reply) => {
    if (!opts.adapter) return reply.send({ data: [], meta: { total: 0 } });
    const scores = opts.adapter.listAgentScores();
    return reply.send({ data: scores, meta: { total: scores.length } });
  });

  // GET /api/v5/agents/activity — per-agent activity rollup over the last 24h.
  // Reads `.agentforge/cycles/*/phases/execute.json` directly (authoritative
  // source for cycle-runner-driven agent dispatches). The legacy `sessions`
  // SQL table fed by the in-server executor is stale because `agentforge cycle
  // run` doesn't write there. Powers the /agents page sparklines + lastActive
  // + spend KPIs that were showing zeros.
  app.get('/api/v5/agents/activity', async (_req, reply) => {
    const cyclesDir = join(agentforgeDir, 'cycles');
    if (!existsSync(cyclesDir)) return reply.send({ data: [], meta: { total: 0, windowHours: 24 } });

    const horizonMs = Date.now() - 24 * 60 * 60 * 1000;
    interface Activity {
      agentId: string;
      invocations24h: number;
      spend24h: number;
      lastActiveAt: string | null;
      /** 12 buckets × 2h covering the last 24h (oldest first). */
      sparkline: number[];
    }
    const byAgent = new Map<string, Activity>();
    const bucketMs = 2 * 60 * 60 * 1000;

    let cycleIds: string[];
    try {
      cycleIds = readdirSync(cyclesDir);
    } catch {
      return reply.send({ data: [], meta: { total: 0, windowHours: 24 } });
    }

    for (const id of cycleIds) {
      const execPath = join(cyclesDir, id, 'phases', 'execute.json');
      if (!existsSync(execPath)) continue;

      // Per-cycle fallback timestamp — itemResults rows often lack their own
      // startedAt/completedAt, so we fall back to the parent cycle's
      // completedAt/startedAt (read from cycle.json).
      let cycleFallbackMs: number | null = null;
      const cyclePath = join(cyclesDir, id, 'cycle.json');
      if (existsSync(cyclePath)) {
        try {
          const cyc = JSON.parse(readFileSync(cyclePath, 'utf8')) as { completedAt?: string; startedAt?: string };
          const ref = cyc.completedAt ?? cyc.startedAt;
          if (ref) cycleFallbackMs = new Date(ref).getTime();
        } catch { /* ignore */ }
      }

      interface Run {
        agentId?: string;
        startedAt?: string;
        completedAt?: string;
        costUsd?: number;
        cost_usd?: number;
      }
      let exec: { agentRuns?: Run[]; itemResults?: Run[] };
      try {
        exec = JSON.parse(readFileSync(execPath, 'utf8')) as typeof exec;
      } catch { continue; }

      // Newer cycles emit `agentRuns`; older ones emit `itemResults`. Both
      // carry `agentId` + `costUsd`; agentRuns also has startedAt/completedAt.
      const runs: Run[] = exec.agentRuns ?? exec.itemResults ?? [];

      for (const r of runs) {
        const agentId = r.agentId;
        if (!agentId) continue;
        const ts = r.completedAt ?? r.startedAt;
        const ms = ts ? new Date(ts).getTime() : cycleFallbackMs;
        if (ms === null || ms < horizonMs) continue;

        const cost = r.costUsd ?? r.cost_usd ?? 0;

        let row = byAgent.get(agentId);
        if (!row) {
          row = { agentId, invocations24h: 0, spend24h: 0, lastActiveAt: null, sparkline: new Array<number>(12).fill(0) };
          byAgent.set(agentId, row);
        }
        row.invocations24h++;
        row.spend24h += cost;
        if (!row.lastActiveAt || ms > new Date(row.lastActiveAt).getTime()) {
          row.lastActiveAt = new Date(ms).toISOString();
        }
        const bucketIdx = Math.min(11, Math.max(0, Math.floor((ms - horizonMs) / bucketMs)));
        row.sparkline[bucketIdx]!++;
      }
    }

    const data = [...byAgent.values()].sort((a, b) => b.spend24h - a.spend24h);
    return reply.send({ data, meta: { total: data.length, windowHours: 24 } });
  });
}
