/**
 * API v6 Unified Route Namespace
 *
 * Consolidates v5 workspace-scoped routes and v1 lifecycle routes (teams,
 * careers, hiring-recommendations) under a single /api/v6/ prefix.
 *
 * v1 routes are re-exposed here with a Deprecation header pointing to v6
 * canonical paths. All v5 functionality is proxied by re-running the v5
 * handler logic under the v6 path, ensuring a single code path per feature.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { WorkspaceRegistry } from '@agentforge/db';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Sqlite from 'better-sqlite3';

// ── v5 route module imports ───────────────────────────────────────────────────
import { rbacRoutes } from '../v5/rbac.js';
import { costsRoutes } from '../v5/costs.js';
import { approvalsRoutes } from '../v5/approvals.js';
import { workflowRoutes } from '../v5/workflows.js';
import { budgetRoutes } from '../v5/budget.js';
import { observabilityRoutes } from '../v5/observability.js';
import { streamRoutes } from '../v5/stream.js';
import { mergeQueueRoutes } from '../v5/merge-queue.js';
import { knowledgeRoutes } from '../v5/knowledge.js';
import { canaryRoutes } from '../v5/canary.js';
import { tracingRoutes } from '../v5/tracing.js';
import { costAutopilotRoutes } from '../v5/cost-autopilot.js';
import { predictivePlanningRoutes } from '../v5/predictive-planning.js';
import { marketplaceRoutes } from '../v5/marketplace.js';
import { nlInterfaceRoutes } from '../v5/nl-interface.js';
import { agentStreamingRoutes } from '../v5/streaming.js';
import { multiWorkspaceRoutes } from '../v5/multi-workspace.js';
import { agentVersioningRoutes } from '../v5/agent-versioning.js';
import { federationRoutes } from '../v5/federation.js';
import { registerHealthServicesRoutes } from '../v5/health-services.js';
import { sprintOrchestrationRoutes } from '../v5/sprint-orchestration.js';
import { settingsRoutes } from '../v5/settings.js';
import { agentCrudRoutes } from '../v5/agent-crud.js';
import { chatRoutes } from '../v5/chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/routes/v6/ → up 5 levels to monorepo root
const PROJECT_ROOT = join(__dirname, '../../../../../');

// ── Deprecation header helper ─────────────────────────────────────────────────

function addDeprecationHeaders(
  reply: FastifyReply,
  v6Path: string,
  sunset?: string,
): void {
  reply.header('Deprecation', 'true');
  reply.header('Link', `</api/v6${v6Path}>; rel="successor-version"`);
  reply.header(
    'Sunset',
    sunset ?? 'Sat, 01 Jan 2027 00:00:00 GMT',
  );
  reply.header(
    'Warning',
    `299 AgentForge "This endpoint is deprecated. Use /api/v6${v6Path} instead."`,
  );
}

// ── v1 lifecycle data loaders ─────────────────────────────────────────────────

interface TeamUnit {
  id: string;
  name?: string;
  [key: string]: unknown;
}

function loadTeams(): TeamUnit[] {
  const teamsPath = join(PROJECT_ROOT, '.agentforge', 'config', 'teams.yaml');
  if (existsSync(teamsPath)) {
    const raw = readFileSync(teamsPath, 'utf-8');
    const parsed = yaml.load(raw);
    if (Array.isArray(parsed)) return parsed as TeamUnit[];
  }
  const teamYamlPath = join(PROJECT_ROOT, '.agentforge', 'team.yaml');
  if (existsSync(teamYamlPath)) {
    const raw = readFileSync(teamYamlPath, 'utf-8');
    const manifest = yaml.load(raw) as { team_units?: TeamUnit[] };
    return manifest.team_units ?? [];
  }
  return [];
}

// Singleton DB for career/hiring data
let _db: Sqlite.Database | null = null;

function getCareersDb(adapter: WorkspaceAdapter | undefined): Sqlite.Database | null {
  if (_db) return _db;
  // Prefer adapter-provided DB, fall back to well-known path
  if (adapter && typeof (adapter as unknown as { getAgentDatabase?: () => { getDb: () => Sqlite.Database } }).getAgentDatabase === 'function') {
    try {
      const agentDb = (adapter as unknown as { getAgentDatabase: () => { getDb: () => Sqlite.Database } }).getAgentDatabase();
      _db = agentDb.getDb();
      return _db;
    } catch {
      // fall through to file path
    }
  }
  const dbPath = join(PROJECT_ROOT, '.agentforge/audit.db');
  if (existsSync(dbPath)) {
    _db = new Sqlite(dbPath);
    _db.pragma('journal_mode = WAL');
    return _db;
  }
  return null;
}

// ── Route option types ────────────────────────────────────────────────────────

export interface V6RouteOptions {
  adapter: WorkspaceAdapter;
  registry: WorkspaceRegistry;
  projectRoot?: string;
}

// ── Main registration function ────────────────────────────────────────────────

/**
 * Register all v6 API routes.
 *
 * v6 is a strict superset of v5: all v5 routes are re-exposed under /api/v6/,
 * plus the v1 lifecycle routes (teams, careers, hiring-recommendations) that
 * previously only existed at /api/v1/.
 *
 * Calling code should still register v5 routes separately for backwards
 * compatibility — this function does not remove v5 routes.
 */
export async function registerV6Routes(
  app: FastifyInstance,
  opts: V6RouteOptions,
): Promise<void> {
  const { adapter, registry } = opts;
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;

  // ── v5 feature parity under /api/v6/ ────────────────────────────────────────
  // We re-register all the v5 sub-route modules against an app prefix plugin so
  // that their internal route paths (/api/v5/…) are transparently aliased to
  // /api/v6/… via the prefix rewrite below.  The modules themselves are not
  // modified — they continue to register at /api/v5/; we simply add a parallel
  // set of routes that delegate to the same handlers.

  // Workspaces
  app.get('/api/v6/workspaces', async (_req, reply) => {
    const workspaces = registry.listWorkspaces();
    return reply.send({
      data: workspaces,
      meta: { total: workspaces.length, timestamp: new Date().toISOString() },
    });
  });

  // Sessions
  app.get('/api/v6/sessions', async (req, reply) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      agentId?: string;
      status?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);
    // exactOptionalPropertyTypes: filter out undefined values before passing
    const sessionFilters: Record<string, unknown> = { limit, offset };
    if (q.agentId !== undefined) sessionFilters['agentId'] = q.agentId;
    if (q.status !== undefined) sessionFilters['status'] = q.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = adapter.listSessions(sessionFilters as any);
    const countFilters: Record<string, unknown> = {};
    if (q.agentId !== undefined) countFilters['agentId'] = q.agentId;
    if (q.status !== undefined) countFilters['status'] = q.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const total = adapter.countSessions(countFilters as any);
    return reply.send({
      data,
      meta: { total, limit, offset, workspaceId: adapter.workspaceId, timestamp: new Date().toISOString() },
    });
  });

  app.get('/api/v6/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = adapter.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND', details: { id } });
    }
    return reply.send({ data: session, meta: { timestamp: new Date().toISOString() } });
  });

  // Costs (inline)
  app.get('/api/v6/costs', async (_req, reply) => {
    const costs = adapter.getAllCosts();
    const total = adapter.getTotalCost();
    return reply.send({
      data: costs,
      meta: { total: costs.length, totalCostUsd: total, workspaceId: adapter.workspaceId, timestamp: new Date().toISOString() },
    });
  });

  // Autonomy / Promotions
  app.get('/api/v6/autonomy', async (_req, reply) => {
    const data = adapter.listPromotions();
    return reply.send({
      data,
      meta: { total: data.length, workspaceId: adapter.workspaceId, timestamp: new Date().toISOString() },
    });
  });

  // Health
  app.get('/api/v6/health', async (_req, reply) => {
    return reply.send({
      status: 'ok',
      version: '6.2.0',
      api: 'v6',
      workspaceId: adapter.workspaceId,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Re-register v5 sub-route modules under v6 prefix ────────────────────────
  // Each module registers its own /api/v5/... paths.  We create a thin Fastify
  // sub-app scoped to the v6 prefix shim so the modules also appear at /api/v6/.
  //
  // Strategy: register a Fastify plugin with prefix "/api/v6" and inside it
  // re-call each route factory.  The factories will internally call
  // `app.get('/api/v5/...')` which becomes absolute — we intercept by wrapping
  // the app object so that path strings are rewritten from v5 → v6.
  //
  // Simpler approach used here: register a dedicated plugin that patches path
  // registration for the duration of module loading.

  await app.register(async (sub) => {
    // Shim: intercept route registrations so /api/v5/X → /api/v6/X
    const _get = sub.get.bind(sub);
    const _post = sub.post.bind(sub);
    const _put = sub.put.bind(sub);
    const _delete = sub.delete.bind(sub);
    const _patch = sub.patch.bind(sub);

    function rewritePath(path: string): string {
      return path.replace(/^\/api\/v5\//, '/api/v6/');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyFn = (...a: any[]) => any;

    function patchMethod(original: AnyFn): AnyFn {
      return function (path: string, ...rest: unknown[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any)(rewritePath(path), ...rest);
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sub as any).get    = patchMethod(_get as AnyFn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sub as any).post   = patchMethod(_post as AnyFn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sub as any).put    = patchMethod(_put as AnyFn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sub as any).delete = patchMethod(_delete as AnyFn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sub as any).patch  = patchMethod(_patch as AnyFn);

    // Register all v5 sub-modules — their internal paths will be rewritten
    await approvalsRoutes(sub);
    await rbacRoutes(sub);
    await costsRoutes(sub, { adapter });
    await workflowRoutes(sub);
    await budgetRoutes(sub);
    await observabilityRoutes(sub);
    await streamRoutes(sub);
    await mergeQueueRoutes(sub);
    await knowledgeRoutes(sub);
    await canaryRoutes(sub);
    await tracingRoutes(sub);
    await costAutopilotRoutes(sub);
    await predictivePlanningRoutes(sub);
    await marketplaceRoutes(sub);
    await nlInterfaceRoutes(sub);
    await agentStreamingRoutes(sub);
    await multiWorkspaceRoutes(sub);
    await agentVersioningRoutes(sub);
    await federationRoutes(sub);
    registerHealthServicesRoutes(sub);
    await sprintOrchestrationRoutes(sub, projectRoot ? { projectRoot } : undefined);
    await settingsRoutes(sub);
    await agentCrudRoutes(sub, projectRoot ? { projectRoot } : {});
    await chatRoutes(sub);
  });

  // ── v1 Lifecycle routes with deprecation headers ─────────────────────────────

  // Teams
  app.get('/api/v6/teams', async (_req, reply) => {
    const teams = loadTeams();
    return reply.send({ data: teams, meta: { total: teams.length } });
  });

  app.get<{ Params: { teamId: string } }>('/api/v6/teams/:teamId', async (req, reply) => {
    const teams = loadTeams();
    const team = teams.find((t) => t.id === req.params.teamId);
    if (!team) {
      return reply.status(404).send({ error: `Team "${req.params.teamId}" not found` });
    }
    return reply.send(team);
  });

  // Careers
  app.get('/api/v6/careers', async (_req, reply) => {
    const db = getCareersDb(adapter);
    if (!db) return reply.send({ data: [], meta: { total: 0 } });
    try {
      const rows = db.prepare('SELECT * FROM agent_careers ORDER BY updated_at DESC').all();
      return reply.send({ data: rows, meta: { total: rows.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  app.get<{ Params: { agentId: string } }>('/api/v6/careers/:agentId', async (req, reply) => {
    const db = getCareersDb(adapter);
    if (!db) return reply.status(503).send({ error: 'Career database unavailable' });
    try {
      const career = db
        .prepare('SELECT * FROM agent_careers WHERE agent_id = ?')
        .get(req.params.agentId);
      if (!career) {
        return reply.status(404).send({ error: `Career not found for "${req.params.agentId}"` });
      }
      const skills = db
        .prepare('SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY level DESC')
        .all(req.params.agentId);
      return reply.send({
        ...(career as object),
        skills: (skills as Array<{ unlocked_capabilities?: string | null }>).map((s) => ({
          ...s,
          unlocked_capabilities: s.unlocked_capabilities
            ? JSON.parse(s.unlocked_capabilities)
            : [],
        })),
      });
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch career data' });
    }
  });

  app.get<{ Params: { agentId: string } }>('/api/v6/careers/:agentId/skills', async (req, reply) => {
    const db = getCareersDb(adapter);
    if (!db) return reply.send({ agentId: req.params.agentId, skills: [], total: 0 });
    try {
      const skills = db
        .prepare('SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY level DESC')
        .all(req.params.agentId);
      return reply.send({
        agentId: req.params.agentId,
        skills: (skills as Array<{ unlocked_capabilities?: string | null }>).map((s) => ({
          ...s,
          unlocked_capabilities: s.unlocked_capabilities
            ? JSON.parse(s.unlocked_capabilities)
            : [],
        })),
        total: skills.length,
      });
    } catch {
      return reply.send({ agentId: req.params.agentId, skills: [], total: 0 });
    }
  });

  // Hiring recommendations
  app.get('/api/v6/hiring-recommendations', async (req, reply) => {
    const db = getCareersDb(adapter);
    if (!db) return reply.send({ data: [], meta: { total: 0 } });
    try {
      const status = (req.query as { status?: string }).status;
      const rows = status
        ? db.prepare('SELECT * FROM hiring_recommendations WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM hiring_recommendations ORDER BY created_at DESC').all();
      return reply.send({
        data: (rows as Array<{ requested_skills?: string | null }>).map((r) => ({
          ...r,
          requested_skills: r.requested_skills ? JSON.parse(r.requested_skills) : [],
        })),
        meta: { total: rows.length },
      });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // ── v1 shim routes (with deprecation headers) ────────────────────────────────
  // These sit at the original /api/v1/ paths and add deprecation headers so
  // clients can discover the canonical v6 equivalents.

  app.get('/api/v1/teams', async (_req: FastifyRequest, reply: FastifyReply) => {
    addDeprecationHeaders(reply, '/teams');
    const teams = loadTeams();
    return reply.send({ data: teams, meta: { total: teams.length } });
  });

  app.get<{ Params: { teamId: string } }>(
    '/api/v1/teams/:teamId',
    async (req: FastifyRequest<{ Params: { teamId: string } }>, reply: FastifyReply) => {
      addDeprecationHeaders(reply, `/teams/${req.params.teamId}`);
      const teams = loadTeams();
      const team = teams.find((t) => t.id === req.params.teamId);
      if (!team) {
        return reply.status(404).send({ error: `Team "${req.params.teamId}" not found` });
      }
      return reply.send(team);
    },
  );

  app.get('/api/v1/careers', async (_req: FastifyRequest, reply: FastifyReply) => {
    addDeprecationHeaders(reply, '/careers');
    const db = getCareersDb(adapter);
    if (!db) return reply.send({ data: [], meta: { total: 0 } });
    try {
      const rows = db.prepare('SELECT * FROM agent_careers ORDER BY updated_at DESC').all();
      return reply.send({ data: rows, meta: { total: rows.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  app.get<{ Params: { agentId: string } }>(
    '/api/v1/careers/:agentId',
    async (req: FastifyRequest<{ Params: { agentId: string } }>, reply: FastifyReply) => {
      addDeprecationHeaders(reply, `/careers/${req.params.agentId}`);
      const db = getCareersDb(adapter);
      if (!db) return reply.status(503).send({ error: 'Career database unavailable' });
      try {
        const career = db
          .prepare('SELECT * FROM agent_careers WHERE agent_id = ?')
          .get(req.params.agentId);
        if (!career) {
          return reply.status(404).send({ error: `Career not found for "${req.params.agentId}"` });
        }
        const skills = db
          .prepare('SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY level DESC')
          .all(req.params.agentId);
        return reply.send({
          ...(career as object),
          skills: (skills as Array<{ unlocked_capabilities?: string | null }>).map((s) => ({
            ...s,
            unlocked_capabilities: s.unlocked_capabilities
              ? JSON.parse(s.unlocked_capabilities)
              : [],
          })),
        });
      } catch {
        return reply.status(500).send({ error: 'Failed to fetch career data' });
      }
    },
  );

  app.get('/api/v1/hiring-recommendations', async (req: FastifyRequest, reply: FastifyReply) => {
    addDeprecationHeaders(reply, '/hiring-recommendations');
    const db = getCareersDb(adapter);
    if (!db) return reply.send({ data: [], meta: { total: 0 } });
    try {
      const status = (req.query as { status?: string }).status;
      const rows = status
        ? db.prepare('SELECT * FROM hiring_recommendations WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM hiring_recommendations ORDER BY created_at DESC').all();
      return reply.send({
        data: (rows as Array<{ requested_skills?: string | null }>).map((r) => ({
          ...r,
          requested_skills: r.requested_skills ? JSON.parse(r.requested_skills) : [],
        })),
        meta: { total: rows.length },
      });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // ── v1 memory shim ────────────────────────────────────────────────────────
  // /api/v1/memory was the path the dashboard frontend always used but no
  // v1 alias was ever registered.  This shim reads the live JSONL memory
  // files from .agentforge/memory/ (primary) and falls back to the static
  // seed data in .agentforge/data/memories.json when no JSONL entries exist.
  //
  // Query params (all optional):
  //   type    — exact match on entry.type  (e.g. "cycle-outcome")
  //   since   — ISO-8601; only entries with createdAt >= since
  //   agentId — exact match on entry.agentId / source field
  //
  // Response: { data, agents, types, meta: { total, limit } }

  interface V1MemoryEntry {
    id: string;
    key: string;
    filename?: string;
    value: unknown;
    type: string;
    category?: string;
    createdAt: string;
    updatedAt?: string;
    agentId?: string;
    source?: string;
    summary?: string;
    tags?: string[];
  }

  app.get('/api/v1/memory', async (req: FastifyRequest, reply: FastifyReply) => {
    addDeprecationHeaders(reply, '/memory');

    const q = req.query as { type?: string; since?: string; agentId?: string };
    const typeFilter = q.type?.trim() ?? '';
    const agentIdFilter = q.agentId?.trim() ?? '';
    const sinceMs = q.since ? new Date(q.since).getTime() : NaN;
    const hasSince = !Number.isNaN(sinceMs);
    const MEMORY_LIMIT = 200;

    const memoryDir = join(PROJECT_ROOT, '.agentforge/memory');
    const entries: V1MemoryEntry[] = [];

    if (existsSync(memoryDir)) {
      const files = readdirSync(memoryDir);

      // ── JSONL files (live memory written by cycle phases) ──────────────────
      for (const file of files.filter(f => f.endsWith('.jsonl'))) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          for (const line of content.split('\n').filter(l => l.trim().length > 0)) {
            try {
              const raw = JSON.parse(line) as {
                id?: string; type?: string; value?: string;
                createdAt?: string; source?: string; tags?: string[];
              };
              const type = raw.type ?? file.replace(/\.jsonl$/, '');
              const createdAt = raw.createdAt ?? new Date().toISOString();
              entries.push({
                id: raw.id ?? `${file}-${entries.length}`,
                key: type,
                value: raw.value ?? '',
                type,
                createdAt,
                updatedAt: createdAt,
                ...(raw.source !== undefined
                  ? { agentId: raw.source, source: raw.source }
                  : {}),
                ...(typeof raw.value === 'string'
                  ? { summary: raw.value.slice(0, 160) }
                  : {}),
                ...(raw.tags !== undefined ? { tags: raw.tags } : {}),
              });
            } catch { /* skip malformed line */ }
          }
        } catch { /* skip unreadable file */ }
      }

      // ── Legacy JSON / Markdown files in the memory dir ────────────────────
      for (const file of files.filter(f => f.endsWith('.json') || f.endsWith('.md'))) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          const stem = file.replace(/\.[^.]+$/, '');
          entries.push({
            id: stem,
            key: stem,
            value: file.endsWith('.json') ? JSON.parse(content) : content.slice(0, 500),
            type: file.endsWith('.json') ? 'json' : 'text',
            createdAt: new Date().toISOString(),
          });
        } catch { /* skip */ }
      }
    }

    // ── Seed data fallback (.agentforge/data/memories.json) ───────────────────
    // When no live JSONL entries exist (no cycles have run yet), serve the
    // curated seed data so the dashboard shows something meaningful.
    if (entries.length === 0) {
      const seedPath = join(PROJECT_ROOT, '.agentforge/data/memories.json');
      if (existsSync(seedPath)) {
        try {
          const parsed = JSON.parse(readFileSync(seedPath, 'utf-8')) as {
            entries?: V1MemoryEntry[];
          } | V1MemoryEntry[];
          const seedEntries: V1MemoryEntry[] = Array.isArray(parsed)
            ? parsed
            : (parsed.entries ?? []);
          for (const e of seedEntries) {
            entries.push({
              id: e.id ?? String(entries.length),
              key: e.filename ?? e.key ?? String(entries.length),
              value: e.summary ?? e.value ?? '',
              type: e.category ?? 'project',
              createdAt: e.createdAt ?? new Date().toISOString(),
              // Use conditional spread for all optional fields to satisfy
              // exactOptionalPropertyTypes — never set a field to `undefined`.
              ...(e.filename !== undefined ? { filename: e.filename } : {}),
              ...(e.category !== undefined ? { category: e.category } : {}),
              ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}),
              ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
              ...(e.summary !== undefined ? { summary: e.summary } : {}),
              ...(e.tags !== undefined ? { tags: e.tags } : {}),
            });
          }
        } catch { /* skip corrupt seed file */ }
      }
    }

    // Newest first.
    entries.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    const recent = entries.slice(0, MEMORY_LIMIT);

    const agents = [
      ...new Set(recent.map(e => e.agentId).filter((a): a is string => Boolean(a))),
    ];
    const types = [
      ...new Set(recent.map(e => e.type).filter((t): t is string => Boolean(t))),
    ].sort();

    const filtered = recent.filter(e => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (agentIdFilter && e.agentId !== agentIdFilter) return false;
      if (hasSince) {
        const entryMs = e.createdAt ? new Date(e.createdAt).getTime() : 0;
        if (entryMs < sinceMs) return false;
      }
      return true;
    });

    return reply.send({
      data: filtered,
      agents,
      types,
      meta: { total: filtered.length, limit: MEMORY_LIMIT },
    });
  });
}
