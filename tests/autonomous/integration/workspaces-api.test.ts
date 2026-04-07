// tests/autonomous/integration/workspaces-api.test.ts
//
// v6.6.0 Agent B — workspace registry HTTP API + cycles workspaceId routing.
//
// Each test uses a fresh tmp HOME so the registry file lives in
// isolation, and the cycles endpoint registers against a "default"
// project root that we ALSO seed with one cycle to verify the
// fallback (no workspaceId = use default) still works.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workspacesRoutes } from '../../../packages/server/src/routes/v5/workspaces.js';
import { cyclesRoutes } from '../../../packages/server/src/routes/v5/cycles.js';

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let app: FastifyInstance;

function seedCycle(root: string, cycleId: string, sprintVersion: string) {
  const dir = join(root, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cycle.json'),
    JSON.stringify({
      cycleId,
      sprintVersion,
      stage: 'completed',
      startedAt: '2026-04-06T10:00:00.000Z',
      completedAt: '2026-04-06T10:30:00.000Z',
      durationMs: 1_800_000,
      cost: { totalUsd: 1, budgetUsd: 5, byAgent: {}, byPhase: {} },
      tests: { passed: 1, failed: 0, skipped: 0, total: 1, passRate: 1, newFailures: [] },
      git: { branch: 'b', commitSha: 'sha', filesChanged: [] },
      pr: { url: null, number: null, draft: false },
    }),
  );
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'agentforge-wsapi-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  app = Fastify({ logger: false });
  await workspacesRoutes(app);
  // Default project root for cycles routes — used when no workspaceId.
  await cyclesRoutes(app, { projectRoot: tmpHome });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /api/v5/workspaces', () => {
  it('returns an empty list when nothing is registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/workspaces' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.defaultWorkspaceId).toBeNull();
    expect(body.meta.total).toBe(0);
  });

  it('lists registered workspaces after POST', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'AgentForge', path: '/p/agentforge' },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().id).toBe('agentforge');

    const list = await app.inject({ method: 'GET', url: '/api/v5/workspaces' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().defaultWorkspaceId).toBe('agentforge');
  });
});

describe('POST /api/v5/workspaces', () => {
  it('rejects missing name with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { path: '/p' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing path with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/v5/workspaces/:id', () => {
  it('removes a workspace and returns 204', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'A', path: '/a' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/v5/workspaces/a' });
    expect(del.statusCode).toBe(204);
  });

  it('returns 404 when deleting an unknown workspace', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/v5/workspaces/nope' });
    expect(del.statusCode).toBe(404);
  });
});

describe('GET / PATCH /api/v5/workspaces/default', () => {
  it('GET default returns 404 when nothing is registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/workspaces/default' });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH default to a known id updates and GET returns it', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'A', path: '/a' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'B', path: '/b' },
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v5/workspaces/default',
      payload: { workspaceId: 'b' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().id).toBe('b');

    const get = await app.inject({ method: 'GET', url: '/api/v5/workspaces/default' });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe('b');
  });

  it('PATCH default to unknown id returns 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/workspaces/default',
      payload: { workspaceId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('cycles endpoint honors ?workspaceId=', () => {
  it('falls back to default project root when no workspaceId is provided', async () => {
    seedCycle(tmpHome, 'default-cycle', 'v0.1.0');
    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });
    expect(res.statusCode).toBe(200);
    expect(res.json().cycles.map((c: { cycleId: string }) => c.cycleId)).toContain('default-cycle');
  });

  it('routes to a different workspace when ?workspaceId= matches a registered entry', async () => {
    // Create a second project root and register it
    const otherRoot = mkdtempSync(join(tmpdir(), 'agentforge-wsapi-other-'));
    seedCycle(otherRoot, 'other-cycle', 'v0.2.0');
    await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'Other', path: otherRoot },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles?workspaceId=other',
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().cycles.map((c: { cycleId: string }) => c.cycleId);
    expect(ids).toContain('other-cycle');
    expect(ids).not.toContain('default-cycle');

    try { rmSync(otherRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 404 when ?workspaceId= references an unknown workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles?workspaceId=does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().workspaceId).toBe('does-not-exist');
  });

  it('honors x-workspace-id header as an alternative to the query param', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'agentforge-wsapi-hdr-'));
    seedCycle(otherRoot, 'hdr-cycle', 'v0.3.0');
    await app.inject({
      method: 'POST',
      url: '/api/v5/workspaces',
      payload: { name: 'HdrWs', path: otherRoot },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles',
      headers: { 'x-workspace-id': 'hdrws' },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().cycles.map((c: { cycleId: string }) => c.cycleId);
    expect(ids).toContain('hdr-cycle');

    try { rmSync(otherRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
