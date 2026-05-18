import { WorkspaceRegistry, WorkspaceAdapter } from '@agentforge/db';
import type { WorkspaceRow } from '@agentforge/db';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export * from './init-service.js';

export interface WorkspaceManagerOptions {
  dataDir: string;
}

export class WorkspaceManager {
  private readonly registry: WorkspaceRegistry;
  private readonly adapters = new Map<string, WorkspaceAdapter>();

  constructor(options: WorkspaceManagerOptions) {
    this.registry = new WorkspaceRegistry({ dataDir: options.dataDir });
  }

  async getOrCreateDefaultWorkspace(): Promise<{ workspace: WorkspaceRow; adapter: WorkspaceAdapter }> {
    let workspaces = this.registry.listWorkspaces();
    if (workspaces.length === 0) {
      this.registry.createWorkspace('default', 'system');
      workspaces = this.registry.listWorkspaces();
    }
    const workspace = workspaces[0]!;
    return { workspace, adapter: this.getAdapter(workspace) };
  }

  getAdapter(workspace: WorkspaceRow): WorkspaceAdapter {
    if (!this.adapters.has(workspace.id)) {
      const dbPath = this.registry.getWorkspaceDbPath(workspace.slug);
      try {
        this.adapters.set(workspace.id, new WorkspaceAdapter({ dbPath, workspaceId: workspace.id }));
      } catch (err) {
        if (!isRecoverableSqliteOpenError(err)) {
          throw err;
        }

        const quarantinedPath = quarantineWorkspaceDb(dbPath);
        this.adapters.set(workspace.id, new WorkspaceAdapter({ dbPath, workspaceId: workspace.id }));
        console.warn(
          `Recovered corrupt AgentForge workspace DB at ${dbPath}; quarantined copy: ${quarantinedPath}`,
        );
      }
    }
    return this.adapters.get(workspace.id)!;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.registry.listWorkspaces();
  }

  createWorkspace(name: string, ownerId?: string): { workspace: WorkspaceRow; adapter: WorkspaceAdapter } {
    const workspace = this.registry.createWorkspace(name, ownerId);
    return { workspace, adapter: this.getAdapter(workspace) };
  }

  getRegistry(): WorkspaceRegistry {
    return this.registry;
  }

  close(): void {
    for (const adapter of this.adapters.values()) {
      adapter.close();
    }
    this.registry.close();
  }
}

function isRecoverableSqliteOpenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  const code = typeof (err as { code?: unknown } | null)?.code === 'string'
    ? String((err as { code: string }).code)
    : '';

  return (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_NOTADB' ||
    message.includes('database disk image is malformed') ||
    message.includes('file is not a database')
  );
}

function quarantineWorkspaceDb(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;

  const recoveryDir = join(dirname(dbPath), 'recovery');
  mkdirSync(recoveryDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = basename(dbPath);
  const quarantinedPath = join(recoveryDir, `${baseName}.corrupt-${stamp}-${process.pid}`);
  renameSync(dbPath, quarantinedPath);

  for (const suffix of ['-wal', '-shm']) {
    const sidecarPath = `${dbPath}${suffix}`;
    if (existsSync(sidecarPath)) {
      renameSync(sidecarPath, join(recoveryDir, `${baseName}${suffix}.corrupt-${stamp}-${process.pid}`));
    }
  }

  return quarantinedPath;
}
