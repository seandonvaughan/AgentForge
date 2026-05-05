import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { WorkspaceAdapter, WorkspaceRegistry } from '@agentforge/db';
import type { WorkspaceRow } from '@agentforge/db';
import { nowIso, slugify } from '@agentforge/shared';

export interface WorkspaceInitializationOptions {
  projectRoot?: string;
  dataDir?: string;
  workspaceName?: string;
  ownerId?: string;
}

export interface WorkspaceInitializationResult {
  projectRoot: string;
  agentforgeDir: string;
  dataDir: string;
  workspaceDbPath: string;
  workspace: WorkspaceRow;
  createdWorkspace: boolean;
  createdDirectories: string[];
  existingDirectories: string[];
  initializedAt: string;
}

export function initializeWorkspace(
  options: WorkspaceInitializationOptions = {},
): WorkspaceInitializationResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const agentforgeDir = join(projectRoot, '.agentforge');
  const dataDir = resolve(projectRoot, options.dataDir ?? join('.agentforge', 'v5'));
  const workspaceName = normalizeWorkspaceName(options.workspaceName, projectRoot);
  const ownerId = options.ownerId ?? 'system';

  const createdDirectories: string[] = [];
  const existingDirectories: string[] = [];
  for (const directory of [
    agentforgeDir,
    join(agentforgeDir, 'agents'),
    join(agentforgeDir, 'sprints'),
    join(agentforgeDir, 'cycles'),
    dataDir,
  ]) {
    if (existsSync(directory)) {
      existingDirectories.push(directory);
    } else {
      mkdirSync(directory, { recursive: true });
      createdDirectories.push(directory);
    }
  }

  const registry = new WorkspaceRegistry({ dataDir });
  let workspaceAdapter: WorkspaceAdapter | null = null;

  try {
    const slug = normalizeSlug(workspaceName);
    let workspace = registry.getWorkspaceBySlug(slug);
    let createdWorkspace = false;

    if (!workspace) {
      workspace = registry.createWorkspace(workspaceName, ownerId);
      createdWorkspace = true;
    }

    const workspaceDbPath = registry.getWorkspaceDbPath(workspace.slug);
    workspaceAdapter = new WorkspaceAdapter({
      dbPath: workspaceDbPath,
      workspaceId: workspace.id,
    });

    return {
      projectRoot,
      agentforgeDir,
      dataDir,
      workspaceDbPath,
      workspace,
      createdWorkspace,
      createdDirectories,
      existingDirectories,
      initializedAt: nowIso(),
    };
  } finally {
    workspaceAdapter?.close();
    registry.close();
  }
}

function normalizeWorkspaceName(workspaceName: string | undefined, projectRoot: string): string {
  const trimmed = workspaceName?.trim();
  if (trimmed && slugify(trimmed)) return trimmed;
  const fromProjectRoot = basename(projectRoot);
  return slugify(fromProjectRoot) ? fromProjectRoot : 'default';
}

function normalizeSlug(workspaceName: string): string {
  return slugify(workspaceName) || 'default';
}
