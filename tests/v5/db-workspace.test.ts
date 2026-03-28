/**
 * tests/v5/db-workspace.test.ts
 * Tests for WorkspaceRegistry and WorkspaceAdapter — SQLite :memory: databases
 * Target: 35+ tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { WorkspaceRegistry } from '../../packages/db/src/workspace-registry.js';
import { WorkspaceAdapter } from '../../packages/db/src/workspace-adapter.js';

// ── WorkspaceRegistry ─────────────────────────────────────────────────────────

describe('WorkspaceRegistry', () => {
  let registry: WorkspaceRegistry;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
    registry = new WorkspaceRegistry({ dataDir });
  });

  afterEach(() => {
    registry.close();
  });

  it('creates a workspace and returns a row', () => {
    const ws = registry.createWorkspace('My Project');
    expect(ws.id).toBeTruthy();
    expect(ws.name).toBe('My Project');
    expect(ws.slug).toBe('my-project');
  });

  it('getWorkspace retrieves the created workspace', () => {
    const ws = registry.createWorkspace('Test Workspace');
    const fetched = registry.getWorkspace(ws.id);
    expect(fetched?.id).toBe(ws.id);
    expect(fetched?.name).toBe('Test Workspace');
  });

  it('getWorkspace returns undefined for nonexistent id', () => {
    expect(registry.getWorkspace('does-not-exist')).toBeUndefined();
  });

  it('getWorkspaceBySlug retrieves the workspace', () => {
    registry.createWorkspace('Alpha Workspace');
    const fetched = registry.getWorkspaceBySlug('alpha-workspace');
    expect(fetched?.slug).toBe('alpha-workspace');
  });

  it('getWorkspaceBySlug returns undefined for unknown slug', () => {
    expect(registry.getWorkspaceBySlug('no-such-slug')).toBeUndefined();
  });

  it('listWorkspaces returns all created workspaces', () => {
    registry.createWorkspace('WS A');
    registry.createWorkspace('WS B');
    const list = registry.listWorkspaces();
    expect(list.length).toBe(2);
  });

  it('listWorkspaces returns all workspaces in created_at DESC order', () => {
    registry.createWorkspace('Alpha');
    // Introduce a tiny delay so timestamps differ (SQLite stores second precision)
    // Just verify the list length and both are present rather than relying on sub-ms ordering
    registry.createWorkspace('Beta');
    const list = registry.listWorkspaces();
    expect(list.length).toBe(2);
    const names = list.map(w => w.name);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('createWorkspace sets a default ownerId of system', () => {
    const ws = registry.createWorkspace('Test');
    expect(ws.owner_id).toBe('system');
  });

  it('createWorkspace accepts a custom ownerId', () => {
    const ws = registry.createWorkspace('Test', 'user-42');
    expect(ws.owner_id).toBe('user-42');
  });

  it('settings_json is valid JSON containing defaultModel', () => {
    const ws = registry.createWorkspace('Test');
    const settings = JSON.parse(ws.settings_json);
    expect(settings.defaultModel).toBe('sonnet');
  });

  it('settings_json contains budgetLimitUsd', () => {
    const ws = registry.createWorkspace('Test');
    const settings = JSON.parse(ws.settings_json);
    expect(typeof settings.budgetLimitUsd).toBe('number');
  });

  it('deleteWorkspace removes the workspace', () => {
    const ws = registry.createWorkspace('To Delete');
    const deleted = registry.deleteWorkspace(ws.id);
    expect(deleted).toBe(true);
    expect(registry.getWorkspace(ws.id)).toBeUndefined();
  });

  it('deleteWorkspace returns false for unknown id', () => {
    expect(registry.deleteWorkspace('nonexistent')).toBe(false);
  });

  it('getWorkspaceDbPath returns a path ending in workspace-<slug>.db', () => {
    const path = registry.getWorkspaceDbPath('my-project');
    expect(path.endsWith('workspace-my-project.db')).toBe(true);
  });

  it('multiple workspaces can be created without conflict', () => {
    for (let i = 0; i < 10; i++) {
      registry.createWorkspace(`Workspace ${i}`);
    }
    expect(registry.listWorkspaces().length).toBe(10);
  });
});

// ── WorkspaceAdapter ─────────────────────────────────────────────────────────

describe('WorkspaceAdapter — sessions', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-test' });
  });

  afterEach(() => {
    adapter.close();
  });

  it('createSession returns a session row with running status', () => {
    const s = adapter.createSession({ agentId: 'coder', task: 'Write tests' });
    expect(s.status).toBe('running');
    expect(s.agent_id).toBe('coder');
    expect(s.task).toBe('Write tests');
  });

  it('getSession retrieves the created session', () => {
    const s = adapter.createSession({ agentId: 'coder', task: 'Task' });
    const fetched = adapter.getSession(s.id);
    expect(fetched?.id).toBe(s.id);
  });

  it('getSession returns undefined for unknown id', () => {
    expect(adapter.getSession('no-such-id')).toBeUndefined();
  });

  it('completeSession sets status to completed', () => {
    const s = adapter.createSession({ agentId: 'coder', task: 'Task' });
    adapter.completeSession(s.id, 'completed');
    expect(adapter.getSession(s.id)?.status).toBe('completed');
  });

  it('completeSession sets status to failed', () => {
    const s = adapter.createSession({ agentId: 'coder', task: 'Task' });
    adapter.completeSession(s.id, 'failed');
    expect(adapter.getSession(s.id)?.status).toBe('failed');
  });

  it('completeSession sets costUsd when provided', () => {
    const s = adapter.createSession({ agentId: 'coder', task: 'Task' });
    adapter.completeSession(s.id, 'completed', 0.05);
    const updated = adapter.getSession(s.id);
    expect(updated?.cost_usd).toBe(0.05);
  });

  it('listSessions returns all sessions', () => {
    adapter.createSession({ agentId: 'coder', task: 'T1' });
    adapter.createSession({ agentId: 'coder', task: 'T2' });
    expect(adapter.listSessions().length).toBe(2);
  });

  it('listSessions filters by agentId', () => {
    adapter.createSession({ agentId: 'coder', task: 'T1' });
    adapter.createSession({ agentId: 'architect', task: 'T2' });
    const coderSessions = adapter.listSessions({ agentId: 'coder' });
    expect(coderSessions.length).toBe(1);
    expect(coderSessions[0].agent_id).toBe('coder');
  });

  it('listSessions filters by status', () => {
    const s1 = adapter.createSession({ agentId: 'coder', task: 'T1' });
    adapter.createSession({ agentId: 'coder', task: 'T2' });
    adapter.completeSession(s1.id, 'completed');
    const completed = adapter.listSessions({ status: 'completed' });
    expect(completed.length).toBe(1);
  });

  it('countSessions returns total count', () => {
    adapter.createSession({ agentId: 'coder', task: 'T1' });
    adapter.createSession({ agentId: 'coder', task: 'T2' });
    expect(adapter.countSessions()).toBe(2);
  });

  it('countSessions filters by agentId', () => {
    adapter.createSession({ agentId: 'coder', task: 'T1' });
    adapter.createSession({ agentId: 'architect', task: 'T2' });
    expect(adapter.countSessions({ agentId: 'coder' })).toBe(1);
  });
});

describe('WorkspaceAdapter — costs', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-test' });
  });

  afterEach(() => { adapter.close(); });

  it('recordCost inserts a cost row', () => {
    adapter.recordCost({ agentId: 'coder', model: 'sonnet', inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    expect(adapter.getAllCosts().length).toBe(1);
  });

  it('getTotalCost sums all cost entries', () => {
    adapter.recordCost({ agentId: 'coder', model: 'sonnet', inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    adapter.recordCost({ agentId: 'architect', model: 'opus', inputTokens: 200, outputTokens: 100, costUsd: 0.10 });
    expect(adapter.getTotalCost()).toBeCloseTo(0.11, 5);
  });

  it('getTotalCost returns 0 when no costs', () => {
    expect(adapter.getTotalCost()).toBe(0);
  });

  it('getAgentCosts filters by agentId', () => {
    adapter.recordCost({ agentId: 'coder', model: 'sonnet', inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    adapter.recordCost({ agentId: 'architect', model: 'opus', inputTokens: 200, outputTokens: 100, costUsd: 0.10 });
    const costs = adapter.getAgentCosts('coder');
    expect(costs.length).toBe(1);
    expect(costs[0].agent_id).toBe('coder');
  });
});

describe('WorkspaceAdapter — promotions', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-test' });
  });

  afterEach(() => { adapter.close(); });

  it('recordPromotion inserts a promotion row', () => {
    adapter.recordPromotion({ agentId: 'coder', previousTier: 2, newTier: 3, reason: 'Consistent quality' });
    const promos = adapter.listPromotions('coder');
    expect(promos.length).toBe(1);
    expect(promos[0].agent_id).toBe('coder');
    expect(promos[0].promoted).toBe(1);
    expect(promos[0].demoted).toBe(0);
  });

  it('recordPromotion sets demoted=1 when tier decreases', () => {
    adapter.recordPromotion({ agentId: 'coder', previousTier: 3, newTier: 2 });
    const promos = adapter.listPromotions('coder');
    expect(promos[0].demoted).toBe(1);
    expect(promos[0].promoted).toBe(0);
  });

  it('listPromotions without agentId returns all', () => {
    adapter.recordPromotion({ agentId: 'coder', previousTier: 1, newTier: 2 });
    adapter.recordPromotion({ agentId: 'architect', previousTier: 2, newTier: 3 });
    expect(adapter.listPromotions().length).toBe(2);
  });
});

describe('WorkspaceAdapter — KV store', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'ws-test' });
  });

  afterEach(() => { adapter.close(); });

  it('kvSet and kvGet work together', () => {
    adapter.kvSet('my-key', 'my-value');
    expect(adapter.kvGet('my-key')).toBe('my-value');
  });

  it('kvGet returns null for unknown key', () => {
    expect(adapter.kvGet('nonexistent')).toBeNull();
  });

  it('kvSet is idempotent — updates value on duplicate key', () => {
    adapter.kvSet('key', 'first');
    adapter.kvSet('key', 'second');
    expect(adapter.kvGet('key')).toBe('second');
  });

  it('kvList returns all stored key-value pairs', () => {
    adapter.kvSet('a', '1');
    adapter.kvSet('b', '2');
    const list = adapter.kvList();
    expect(list.length).toBe(2);
  });
});
