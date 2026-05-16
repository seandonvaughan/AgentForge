/**
 * Tests for the persistent plugin registry (Fix 3: v2 mock-data audit).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Sqlite from 'better-sqlite3';
import { pluginRoutes, ensurePluginsTable, type PluginRow } from '../plugins.js';

let tmpRoot: string;
let app: FastifyInstance;

async function makeApp(root: string): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await pluginRoutes(instance, { projectRoot: root });
  await instance.ready();
  return instance;
}
function openDb(root: string): Sqlite.Database {
  const db = new Sqlite(join(root, '.agentforge', 'audit.db'));
  ensurePluginsTable(db);
  return db;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-plugins-'));
  mkdirSync(join(tmpRoot, '.agentforge'), { recursive: true });
  app = await makeApp(tmpRoot);
});
afterEach(async () => {
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /api/v5/plugins', () => {
  it('returns 200 with empty data on a fresh DB', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/plugins' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
  it('returns persisted plugin rows from DB', async () => {
    const db = openDb(tmpRoot);
    db.prepare("INSERT INTO plugins (id, name, version, status, registered_at) VALUES (?, ?, ?, ?, ?)").run('my-plugin', 'My Plugin', '1.0.0', 'disabled', new Date().toISOString());
    db.close();
    const app2 = await makeApp(tmpRoot);
    const res = await app2.inject({ method: 'GET', url: '/api/v5/plugins' });
    await app2.close();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string; status: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe('my-plugin');
  });
});

describe('POST /api/v5/plugins/load', () => {
  it('returns 400 when manifestPath is missing', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v5/plugins/load', payload: {} })).statusCode).toBe(400);
  });
  it('returns 400 for an invalid manifest path', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/plugins/load', payload: { manifestPath: '/nonexistent/plugin.json' } });
    expect(res.statusCode).toBe(400);
  });
  it('persists a plugin registration to the DB', async () => {
    const pluginDir = join(tmpRoot, 'my-plugin');
    mkdirSync(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, 'plugin.json');
    writeFileSync(manifestPath, JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0', description: 'Test', entrypoint: 'index.js', permissions: [], hooks: [], skills: [] }));
    const res = await app.inject({ method: 'POST', url: '/api/v5/plugins/load', payload: { manifestPath } });
    expect(res.statusCode).toBe(201);
    const db = openDb(tmpRoot);
    const row = db.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get('my-plugin');
    db.close();
    expect(row).toBeDefined();
    expect(row!.status).toBe('disabled');
  });
});

describe('Plugin persistence across server restart', () => {
  it('plugin registered before restart is visible after restart', async () => {
    const db = openDb(tmpRoot);
    db.prepare<[string, string, string, string, string]>("INSERT INTO plugins (id, name, version, status, registered_at) VALUES (?, ?, ?, ?, ?)").run('pp', 'PP', '2.0.0', 'disabled', new Date().toISOString());
    db.close();
    await app.close();
    const app2 = await makeApp(tmpRoot);
    const res = await app2.inject({ method: 'GET', url: '/api/v5/plugins' });
    await app2.close();
    expect(res.json<{ data: Array<{ id: string }> }>().data.find((p) => p.id === 'pp')).toBeDefined();
  });
  it('disabled plugin remains disabled after restart', async () => {
    const db = openDb(tmpRoot);
    db.prepare<[string, string, string, string, string]>("INSERT INTO plugins (id, name, version, status, registered_at) VALUES (?, ?, ?, ?, ?)").run('dp', 'DP', '1.0.0', 'disabled', new Date().toISOString());
    db.close();
    await app.close();
    const app2 = await makeApp(tmpRoot);
    const res = await app2.inject({ method: 'GET', url: '/api/v5/plugins' });
    await app2.close();
    expect(res.json<{ data: Array<{ id: string; status: string }> }>().data.find((p) => p.id === 'dp')?.status).toBe('disabled');
  });
});

describe('DELETE /api/v5/plugins/:id', () => {
  it('returns 404 for unknown plugin', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v5/plugins/unknown-plugin' })).statusCode).toBe(404);
  });
  it('removes a registered plugin from the DB', async () => {
    const db = openDb(tmpRoot);
    db.prepare<[string, string, string, string, string]>("INSERT INTO plugins (id, name, version, status, registered_at) VALUES (?, ?, ?, ?, ?)").run('to-delete', 'TD', '1.0.0', 'disabled', new Date().toISOString());
    db.close();
    await app.close();
    app = await makeApp(tmpRoot);
    const del = await app.inject({ method: 'DELETE', url: '/api/v5/plugins/to-delete' });
    expect(del.statusCode).toBe(200);
    const db2 = openDb(tmpRoot);
    expect(db2.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get('to-delete')).toBeUndefined();
    db2.close();
  });
});
