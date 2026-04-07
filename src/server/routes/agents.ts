import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import yaml from 'js-yaml';
import type { SqliteAdapter } from '../../db/index.js';
import type { SessionRow } from '../../db/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSummary {
  agentId: string;
  /** Model tier sourced from YAML definition, or 'sonnet' if unknown. */
  model: 'opus' | 'sonnet' | 'haiku';
  /** Human-readable description from YAML, empty string when not defined. */
  description: string;
  sessionCount: number;
  successCount: number;
  failureCount: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

/** Minimal shape parsed from a .agentforge/agents/*.yaml file. */
interface AgentDefinition {
  name: string;
  model?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// YAML loader
// ---------------------------------------------------------------------------

/**
 * Load all agent definitions from the given directory.
 *
 * Returns a map keyed by agentId (the filename stem, e.g. "lead-architect")
 * to its definition. Malformed YAML files are silently skipped.
 */
async function loadAgentDefinitions(agentsDir: string): Promise<Map<string, AgentDefinition>> {
  const defs = new Map<string, AgentDefinition>();

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    // Directory doesn't exist yet — return empty map, not an error
    return defs;
  }

  const yamlFiles = entries.filter(f => extname(f) === '.yaml' || extname(f) === '.yml');

  await Promise.all(
    yamlFiles.map(async file => {
      const agentId = file.replace(/\.(yaml|yml)$/, '');
      try {
        const content = await readFile(join(agentsDir, file), 'utf-8');
        const raw = yaml.load(content) as Record<string, unknown> | null;
        if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
          defs.set(agentId, {
            name: raw.name as string,
            model: typeof raw.model === 'string' ? raw.model : undefined,
            description: typeof raw.description === 'string' ? raw.description.trim() : undefined,
          });
        }
      } catch {
        // Skip malformed or unreadable files
      }
    })
  );

  return defs;
}

/** Coerce an arbitrary model string to one of the three canonical tiers. */
function normalizeModel(raw: string | undefined): 'opus' | 'sonnet' | 'haiku' {
  if (raw === 'opus' || raw === 'haiku') return raw;
  return 'sonnet';
}

// ---------------------------------------------------------------------------
// Session-based aggregation helpers
// ---------------------------------------------------------------------------

function buildAgentSummaryFromSessions(
  agentId: string,
  model: 'opus' | 'sonnet' | 'haiku',
  description: string,
  sessions: SessionRow[],
): AgentSummary {
  const sessionCount = sessions.length;
  const successCount = sessions.filter(s => s.status === 'completed').length;
  const failureCount = sessions.filter(s => s.status === 'failed').length;

  let totalDurationMs = 0;
  let durationCount = 0;

  for (const s of sessions) {
    if (s.started_at && s.completed_at) {
      const durationMs = new Date(s.completed_at).getTime() - new Date(s.started_at).getTime();
      if (!isNaN(durationMs) && durationMs >= 0) {
        totalDurationMs += durationMs;
        durationCount++;
      }
    }
  }

  return {
    agentId,
    model,
    description,
    sessionCount,
    successCount,
    failureCount,
    totalCostUsd: 0, // enriched below from cost rows
    avgDurationMs: durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface AgentsRouteOptions {
  adapter: SqliteAdapter;
  /** Absolute path to .agentforge/agents/ — defaults to process.cwd()/.agentforge/agents */
  agentsDir?: string;
}

export async function agentsRoutes(app: FastifyInstance, opts: AgentsRouteOptions) {
  const { adapter } = opts;
  const agentsDir = opts.agentsDir ?? join(process.cwd(), '.agentforge', 'agents');

  // GET /api/v1/agents
  // Returns all agents defined in YAML files, merged with session stats.
  // Agents with zero sessions still appear (model + description from YAML).
  app.get('/api/v1/agents', async (_req, reply) => {
    const [defs, allSessions] = await Promise.all([
      loadAgentDefinitions(agentsDir),
      Promise.resolve(adapter.listSessions()),
    ]);

    // Index sessions by agentId for fast lookup
    const sessionsByAgent = new Map<string, SessionRow[]>();
    for (const s of allSessions) {
      const arr = sessionsByAgent.get(s.agent_id) ?? [];
      arr.push(s);
      sessionsByAgent.set(s.agent_id, arr);
    }

    // Build a summary for every YAML-defined agent
    const summaries: AgentSummary[] = [];
    for (const [agentId, def] of defs) {
      const sessions = sessionsByAgent.get(agentId) ?? [];
      const model = normalizeModel(def.model);
      const summary = buildAgentSummaryFromSessions(agentId, model, def.description ?? '', sessions);
      const costs = adapter.getAgentCosts(agentId);
      summary.totalCostUsd = costs.reduce((sum, c) => sum + c.cost_usd, 0);
      summaries.push(summary);
    }

    // Also include session-only agents not covered by a YAML file (shouldn't happen in practice
    // but keeps backward compatibility if agents are invoked before their YAML is checked in)
    for (const [agentId, sessions] of sessionsByAgent) {
      if (!defs.has(agentId)) {
        const summary = buildAgentSummaryFromSessions(agentId, 'sonnet', '', sessions);
        const costs = adapter.getAgentCosts(agentId);
        summary.totalCostUsd = costs.reduce((sum, c) => sum + c.cost_usd, 0);
        summaries.push(summary);
      }
    }

    // Sort alphabetically for stable, deterministic output
    summaries.sort((a, b) => a.agentId.localeCompare(b.agentId));

    return reply.send({ data: summaries, meta: { total: summaries.length } });
  });

  // GET /api/v1/agents/:id
  // Returns detail for a single agent. Returns 200 with zero stats for YAML-defined
  // agents that have no sessions yet. Returns 404 only when the agent is unknown.
  app.get('/api/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [defs, agentSessions] = await Promise.all([
      loadAgentDefinitions(agentsDir),
      Promise.resolve(adapter.listSessions({ agentId: id })),
    ]);

    const def = defs.get(id);

    // Unknown if neither a YAML definition nor any sessions exist
    if (!def && agentSessions.length === 0) {
      return reply.status(404).send({ error: 'Agent not found', id });
    }

    const model = normalizeModel(def?.model);
    const description = def?.description ?? '';
    const summary = buildAgentSummaryFromSessions(id, model, description, agentSessions);
    const costs = adapter.getAgentCosts(id);
    summary.totalCostUsd = costs.reduce((sum, c) => sum + c.cost_usd, 0);

    const recentSessions = agentSessions.slice(0, 50);

    return reply.send({ data: { ...summary, recentSessions } });
  });
}
