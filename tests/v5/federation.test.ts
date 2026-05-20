import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  FEDERATION_PROTOCOL_VERSION,
  FederationManager,
  FederationPeer,
  SharedLearning,
} from '../../packages/core/src/federation/index.js';
import { createServerV5 } from '../../packages/server/src/server.js';

// ── Unit tests: FederationManager ─────────────────────────────────────────────

const makePeer = (id: string): Omit<FederationPeer, 'registeredAt' | 'reachable'> => ({
  id,
  name: `Peer ${id}`,
  url: `https://${id}.example.com`,
});

describe('FederationManager.registerPeer()', () => {
  let mgr: FederationManager;

  beforeEach(() => { mgr = new FederationManager({ dryRun: true }); });

  it('registers a peer and returns it with registeredAt and reachable', () => {
    const peer = mgr.registerPeer(makePeer('p1'));
    expect(peer.id).toBe('p1');
    expect(peer.name).toBe('Peer p1');
    expect(peer.url).toBe('https://p1.example.com');
    expect(peer.registeredAt).toBeTruthy();
    expect(typeof peer.reachable).toBe('boolean');
  });

  it('registers multiple peers', () => {
    mgr.registerPeer(makePeer('p1'));
    mgr.registerPeer(makePeer('p2'));
    expect(mgr.listPeers()).toHaveLength(2);
  });

  it('throws when maxPeers limit is exceeded', () => {
    const limited = new FederationManager({ dryRun: true, maxPeers: 2 });
    limited.registerPeer(makePeer('p1'));
    limited.registerPeer(makePeer('p2'));
    expect(() => limited.registerPeer(makePeer('p3'))).toThrow();
  });

  it('in dry-run mode sets reachable to true', () => {
    const peer = mgr.registerPeer(makePeer('p1'));
    expect(peer.reachable).toBe(true);
  });
});

describe('FederationManager.listPeers()', () => {
  it('returns empty array initially', () => {
    const mgr = new FederationManager();
    expect(mgr.listPeers()).toHaveLength(0);
  });

  it('returns all registered peers', () => {
    const mgr = new FederationManager();
    mgr.registerPeer(makePeer('a'));
    mgr.registerPeer(makePeer('b'));
    const peers = mgr.listPeers();
    expect(peers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });
});

describe('FederationManager.shareLearning()', () => {
  let mgr: FederationManager;

  beforeEach(() => { mgr = new FederationManager({ dryRun: true }); });

  it('stores and returns the learning with id and learnedAt', () => {
    const learning = mgr.shareLearning({
      agentId: 'coder',
      category: 'patterns',
      content: 'Use async/await over callbacks',
      confidence: 0.9,
      sourcePeerId: null,
    });
    expect(learning.id).toBeTruthy();
    expect(learning.agentId).toBe('coder');
    expect(learning.category).toBe('patterns');
    expect(learning.confidence).toBe(0.9);
    expect(learning.learnedAt).toBeTruthy();
    expect(learning.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(learning.piiRedactions).toBe(0);
  });

  it('strips email PII from content', () => {
    const learning = mgr.shareLearning({
      agentId: 'coder',
      category: 'test',
      content: 'Contact user@example.com for details',
      confidence: 0.5,
      sourcePeerId: null,
    });
    expect(learning.content).not.toContain('user@example.com');
    expect(learning.content).toContain('[REDACTED]');
    expect(learning.piiRedactions).toBe(1);
  });

  it('strips phone numbers from content', () => {
    const learning = mgr.shareLearning({
      agentId: 'coder',
      category: 'test',
      content: 'Call 555-123-4567 for support',
      confidence: 0.5,
      sourcePeerId: null,
    });
    expect(learning.content).not.toContain('555-123-4567');
  });

  it('content without PII passes through unchanged', () => {
    const clean = 'Use dependency injection for testability';
    const learning = mgr.shareLearning({
      agentId: 'architect',
      category: 'design',
      content: clean,
      confidence: 0.95,
      sourcePeerId: null,
    });
    expect(learning.content).toBe(clean);
  });
});

describe('FederationManager.receiveLearning()', () => {
  let mgr: FederationManager;

  beforeEach(() => { mgr = new FederationManager({ dryRun: true }); });

  it('receives and stores a peer learning', () => {
    const learning: SharedLearning = {
      id: 'learn-remote-1',
      agentId: 'remote-agent',
      category: 'performance',
      content: 'Cache frequently accessed data',
      confidence: 0.85,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-alpha',
    };
    mgr.receiveLearning(learning);
    const stored = mgr.getSharedLearnings();
    expect(stored.some((l) => l.id === 'learn-remote-1')).toBe(true);
  });

  it('strips PII from received learning content', () => {
    const learning: SharedLearning = {
      id: 'learn-pii',
      agentId: 'remote',
      category: 'test',
      content: 'admin@corp.com is the contact',
      confidence: 0.5,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-1',
    };
    const sanitized = mgr.receiveLearning(learning);
    expect(sanitized.content).not.toContain('admin@corp.com');
    expect(sanitized.piiRedactions).toBe(1);
    expect(Number.isFinite(sanitized.piiRedactions)).toBe(true);
  });

  it('normalizes malformed inbound redaction counts before storing', () => {
    const learning: SharedLearning = {
      id: 'learn-bad-redactions',
      agentId: 'remote',
      category: 'test',
      content: 'admin@corp.com is the contact',
      confidence: 0.5,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-1',
      piiRedactions: Number.NaN,
    };
    const sanitized = mgr.receiveLearning(learning);
    expect(sanitized.piiRedactions).toBe(1);
    expect(mgr.getStatus().metrics.piiRedactions).toBe(1);
  });

  it('rejects unsupported federation protocol versions and records the rejection', () => {
    const learning: SharedLearning = {
      id: 'learn-old-protocol',
      protocolVersion: 'agentforge-federation-v0',
      agentId: 'remote',
      category: 'test',
      content: 'legacy payload',
      confidence: 0.8,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-1',
    };
    expect(() => mgr.receiveLearning(learning)).toThrow(/Unsupported federation protocol/);
    const status = mgr.getStatus();
    expect(status.metrics.rejected).toBe(1);
    expect(status.metrics.lastRejectedReason).toContain('Unsupported federation protocol');
  });

  it('can require inbound learnings to come from registered peers', () => {
    const guarded = new FederationManager({ dryRun: true, requireRegisteredPeers: true });
    const learning: SharedLearning = {
      id: 'learn-peer-policy',
      agentId: 'remote',
      category: 'test',
      content: 'registered peers only',
      confidence: 0.8,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-1',
    };
    expect(() => guarded.receiveLearning(learning)).toThrow(/Unknown federation peer/);

    guarded.registerPeer(makePeer('peer-1'));
    const accepted = guarded.receiveLearning(learning);
    expect(accepted.sourcePeerId).toBe('peer-1');
    expect(guarded.getStatus().metrics.received).toBe(1);
  });
});

describe('FederationManager.getStatus()', () => {
  it('returns enabled: true, dryRun: true by default', () => {
    const mgr = new FederationManager();
    const status = mgr.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.dryRun).toBe(true);
    expect(status.peerCount).toBe(0);
    expect(status.learningCount).toBe(0);
    expect(status.checkedAt).toBeTruthy();
    expect(status.safetyControls.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(status.safetyControls.networkExchangeEnabled).toBe(false);
    expect(status.metrics.rejected).toBe(0);
  });

  it('reflects current peer and learning counts', () => {
    const mgr = new FederationManager();
    mgr.registerPeer(makePeer('p1'));
    mgr.shareLearning({ agentId: 'a', category: 'c', content: 'x', confidence: 1, sourcePeerId: null });
    const status = mgr.getStatus();
    expect(status.peerCount).toBe(1);
    expect(status.learningCount).toBe(1);
    expect(status.metrics.shared).toBe(1);
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

describe('Federation REST API', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4855, listen: false });
  });

  afterAll(() => server.app.close());

  it('GET /api/v5/federation/status returns status with dryRun', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/federation/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(typeof body.data.peerCount).toBe('number');
    expect(body.data.safetyControls.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(body.data.safetyControls.networkExchangeEnabled).toBe(false);
  });

  it('GET /api/v5/federation/peers returns empty array initially', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/federation/peers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /api/v5/federation/peers registers a peer', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/peers',
      payload: { id: 'peer-test-1', name: 'Test Peer', url: 'https://test.example.com' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBe('peer-test-1');
    expect(body.data.reachable).toBe(true);
  });

  it('POST /api/v5/federation/peers returns 400 when required fields missing', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/peers',
      payload: { name: 'Missing ID' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/v5/federation/learnings returns empty array initially (fresh route)', async () => {
    const srv = await createServerV5({ port: 4856, listen: false });
    const res = await srv.app.inject({ method: 'GET', url: '/api/v5/federation/learnings' });
    await srv.app.close();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /api/v5/federation/share shares a learning', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/share',
      payload: {
        agentId: 'coder',
        category: 'patterns',
        content: 'Prefer immutable data structures',
        confidence: 0.9,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBeTruthy();
    expect(body.data.agentId).toBe('coder');
    expect(body.data.category).toBe('patterns');
    expect(body.data.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
  });

  it('POST /api/v5/federation/share returns 400 when required fields missing', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/share',
      payload: { agentId: 'coder' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v5/federation/share returns 422 when safety controls reject payload', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/share',
      payload: {
        agentId: 'coder',
        category: 'patterns',
        content: { text: 'not a string' },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('LEARNING_REJECTED');
  });

  it('shared learning appears in GET /api/v5/federation/learnings', async () => {
    // Share a learning
    await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/share',
      payload: { agentId: 'architect', category: 'design', content: 'SOLID principles apply here' },
    });

    const res = await server.app.inject({ method: 'GET', url: '/api/v5/federation/learnings' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
  });
});
