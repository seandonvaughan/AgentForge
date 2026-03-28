import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentVersionManager } from '../../packages/core/src/agent-versioning/index.js';
import { createServerV5 } from '../../packages/server/src/server.js';

// ── Unit tests: AgentVersionManager ───────────────────────────────────────────

describe('AgentVersionManager.recordVersion()', () => {
  let mgr: AgentVersionManager;

  beforeEach(() => { mgr = new AgentVersionManager(); });

  it('records a version and returns it with id, agentId, version, recordedAt', () => {
    const rec = mgr.recordVersion('coder', { model: 'sonnet' });
    expect(rec.id).toBeTruthy();
    expect(rec.agentId).toBe('coder');
    expect(rec.version).toBeTruthy();
    expect(rec.config).toEqual({ model: 'sonnet' });
    expect(rec.recordedAt).toBeTruthy();
  });

  it('increments version numbering with each new record', () => {
    const r1 = mgr.recordVersion('coder', { model: 'sonnet' });
    const r2 = mgr.recordVersion('coder', { model: 'opus' });
    // Both should have a version string and different ones
    expect(r1.version).not.toBe(r2.version);
  });

  it('stores optional notes when provided', () => {
    const rec = mgr.recordVersion('architect', { a: 1 }, 'Initial release');
    expect(rec.notes).toBe('Initial release');
  });

  it('config is a copy — mutating the original does not affect stored config', () => {
    const config: Record<string, unknown> = { x: 1 };
    mgr.recordVersion('coder', config);
    config.x = 999;
    const history = mgr.getHistory('coder');
    expect(history.versions[0].config.x).toBe(1);
  });
});

describe('AgentVersionManager.getHistory()', () => {
  let mgr: AgentVersionManager;

  beforeEach(() => { mgr = new AgentVersionManager(); });

  it('returns empty versions for unknown agent', () => {
    const history = mgr.getHistory('nonexistent');
    expect(history.agentId).toBe('nonexistent');
    expect(history.versions).toHaveLength(0);
    expect(history.pinnedVersionId).toBeNull();
  });

  it('returns newest version first', () => {
    mgr.recordVersion('coder', { v: 1 });
    mgr.recordVersion('coder', { v: 2 });
    const history = mgr.getHistory('coder');
    expect(history.versions[0].config.v).toBe(2);
    expect(history.versions[1].config.v).toBe(1);
  });

  it('reports pinnedVersionId once a pin is set', () => {
    const rec = mgr.recordVersion('coder', {});
    mgr.pin('coder', rec.id);
    const history = mgr.getHistory('coder');
    expect(history.pinnedVersionId).toBe(rec.id);
  });
});

describe('AgentVersionManager.pin()', () => {
  let mgr: AgentVersionManager;

  beforeEach(() => { mgr = new AgentVersionManager(); });

  it('pins a valid version and returns PinnedVersion', () => {
    const rec = mgr.recordVersion('coder', { model: 'haiku' });
    const pin = mgr.pin('coder', rec.id);
    expect(pin.agentId).toBe('coder');
    expect(pin.pinnedVersionId).toBe(rec.id);
    expect(pin.pinnedAt).toBeTruthy();
  });

  it('throws when versionId does not exist', () => {
    expect(() => mgr.pin('coder', 'nonexistent-id')).toThrow();
  });
});

describe('AgentVersionManager.getPinned()', () => {
  let mgr: AgentVersionManager;

  beforeEach(() => { mgr = new AgentVersionManager(); });

  it('returns null when no version is pinned', () => {
    mgr.recordVersion('coder', {});
    expect(mgr.getPinned('coder')).toBeNull();
  });

  it('returns the pinned version record after pinning', () => {
    const rec = mgr.recordVersion('coder', { model: 'sonnet' });
    mgr.pin('coder', rec.id);
    const pinned = mgr.getPinned('coder');
    expect(pinned?.id).toBe(rec.id);
    expect(pinned?.config).toEqual({ model: 'sonnet' });
  });
});

describe('AgentVersionManager.rollback()', () => {
  let mgr: AgentVersionManager;

  beforeEach(() => { mgr = new AgentVersionManager(); });

  it('rolls back to an earlier version', () => {
    const v1 = mgr.recordVersion('coder', { model: 'haiku' });
    mgr.recordVersion('coder', { model: 'opus' });
    const rolled = mgr.rollback('coder', v1.id);
    expect(rolled.id).toBe(v1.id);
    expect(mgr.getPinned('coder')?.id).toBe(v1.id);
  });

  it('throws when rolling back to nonexistent version', () => {
    mgr.recordVersion('coder', {});
    expect(() => mgr.rollback('coder', 'bad-id')).toThrow();
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

describe('Agent Versioning REST API', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4854, listen: false });
  });

  afterAll(() => server.app.close());

  it('GET /api/v5/agents/:id/versions returns empty history for unknown agent', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/agents/unknown-xyz/versions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.versions).toHaveLength(0);
    expect(body.data.pinnedVersionId).toBeNull();
  });

  it('POST /api/v5/agents/:id/versions records a version', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/test-agent/versions',
      payload: { config: { model: 'sonnet' }, notes: 'first version' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.agentId).toBe('test-agent');
    expect(body.data.config).toEqual({ model: 'sonnet' });
    expect(body.data.notes).toBe('first version');
  });

  it('POST /api/v5/agents/:id/versions returns 400 without config', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/test-agent/versions',
      payload: { notes: 'no config' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v5/agents/:id/pin returns 400 without versionId', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/test-agent/pin',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v5/agents/:id/pin returns 404 for unknown version', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/test-agent/pin',
      payload: { versionId: 'nonexistent' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('full workflow: record → pin → rollback', async () => {
    // Record v1
    const r1 = await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/workflow-agent/versions',
      payload: { config: { model: 'haiku' } },
    });
    expect(r1.statusCode).toBe(201);
    const v1Id = JSON.parse(r1.body).data.id;

    // Record v2
    await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/workflow-agent/versions',
      payload: { config: { model: 'opus' } },
    });

    // Rollback to v1
    const rollback = await server.app.inject({
      method: 'POST',
      url: '/api/v5/agents/workflow-agent/rollback',
      payload: { versionId: v1Id },
    });
    expect(rollback.statusCode).toBe(200);
    const rbBody = JSON.parse(rollback.body);
    expect(rbBody.data.id).toBe(v1Id);

    // Check history shows pin
    const history = await server.app.inject({ method: 'GET', url: '/api/v5/agents/workflow-agent/versions' });
    const hBody = JSON.parse(history.body);
    expect(hBody.data.pinnedVersionId).toBe(v1Id);
    expect(hBody.data.versions).toHaveLength(2);
  });
});
