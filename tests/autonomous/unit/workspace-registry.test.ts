// tests/autonomous/unit/workspace-registry.test.ts
//
// v6.6.0 Agent B — workspace registry CRUD.
//
// Each test uses a fresh tmp HOME so ~/.agentforge/workspaces.json is
// isolated. The registry module reads HOME via os.homedir() at call
// time, so overriding process.env.HOME (and USERPROFILE on Windows)
// before invoking each function is sufficient.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addWorkspace,
  getDefaultWorkspace,
  getWorkspace,
  loadWorkspaceRegistry,
  registryPath,
  removeWorkspace,
  saveWorkspaceRegistry,
  setDefaultWorkspace,
} from '../../../packages/core/src/autonomous/workspace-registry.js';

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'agentforge-wsreg-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('workspace-registry', () => {
  it('returns an empty registry when the file does not exist', () => {
    const reg = loadWorkspaceRegistry();
    expect(reg).toEqual({ workspaces: [], defaultWorkspaceId: null });
    expect(existsSync(registryPath())).toBe(false);
  });

  it('addWorkspace creates the file and assigns the first entry as default', () => {
    const ws = addWorkspace('AgentForge', '/Users/x/Projects/AgentForge');
    expect(ws.id).toBe('agentforge');
    expect(ws.name).toBe('AgentForge');
    expect(ws.path).toBe('/Users/x/Projects/AgentForge');
    expect(ws.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(registryPath())).toBe(true);

    const reg = loadWorkspaceRegistry();
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.defaultWorkspaceId).toBe('agentforge');
  });

  it('addWorkspace assigns unique ids on slug collision', () => {
    const a = addWorkspace('My App', '/tmp/a');
    const b = addWorkspace('My App', '/tmp/b');
    const c = addWorkspace('My App', '/tmp/c');
    expect(a.id).toBe('my-app');
    expect(b.id).toBe('my-app-2');
    expect(c.id).toBe('my-app-3');
  });

  it('getWorkspace returns the entry by id, or null', () => {
    addWorkspace('AgentForge', '/p/agentforge');
    expect(getWorkspace('agentforge')?.path).toBe('/p/agentforge');
    expect(getWorkspace('nope')).toBeNull();
  });

  it('getDefaultWorkspace falls back to the first workspace when no default is set', () => {
    saveWorkspaceRegistry({
      workspaces: [
        { id: 'one', name: 'One', path: '/1', addedAt: 't' },
        { id: 'two', name: 'Two', path: '/2', addedAt: 't' },
      ],
      defaultWorkspaceId: null,
    });
    expect(getDefaultWorkspace()?.id).toBe('one');
  });

  it('setDefaultWorkspace updates the default and rejects unknown ids', () => {
    addWorkspace('A', '/a');
    addWorkspace('B', '/b');
    expect(setDefaultWorkspace('b')).toBe(true);
    expect(getDefaultWorkspace()?.id).toBe('b');
    expect(setDefaultWorkspace('nope')).toBe(false);
    expect(getDefaultWorkspace()?.id).toBe('b');
  });

  it('removeWorkspace removes by id, returns false when not found, and reassigns default if needed', () => {
    addWorkspace('A', '/a');
    addWorkspace('B', '/b');
    expect(removeWorkspace('nope')).toBe(false);
    expect(removeWorkspace('a')).toBe(true);
    const reg = loadWorkspaceRegistry();
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.defaultWorkspaceId).toBe('b');
  });

  it('loadWorkspaceRegistry returns empty registry when file is malformed', () => {
    mkdirSync(join(tmpHome, '.agentforge'), { recursive: true });
    writeFileSync(registryPath(), '{not json');
    const reg = loadWorkspaceRegistry();
    expect(reg.workspaces).toEqual([]);
    expect(reg.defaultWorkspaceId).toBeNull();
  });

  it('saveWorkspaceRegistry roundtrips through loadWorkspaceRegistry', () => {
    const reg = {
      workspaces: [
        { id: 'x', name: 'X', path: '/x', addedAt: '2026-01-01T00:00:00.000Z' },
      ],
      defaultWorkspaceId: 'x',
    };
    saveWorkspaceRegistry(reg);
    expect(loadWorkspaceRegistry()).toEqual(reg);
    // file is JSON-formatted with trailing newline
    const text = readFileSync(registryPath(), 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
  });
});
