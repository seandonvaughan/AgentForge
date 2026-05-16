/**
 * plugins.ts — Plugin routes with SQLite-backed persistence.
 * Fix 3 from v2 mock-data audit: replaces in-memory-only PluginHost state.
 */
import type { FastifyInstance } from 'fastify';
import { PluginHost } from '@agentforge/plugins-sdk';
import { generateId, nowIso } from '@agentforge/shared';
import { openAuditDb, appendAuditEntry } from './audit.js';
import Sqlite from 'better-sqlite3';

export interface PluginRow {
  id: string; name: string; version: string; status: string;
  config_json: string; registered_at: string; last_loaded_at: string | null;
}
interface PluginRoutesOpts { projectRoot?: string; }

export function ensurePluginsTable(db: Sqlite.Database): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disabled', config_json TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL, last_loaded_at TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status)').run();
}

function rowToRecord(row: PluginRow): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.config_json) as Record<string, unknown>; } catch { /* ignore */ }
  return { id: row.id, name: row.name, version: row.version, status: row.status, config, registeredAt: row.registered_at, lastLoadedAt: row.last_loaded_at ?? null };
}

export async function pluginRoutes(app: FastifyInstance, opts: PluginRoutesOpts = {}): Promise<void> {
  const db = openAuditDb(opts.projectRoot ?? process.cwd());
  ensurePluginsTable(db);
  const host = new PluginHost();
  const enabledRows = db.prepare<[], PluginRow>("SELECT * FROM plugins WHERE status = 'enabled'").all();
  for (const row of enabledRows) {
    try { await host.load(row.id); db.prepare<[string, string]>('UPDATE plugins SET last_loaded_at = ? WHERE id = ?').run(nowIso(), row.id); }
    catch { db.prepare<[string]>("UPDATE plugins SET status = 'error' WHERE id = ?").run(row.id); }
  }
  app.addHook('onClose', async () => { db.close(); });

  app.get('/api/v5/plugins', async (_req, reply) => {
    const rows = db.prepare<[], PluginRow>('SELECT * FROM plugins ORDER BY registered_at DESC').all();
    const liveMap = new Map(host.list().map((i) => [i.id, i]));
    const data = rows.map((row) => {
      const live = liveMap.get(row.id);
      return { ...rowToRecord(row), runtimeStatus: live?.status ?? null, pid: live?.pid ?? null, startedAt: live?.startedAt ?? null, errorMessage: live?.errorMessage ?? null };
    });
    return reply.send({ data, meta: { total: data.length } });
  });

  app.post('/api/v5/plugins/load', async (req, reply) => {
    const body = req.body as { manifestPath?: string };
    if (!body.manifestPath) return reply.status(400).send({ error: 'manifestPath is required' });
    try {
      const instance = await host.load(body.manifestPath);
      db.prepare("INSERT INTO plugins (id, name, version, status, config_json, registered_at) VALUES (?, ?, ?, 'disabled', '{}', ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version").run(instance.id, instance.manifest.name, instance.manifest.version, nowIso());
      appendAuditEntry(db, { actor: 'api', action: 'plugin.register', target: instance.id, details: { manifestPath: body.manifestPath, requestId: generateId() } });
      const row = db.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get(instance.id)!;
      return reply.status(201).send({ data: rowToRecord(row) });
    } catch (err: unknown) { return reply.status(400).send({ error: (err as Error).message }); }
  });

  app.post<{ Params: { id: string } }>('/api/v5/plugins/:id/start', async (req, reply) => {
    const { id } = req.params;
    const body = req.body as { entrypointDir?: string };
    const row = db.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get(id);
    if (!row) return reply.status(404).send({ error: `Plugin '${id}' not registered` });
    try {
      await host.start(id, body.entrypointDir ?? '');
      db.prepare<[string, string]>("UPDATE plugins SET status = 'enabled', last_loaded_at = ? WHERE id = ?").run(nowIso(), id);
      appendAuditEntry(db, { actor: 'api', action: 'plugin.start', target: id, details: { requestId: generateId() } });
      return reply.send({ ok: true });
    } catch (err: unknown) { db.prepare<[string]>("UPDATE plugins SET status = 'error' WHERE id = ?").run(id); return reply.status(500).send({ error: (err as Error).message }); }
  });

  app.post<{ Params: { id: string } }>('/api/v5/plugins/:id/stop', async (req, reply) => {
    await host.stop(req.params.id);
    db.prepare<[string]>("UPDATE plugins SET status = 'disabled' WHERE id = ?").run(req.params.id);
    appendAuditEntry(db, { actor: 'api', action: 'plugin.stop', target: req.params.id, details: { requestId: generateId() } });
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/v5/plugins/:id', async (req, reply) => {
    const { id } = req.params;
    const row = db.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get(id);
    if (!row) return reply.status(404).send({ error: `Plugin '${id}' not found` });
    try { await host.stop(id); } catch { /* ignore */ }
    db.prepare<[string]>('DELETE FROM plugins WHERE id = ?').run(id);
    appendAuditEntry(db, { actor: 'api', action: 'plugin.deregister', target: id, details: { requestId: generateId() } });
    return reply.send({ ok: true, deleted: id });
  });
}
