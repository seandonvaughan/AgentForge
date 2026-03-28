import type { FastifyInstance } from 'fastify';
import { AccessControl, BUILT_IN_ROLES, AuditTrail } from '@agentforge/core';

const ac = new AccessControl();
export const auditTrail = new AuditTrail();

export async function rbacRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/roles — list all roles
  app.get('/api/v5/roles', async (_req, reply) => {
    return reply.send({ data: ac.listRoles() });
  });

  // GET /api/v5/roles/:name/permissions
  app.get<{ Params: { name: string } }>('/api/v5/roles/:name/permissions', async (req, reply) => {
    const perms = ac.getPermissions(req.params.name);
    if (!perms.length && !BUILT_IN_ROLES[req.params.name]) {
      return reply.status(404).send({ error: 'Role not found' });
    }
    return reply.send({ data: perms });
  });

  // POST /api/v5/access/check — check if a context has a permission
  app.post('/api/v5/access/check', async (req, reply) => {
    const { userId, workspaceId, role, permission } = req.body as any;
    const allowed = ac.can({ userId, workspaceId, role }, permission);
    auditTrail.record('admin.action', userId, 'user', workspaceId, {
      metadata: { action: 'access.check', permission, allowed },
    });
    return reply.send({ data: { allowed } });
  });

  // GET /api/v5/audit — query audit log
  app.get('/api/v5/audit', async (req, reply) => {
    const query = req.query as any;
    const entries = auditTrail.query({
      workspaceId: query.workspaceId,
      actorId: query.actorId,
      action: query.action,
      since: query.since,
      until: query.until,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });
    return reply.send({ data: entries, meta: { total: entries.length } });
  });

  // GET /api/v5/audit/stats/:workspaceId
  app.get<{ Params: { workspaceId: string } }>('/api/v5/audit/stats/:workspaceId', async (req, reply) => {
    return reply.send({ data: auditTrail.stats(req.params.workspaceId) });
  });
}
