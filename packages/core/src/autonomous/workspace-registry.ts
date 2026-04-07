// packages/core/src/autonomous/workspace-registry.ts
//
// v6.6.0 Agent B — multi-workspace registry.
//
// Global registry at ~/.agentforge/workspaces.json listing all known
// project directories (workspaces) that the CLI and server can target
// for autonomous cycles. Shared across CLI invocations and server
// processes so a single server instance can manage cycles across many
// repos without being restarted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface WorkspaceRegistry {
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
}

/** Absolute path to the on-disk registry file. */
export function registryPath(): string {
  return join(homedir(), '.agentforge', 'workspaces.json');
}

/** Read the registry from disk. Returns an empty registry if the file
 * doesn't exist or is malformed. Never throws. */
export function loadWorkspaceRegistry(): WorkspaceRegistry {
  const file = registryPath();
  if (!existsSync(file)) return { workspaces: [], defaultWorkspaceId: null };
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceRegistry>;
    const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    const defaultWorkspaceId =
      typeof parsed.defaultWorkspaceId === 'string' ? parsed.defaultWorkspaceId : null;
    return { workspaces, defaultWorkspaceId };
  } catch {
    return { workspaces: [], defaultWorkspaceId: null };
  }
}

/** Write the registry to disk, creating the parent dir if needed. */
export function saveWorkspaceRegistry(reg: WorkspaceRegistry): void {
  const file = registryPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(reg, null, 2) + '\n', 'utf-8');
}

/** URL-safe slugify a workspace name into a stable id. Collisions get
 * a numeric suffix (-2, -3, ...). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'workspace';
}

function uniqueId(base: string, existing: Workspace[]): string {
  const taken = new Set(existing.map((w) => w.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Append a workspace to the registry and persist. Returns the new
 * entry (with its assigned id). If the registry is empty, the new
 * entry becomes the default. */
export function addWorkspace(name: string, path: string): Workspace {
  const reg = loadWorkspaceRegistry();
  const id = uniqueId(slugify(name), reg.workspaces);
  const ws: Workspace = {
    id,
    name,
    path,
    addedAt: new Date().toISOString(),
  };
  reg.workspaces.push(ws);
  if (reg.defaultWorkspaceId === null) {
    reg.defaultWorkspaceId = id;
  }
  saveWorkspaceRegistry(reg);
  return ws;
}

/** Remove a workspace by id. Returns true if removed, false if not
 * found. If the removed workspace was the default, the default is
 * cleared (the next workspace in the list, if any, is NOT auto-
 * promoted — explicit opt-in via setDefaultWorkspace). */
export function removeWorkspace(id: string): boolean {
  const reg = loadWorkspaceRegistry();
  const idx = reg.workspaces.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  reg.workspaces.splice(idx, 1);
  if (reg.defaultWorkspaceId === id) {
    reg.defaultWorkspaceId = reg.workspaces[0]?.id ?? null;
  }
  saveWorkspaceRegistry(reg);
  return true;
}

export function getWorkspace(id: string): Workspace | null {
  const reg = loadWorkspaceRegistry();
  return reg.workspaces.find((w) => w.id === id) ?? null;
}

/** Return the default workspace. Falls back to the first workspace
 * if no default is set. Returns null if the registry is empty. */
export function getDefaultWorkspace(): Workspace | null {
  const reg = loadWorkspaceRegistry();
  if (reg.defaultWorkspaceId) {
    const ws = reg.workspaces.find((w) => w.id === reg.defaultWorkspaceId);
    if (ws) return ws;
  }
  return reg.workspaces[0] ?? null;
}

/** Set the default workspace. Returns true on success, false if the
 * id is unknown. */
export function setDefaultWorkspace(id: string): boolean {
  const reg = loadWorkspaceRegistry();
  if (!reg.workspaces.some((w) => w.id === id)) return false;
  reg.defaultWorkspaceId = id;
  saveWorkspaceRegistry(reg);
  return true;
}
