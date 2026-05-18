/**
 * quality.ts — /api/v5/quality/* routes
 *
 *   GET /api/v5/quality/step-scores   — paginated JSONL rows
 *   GET /api/v5/quality/aggregates    — per-agent / per-skill / per-model means
 *   GET /api/v5/quality/skill-effectiveness — paired with vs without skill
 *
 * All responses are cached for 5 s (module-level Map keyed by request URL).
 * All routes are audit-logged via appendAuditEntry (read-only).
 */

import type { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStepScores, windowCutoff, type StepScore, type Window } from '../../lib/quality-jsonl-reader.js';
import { openAuditDb, appendAuditEntry } from './audit.js';
import { generateId, nowIso } from '@agentforge/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface QualityRouteOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// 5-second module-level response cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  payload: unknown;
  expiresAt: number;
}
const _cache = new Map<string, CacheEntry>();

function fromCache(key: string): unknown | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return entry.payload;
}

function toCache(key: string, payload: unknown): void {
  _cache.set(key, { payload, expiresAt: Date.now() + 5_000 });
}

// ---------------------------------------------------------------------------
// Path / ID safety helpers
// ---------------------------------------------------------------------------

/** Match-then-use: validate cycleId contains only safe chars, return the
 *  validated value (never the raw input in subsequent logic). */
function safeId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = raw.match(/^[a-zA-Z0-9_\-.]{1,128}$/);
  return match ? match[0] : undefined;
}

// ---------------------------------------------------------------------------
// Shared filter predicate
// ---------------------------------------------------------------------------

interface StepScoreFilters {
  since?: string;
  agent_id?: string;
  skill_id?: string;
  cycle_id?: string;
}

function applyFilters(rows: StepScore[], filters: StepScoreFilters): StepScore[] {
  let result = rows;

  if (filters.since !== undefined) {
    const since = filters.since;
    result = result.filter(r => {
      const ts = r.created_at ?? '';
      return ts >= since;
    });
  }

  if (filters.agent_id !== undefined) {
    const agentId = filters.agent_id;
    // Use String.includes() per mandatory requirement
    result = result.filter(r => typeof r.agent_id === 'string' && r.agent_id.includes(agentId));
  }

  if (filters.skill_id !== undefined) {
    const skillId = filters.skill_id;
    result = result.filter(r => typeof r.skill_id === 'string' && r.skill_id.includes(skillId));
  }

  if (filters.cycle_id !== undefined) {
    const cycleId = filters.cycle_id; // already validated via safeId
    result = result.filter(r => r.cycle_id === cycleId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

interface AgentAgg {
  agent_id: string;
  mean_quality: number;
  mean_cost: number;
  count: number;
}

interface SkillAgg {
  skill_id: string;
  mean_quality: number;
  mean_cost: number;
  count: number;
}

interface ModelAgg {
  model: string;
  mean_quality: number;
  mean_cost: number;
  count: number;
}

function aggregateBy<K extends string>(
  rows: StepScore[],
  keyFn: (r: StepScore) => K | undefined,
  keyName: string,
): Array<Record<string, unknown>> {
  const buckets = new Map<string, { quality: number[]; cost: number[]; count: number }>();

  for (const row of rows) {
    const k = keyFn(row);
    if (!k) continue;
    let b = buckets.get(k);
    if (!b) {
      b = { quality: [], cost: [], count: 0 };
      buckets.set(k, b);
    }
    b.count++;
    if (typeof row.quality_score === 'number') b.quality.push(row.quality_score);
    if (typeof row.cost_usd === 'number') b.cost.push(row.cost_usd);
  }

  const result: Array<Record<string, unknown>> = [];
  for (const [k, b] of buckets) {
    const meanQuality = b.quality.length > 0
      ? b.quality.reduce((s, v) => s + v, 0) / b.quality.length
      : 0;
    const meanCost = b.cost.length > 0
      ? b.cost.reduce((s, v) => s + v, 0) / b.cost.length
      : 0;
    result.push({
      [keyName]: k,
      mean_quality: meanQuality,
      mean_cost: meanCost,
      count: b.count,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function qualityRoutes(
  app: FastifyInstance,
  opts: QualityRouteOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    auditDb.close();
  });

  // ── GET /api/v5/quality/step-scores ─────────────────────────────────────

  app.get('/api/v5/quality/step-scores', async (req, reply) => {
    const q = req.query as {
      since?: string;
      agent_id?: string;
      skill_id?: string;
      cycle_id?: string;
      limit?: string;
    };

    const limit = Math.min(parseInt(q.limit ?? '500', 10), 500);
    const cacheKey = `${projectRoot}:step-scores:${JSON.stringify(q)}`;
    const cached = fromCache(cacheKey);
    if (cached !== undefined) return reply.send(cached);

    const { rows: allRows, truncated } = await scanStepScores(projectRoot);

    // match-then-use for cycle_id
    const safeCycleId = safeId(q.cycle_id);

    const filtered = applyFilters(allRows, {
      since: q.since,
      agent_id: q.agent_id,
      skill_id: q.skill_id,
      cycle_id: safeCycleId,
    });

    const page = filtered.slice(0, limit);

    // Audit log (read-only)
    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'quality.step-scores.read',
      target: 'step-scores.jsonl',
      details: { filters: q, count: page.length },
    });

    const payload = {
      data: page,
      meta: {
        total: filtered.length,
        limit,
        truncated,
        timestamp: nowIso(),
      },
    };
    toCache(cacheKey, payload);
    return reply.send(payload);
  });

  // ── GET /api/v5/quality/aggregates ──────────────────────────────────────

  app.get('/api/v5/quality/aggregates', async (req, reply) => {
    const q = req.query as { window?: string };
    const win = (q.window ?? '7d') as Window;
    const validWindows: Window[] = ['24h', '7d', '30d'];
    const effectiveWindow: Window = validWindows.includes(win) ? win : '7d';

    const cacheKey = `${projectRoot}:aggregates:${effectiveWindow}`;
    const cached = fromCache(cacheKey);
    if (cached !== undefined) return reply.send(cached);

    const { rows } = await scanStepScores(projectRoot);
    const cutoff = windowCutoff(effectiveWindow);
    const windowed = rows.filter(r => {
      const ts = r.created_at ?? '';
      return ts >= cutoff;
    });

    const by_agent = aggregateBy(windowed, r => r.agent_id as string | undefined, 'agent_id') as unknown as AgentAgg[];
    const by_skill = aggregateBy(windowed, r => r.skill_id as string | undefined, 'skill_id') as unknown as SkillAgg[];
    const by_model = aggregateBy(windowed, r => r.model as string | undefined, 'model') as unknown as ModelAgg[];

    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'quality.aggregates.read',
      target: 'step-scores.jsonl',
      details: { window: effectiveWindow, rowCount: windowed.length },
    });

    const payload = {
      by_agent,
      by_skill,
      by_model,
      meta: {
        window: effectiveWindow,
        cutoff,
        total_rows: windowed.length,
        timestamp: nowIso(),
      },
    };
    toCache(cacheKey, payload);
    return reply.send(payload);
  });

  // ── GET /api/v5/quality/skill-effectiveness ──────────────────────────────

  app.get('/api/v5/quality/skill-effectiveness', async (req, reply) => {
    const q = req.query as { skill_id?: string; window?: string };
    const skillId = q.skill_id;
    if (!skillId) {
      return reply.status(400).send({
        error: 'skill_id query parameter is required',
        code: 'MISSING_SKILL_ID',
      });
    }

    const win = (q.window ?? '7d') as Window;
    const validWindows: Window[] = ['24h', '7d', '30d'];
    const effectiveWindow: Window = validWindows.includes(win) ? win : '7d';

    const cacheKey = `${projectRoot}:skill-effectiveness:${skillId}:${effectiveWindow}`;
    const cached = fromCache(cacheKey);
    if (cached !== undefined) return reply.send(cached);

    const { rows } = await scanStepScores(projectRoot);
    const cutoff = windowCutoff(effectiveWindow);
    const windowed = rows.filter(r => {
      const ts = r.created_at ?? '';
      return ts >= cutoff;
    });

    // Bucket by agent: with-skill vs without-skill
    // "with skill" = row.skill_id includes skillId
    const withSkillByAgent = new Map<string, number[]>();
    const withoutSkillByAgent = new Map<string, number[]>();

    for (const row of windowed) {
      const agentId = row.agent_id;
      if (typeof agentId !== 'string' || agentId.length === 0) continue;
      if (typeof row.quality_score !== 'number') continue;

      const hasSkill = typeof row.skill_id === 'string' && row.skill_id.includes(skillId);

      if (hasSkill) {
        if (!withSkillByAgent.has(agentId)) withSkillByAgent.set(agentId, []);
        withSkillByAgent.get(agentId)!.push(row.quality_score);
      } else {
        if (!withoutSkillByAgent.has(agentId)) withoutSkillByAgent.set(agentId, []);
        withoutSkillByAgent.get(agentId)!.push(row.quality_score);
      }
    }

    const MIN_SAMPLES = 10;
    const agents: Array<{
      agent_id: string;
      mean_quality_with: number;
      mean_quality_without: number;
      delta: number;
    }> = [];

    const allAgentIds = new Set([...withSkillByAgent.keys(), ...withoutSkillByAgent.keys()]);
    for (const agentId of allAgentIds) {
      const withScores = withSkillByAgent.get(agentId) ?? [];
      const withoutScores = withoutSkillByAgent.get(agentId) ?? [];

      if (withScores.length < MIN_SAMPLES || withoutScores.length < MIN_SAMPLES) continue;

      const meanWith = withScores.reduce((s, v) => s + v, 0) / withScores.length;
      const meanWithout = withoutScores.reduce((s, v) => s + v, 0) / withoutScores.length;

      agents.push({
        agent_id: agentId,
        mean_quality_with: meanWith,
        mean_quality_without: meanWithout,
        delta: meanWith - meanWithout,
      });
    }

    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'quality.skill-effectiveness.read',
      target: 'step-scores.jsonl',
      details: { skill_id: skillId, agents_qualified: agents.length },
    });

    const payload = {
      skill_id: skillId,
      agents,
      meta: {
        window: effectiveWindow,
        cutoff,
        min_samples: MIN_SAMPLES,
        timestamp: nowIso(),
      },
    };
    toCache(cacheKey, payload);
    return reply.send(payload);
  });
}
