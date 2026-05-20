import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  FEDERATION_LEARNING_SCHEMA_VERSION,
  FEDERATION_PROTOCOL_VERSION,
  FederationManager,
  FederationSafetyError,
} from '../../packages/core/src/federation/index.js';
import type { FederationPeer, SharedLearning } from '../../packages/core/src/federation/index.js';
import { createServerV5 } from '../../packages/server/src/server.js';

// ── Unit tests: FederationManager ─────────────────────────────────────────────

const makePeer = (id: string): Omit<FederationPeer, 'registeredAt' | 'reachable'> => ({
  id,
  name: `Peer ${id}`,
  url: `https://${id}.example.com`,
  protocolVersion: FEDERATION_PROTOCOL_VERSION,
});

describe('FederationManager.registerPeer()', () => {
  let mgr: FederationManager;

  beforeEach(() => { mgr = new FederationManager({ enabled: true, dryRun: true }); });

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
    const limited = new FederationManager({ enabled: true, dryRun: true, maxPeers: 2 });
    limited.registerPeer(makePeer('p1'));
    limited.registerPeer(makePeer('p2'));
    expect(() => limited.registerPeer(makePeer('p3'))).toThrow(FederationSafetyError);
    expect(limited.getStatus().metrics.lastBlockedReason).toBe('PEER_LIMIT_EXCEEDED');
  });

  it('in dry-run mode sets reachable to true', () => {
    const peer = mgr.registerPeer(makePeer('p1'));
    expect(peer.reachable).toBe(true);
  });

  it('blocks peer registration by default until operator opt-in', () => {
    const disabled = new FederationManager();
    expect(() => disabled.registerPeer(makePeer('p1'))).toThrow(FederationSafetyError);
    const status = disabled.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.state).toBe('preview-disabled');
    expect(status.metrics.blockedOperations).toBe(1);
    expect(status.metrics.lastBlockedReason).toBe('FEDERATION_DISABLED');
  });

  it('requires exact peer protocol version match', () => {
    const peer = { ...makePeer('p1'), protocolVersion: '0.0.0-old' };
    expect(() => mgr.registerPeer(peer)).toThrow(FederationSafetyError);
    expect(mgr.getStatus().metrics.lastBlockedReason).toBe('PROTOCOL_VERSION_MISMATCH');
  });
});

describe('FederationManager.listPeers()', () => {
  it('returns empty array initially', () => {
    const mgr = new FederationManager();
    expect(mgr.listPeers()).toHaveLength(0);
  });

  it('returns all registered peers', () => {
    const mgr = new FederationManager({ enabled: true });
    mgr.registerPeer(makePeer('a'));
    mgr.registerPeer(makePeer('b'));
    const peers = mgr.listPeers();
    expect(peers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });
});

describe('FederationManager.shareLearning()', () => {
  let mgr: FederationManager;

  beforeEach(() => { mgr = new FederationManager({ enabled: true, dryRun: true }); });

  it('stores and returns the learning with id and learnedAt', () => {
    const learning = mgr.shareLearning({
      agentId: 'coder',
      category: 'patterns',
      content: 'Use async/await over callbacks',
      confidence: 0.9,
      sourcePeerId: null,
    });
    expect(learning.id).toBeTruthy();
    expect(learning.schemaVersion).toBe(FEDERATION_LEARNING_SCHEMA_VERSION);
    expect(learning.agentId).toBe('coder');
    expect(learning.category).toBe('patterns');
    expect(learning.confidence).toBe(0.9);
    expect(learning.piiRedactions).toBe(0);
    expect(learning.learnedAt).toBeTruthy();
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
    expect(mgr.getStatus().metrics.piiRedactions).toBe(1);
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
    expect(learning.piiRedactions).toBe(1);
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

  it('blocks oversized learning content before storage', () => {
    const limited = new FederationManager({ enabled: true, maxContentLength: 8 });
    expect(() => limited.shareLearning({
      agentId: 'coder',
      category: 'test',
      content: 'too long for this limit',
      confidence: 0.5,
      sourcePeerId: null,
    })).toThrow(FederationSafetyError);
    expect(limited.getSharedLearnings()).toHaveLength(0);
    expect(limited.getStatus().metrics.lastBlockedReason).toBe('CONTENT_TOO_LARGE');
  });
});

describe('FederationManager.receiveLearning()', () => {
  let mgr: FederationManager;

  beforeEach(() => { mgr = new FederationManager({ enabled: true, dryRun: true, allowRemoteLearningIngest: true }); });

  it('receives and stores a peer learning', () => {
    const learning: SharedLearning = {
      id: 'learn-remote-1',
      schemaVersion: FEDERATION_LEARNING_SCHEMA_VERSION,
      agentId: 'remote-agent',
      category: 'performance',
      content: 'Cache frequently accessed data',
      piiRedactions: 0,
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
      schemaVersion: FEDERATION_LEARNING_SCHEMA_VERSION,
      agentId: 'remote',
      category: 'test',
      content: 'admin@corp.com is the contact',
      piiRedactions: 0,
      confidence: 0.5,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-1',
    };
    const sanitized = mgr.receiveLearning(learning);
    expect(sanitized.content).not.toContain('admin@corp.com');
    expect(sanitized.piiRedactions).toBe(1);
  });

  it('blocks remote learning ingestion unless explicitly enabled', () => {
    const disabled = new FederationManager({ enabled: true });
    const learning: SharedLearning = {
      id: 'learn-pii',
      schemaVersion: FEDERATION_LEARNING_SCHEMA_VERSION,
      agentId: 'remote',
      category: 'test',
      content: 'clean content',
      piiRedactions: 0,
      confidence: 0.5,
      learnedAt: new Date().toISOString(),
      sourcePeerId: 'peer-1',
    };

    expect(() => disabled.receiveLearning(learning)).toThrow(FederationSafetyError);
    expect(disabled.getStatus().metrics.lastBlockedReason).toBe('REMOTE_INGEST_DISABLED');
  });
});

describe('FederationManager.getStatus()', () => {
  it('returns preview-disabled with dryRun true by default', () => {
    const mgr = new FederationManager();
    const status = mgr.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.state).toBe('preview-disabled');
    expect(status.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(status.learningSchemaVersion).toBe(FEDERATION_LEARNING_SCHEMA_VERSION);
    expect(status.dryRun).toBe(true);
    expect(status.peerCount).toBe(0);
    expect(status.learningCount).toBe(0);
    expect(status.safety.operatorOptInRequired).toBe(true);
    expect(status.safety.outboundNetworkDisabled).toBe(true);
    expect(status.metrics.blockedOperations).toBe(0);
    expect(status.checkedAt).toBeTruthy();
  });

  it('reflects current peer and learning counts', () => {
    const mgr = new FederationManager({ enabled: true });
    mgr.registerPeer(makePeer('p1'));
    mgr.shareLearning({ agentId: 'a', category: 'c', content: 'x', confidence: 1, sourcePeerId: null });
    const status = mgr.getStatus();
    expect(status.state).toBe('dry-run-enabled');
    expect(status.peerCount).toBe(1);
    expect(status.learningCount).toBe(1);
    expect(status.metrics.peersRegistered).toBe(1);
    expect(status.metrics.learningsShared).toBe(1);
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

describe('Federation REST API', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4855, listen: false });
  });

  afterAll(() => server.app.close());

  it('GET /api/v5/federation/status returns preview status with safety metadata', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/federation/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enabled).toBe(false);
    expect(body.data.state).toBe('preview-disabled');
    expect(body.data.dryRun).toBe(true);
    expect(body.data.protocolVersion).toBe(FEDERATION_PROTOCOL_VERSION);
    expect(body.data.safety.operatorOptInRequired).toBe(true);
    expect(typeof body.data.peerCount).toBe('number');
  });

  it('GET /api/v5/federation/peers returns empty array initially', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/federation/peers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /api/v5/federation/peers blocks registration without operator opt-in', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/peers',
      payload: {
        id: 'peer-test-1',
        name: 'Test Peer',
        url: 'https://test.example.com',
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('FEDERATION_DISABLED');
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

  it('POST /api/v5/federation/share blocks sharing without operator opt-in', async () => {
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
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('FEDERATION_DISABLED');
  });

  it('POST /api/v5/federation/share returns 400 when required fields missing', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/share',
      payload: { agentId: 'coder' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v5/federation/share rejects invalid confidence before safety gating', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/federation/share',
      payload: {
        agentId: 'architect',
        category: 'design',
        content: 'SOLID principles apply here',
        confidence: 2,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_CONFIDENCE');
  });
});
