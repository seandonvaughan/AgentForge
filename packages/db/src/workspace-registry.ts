import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { MASTER_DDL } from './schema.js';
import { generateId, nowIso, slugify } from '@agentforge/shared';
import type { WorkspaceSettings } from '@agentforge/shared';

export interface WorkspaceRegistryOptions {
  dataDir: string; // directory where all DB files live
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export class WorkspaceRegistry {
  private readonly masterDb: Database.Database;
  private readonly dataDir: string;

  constructor(options: WorkspaceRegistryOptions) {
    this.dataDir = options.dataDir;
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    const masterPath = join(this.dataDir, 'agentforge-master.db');
    this.masterDb = new Database(masterPath);
    this.masterDb.pragma('journal_mode = WAL');
    this.masterDb.pragma('foreign_keys = ON');
    this.masterDb.exec(MASTER_DDL);
  }

  createWorkspace(name: string, ownerId: string = 'system'): WorkspaceRow {
    const id = generateId();
    const slug = slugify(name);
    const now = nowIso();
    const settings: WorkspaceSettings = {
      defaultModel: 'sonnet',
      budgetLimitUsd: 100,
      pluginsEnabled: [],
      features: {},
    };

    this.masterDb.prepare(`
      INSERT INTO workspaces (id, name, slug, owner_id, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, slug, ownerId, JSON.stringify(settings), now, now);

    return this.getWorkspace(id)!;
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    return this.masterDb.prepare(
      'SELECT * FROM workspaces WHERE id = ?'
    ).get(id) as WorkspaceRow | undefined;
  }

  getWorkspaceBySlug(slug: string): WorkspaceRow | undefined {
    return this.masterDb.prepare(
      'SELECT * FROM workspaces WHERE slug = ?'
    ).get(slug) as WorkspaceRow | undefined;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.masterDb.prepare(
      'SELECT * FROM workspaces ORDER BY created_at DESC'
    ).all() as WorkspaceRow[];
  }

  deleteWorkspace(id: string): boolean {
    const result = this.masterDb.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getWorkspaceDbPath(slug: string): string {
    return join(this.dataDir, `workspace-${slug}.db`);
  }

  close(): void {
    this.masterDb.close();
  }
}
