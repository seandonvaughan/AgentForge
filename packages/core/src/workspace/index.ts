import { WorkspaceRegistry, WorkspaceAdapter } from '@agentforge/db';
import type { WorkspaceRow } from '@agentforge/db';

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
      this.adapters.set(workspace.id, new WorkspaceAdapter({ dbPath, workspaceId: workspace.id }));
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
