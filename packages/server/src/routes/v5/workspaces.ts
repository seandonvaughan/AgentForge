// packages/server/src/routes/v5/workspaces.ts
//
// v6.6.0 Agent B — workspace registry REST API.
//
// Manages the global ~/.agentforge/workspaces.json registry of project
// directories that this server instance can target for autonomous cycles.
// Distinct from `multi-workspace.ts` which exposes aggregated cost
// summaries — these endpoints are CRUD over the on-disk registry shared
// with the CLI.
//
// Routes:
//   GET    /api/v5/workspaces             — list all
//   POST   /api/v5/workspaces             — register {name, path}
//   DELETE /api/v5/workspaces/:id         — remove
//   GET    /api/v5/workspaces/default     — current default
//   PATCH  /api/v5/workspaces/default     — set default {workspaceId}

import type { FastifyInstance } from 'fastify';
import {
  addWorkspace,
  getDefaultWorkspace,
  loadWorkspaceRegistry,
  removeWorkspace,
  setDefaultWorkspace,
} from '@agentforge/core';

export async function workspacesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/workspaces ───────────────────────────────────────────────────
  app.get('/api/v5/workspaces', async (_req, reply) => {
    const reg = loadWorkspaceRegistry();
    return reply.send({
      data: reg.workspaces,
      defaultWorkspaceId: reg.defaultWorkspaceId,
      meta: { total: reg.workspaces.length, timestamp: new Date().toISOString() },
    });
  });

  // GET /api/v5/workspaces/default ───────────────────────────────────────────
  app.get('/api/v5/workspaces/default', async (_req, reply) => {
    const ws = getDefaultWorkspace();
    if (!ws) return reply.status(404).send({ error: 'No workspaces registered' });
    return reply.send(ws);
  });

  // PATCH /api/v5/workspaces/default ─────────────────────────────────────────
  app.patch('/api/v5/workspaces/default', async (req, reply) => {
    const body = (req.body ?? {}) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
      return reply.status(400).send({ error: 'workspaceId (string) is required' });
    }
    const ok = setDefaultWorkspace(body.workspaceId);
    if (!ok) {
      return reply.status(404).send({ error: 'workspace not found', workspaceId: body.workspaceId });
    }
    const ws = getDefaultWorkspace();
    return reply.send(ws);
  });

  // POST /api/v5/workspaces ──────────────────────────────────────────────────
  app.post('/api/v5/workspaces', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; path?: unknown };
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return reply.status(400).send({ error: 'name (non-empty string) is required' });
    }
    if (typeof body.path !== 'string' || body.path.trim().length === 0) {
      return reply.status(400).send({ error: 'path (non-empty string) is required' });
    }
    const ws = addWorkspace(body.name.trim(), body.path.trim());
    return reply.status(201).send(ws);
  });

  // DELETE /api/v5/workspaces/:id ────────────────────────────────────────────
  app.delete('/api/v5/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = removeWorkspace(id);
    if (!ok) {
      return reply.status(404).send({ error: 'workspace not found', workspaceId: id });
    }
    return reply.status(204).send();
  });
}
