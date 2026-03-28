import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventStream, StreamEvent, globalStream } from '../../packages/server/src/routes/v5/stream.js';
import { createServerV5 } from '../../packages/server/src/server.js';

// ── Unit tests: EventStream class ──────────────────────────────────────────────

describe('EventStream', () => {
  it('subscribe() registers a handler and emit() calls it', () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    stream.subscribe('c1', (e) => received.push(e));

    stream.emit({ type: 'system', category: 'test', message: 'hello' });

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('hello');
    expect(received[0].type).toBe('system');
  });

  it('emit() assigns an id and timestamp', () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    stream.subscribe('c1', (e) => received.push(e));

    stream.emit({ type: 'agent_activity', category: 'coder', message: 'task started' });

    expect(received[0].id).toBeTruthy();
    expect(received[0].timestamp).toBeTruthy();
    // Should be a valid ISO timestamp
    expect(() => new Date(received[0].timestamp)).not.toThrow();
    expect(new Date(received[0].timestamp).getTime()).toBeGreaterThan(0);
  });

  it('clientCount() returns the correct number of subscribed clients', () => {
    const stream = new EventStream();
    expect(stream.clientCount()).toBe(0);

    stream.subscribe('c1', () => {});
    expect(stream.clientCount()).toBe(1);

    stream.subscribe('c2', () => {});
    expect(stream.clientCount()).toBe(2);
  });

  it('unsubscribe (returned cleanup fn) removes the client', () => {
    const stream = new EventStream();
    const unsub = stream.subscribe('c1', () => {});
    expect(stream.clientCount()).toBe(1);

    unsub();
    expect(stream.clientCount()).toBe(0);
  });

  it('after unsubscribe, handler is NOT called on emit', () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];
    const unsub = stream.subscribe('c1', (e) => received.push(e));

    stream.emit({ type: 'system', category: 'test', message: 'before unsub' });
    unsub();
    stream.emit({ type: 'system', category: 'test', message: 'after unsub' });

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('before unsub');
  });

  it('multiple clients all receive the same event', () => {
    const stream = new EventStream();
    const results: Record<string, StreamEvent[]> = { c1: [], c2: [], c3: [] };

    stream.subscribe('c1', (e) => results.c1.push(e));
    stream.subscribe('c2', (e) => results.c2.push(e));
    stream.subscribe('c3', (e) => results.c3.push(e));

    stream.emit({ type: 'sprint_event', category: 'sprint', message: 'sprint started' });

    expect(results.c1).toHaveLength(1);
    expect(results.c2).toHaveLength(1);
    expect(results.c3).toHaveLength(1);

    // All received the same message
    expect(results.c1[0].message).toBe('sprint started');
    expect(results.c2[0].message).toBe('sprint started');
    expect(results.c3[0].message).toBe('sprint started');

    // All have the same id (broadcast)
    expect(results.c1[0].id).toBe(results.c2[0].id);
    expect(results.c2[0].id).toBe(results.c3[0].id);
  });

  it('a throwing handler does not prevent other clients from receiving the event', () => {
    const stream = new EventStream();
    const received: StreamEvent[] = [];

    stream.subscribe('bad', () => { throw new Error('boom'); });
    stream.subscribe('good', (e) => received.push(e));

    expect(() =>
      stream.emit({ type: 'system', category: 'test', message: 'resilient' })
    ).not.toThrow();

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('resilient');
  });
});

// ── StreamEvent shape test ─────────────────────────────────────────────────────

describe('StreamEvent shape', () => {
  it('has all required fields after emit', () => {
    const stream = new EventStream();
    let captured: StreamEvent | null = null;
    stream.subscribe('shape-check', (e) => { captured = e; });

    stream.emit({
      type: 'cost_event',
      category: 'budget',
      message: 'budget threshold reached',
      data: { threshold: 100, spent: 110 },
    });

    expect(captured).not.toBeNull();
    const e = captured as unknown as StreamEvent;
    expect(typeof e.id).toBe('string');
    expect(typeof e.timestamp).toBe('string');
    expect(e.type).toBe('cost_event');
    expect(e.category).toBe('budget');
    expect(e.message).toBe('budget threshold reached');
    expect(e.data).toEqual({ threshold: 100, spent: 110 });
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

describe('POST /api/v5/stream/emit', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4791, listen: false });
  });

  afterAll(() => server.app.close());

  it('returns 400 when message is missing', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/stream/emit',
      payload: { type: 'system', category: 'test' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/message/i);
  });

  it('returns 201 when message is provided', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/stream/emit',
      payload: { type: 'system', category: 'test', message: 'test event' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('delivers the event to subscribed clients when emitted via POST', async () => {
    const received: StreamEvent[] = [];
    // Subscribe directly to the globalStream singleton the route uses
    const unsub = globalStream.subscribe('test-http-client', (e) => received.push(e));

    await server.app.inject({
      method: 'POST',
      url: '/api/v5/stream/emit',
      payload: { type: 'workflow_event', category: 'orchestrator', message: 'workflow finished' },
    });

    unsub();
    expect(received.some((e) => e.message === 'workflow finished')).toBe(true);
  });
});

describe('POST /api/v5/dashboard/refresh-signal', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4792, listen: false });
  });

  afterAll(() => server.app.close());

  it('returns 200 with ok: true', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/dashboard/refresh-signal',
      payload: { reason: 'sprint completed' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('emits a refresh_signal type event to clients', async () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-refresh-client', (e) => received.push(e));

    await server.app.inject({
      method: 'POST',
      url: '/api/v5/dashboard/refresh-signal',
      payload: { reason: 'new agent deployed' },
    });

    unsub();

    const signalEvents = received.filter((e) => e.type === 'refresh_signal');
    expect(signalEvents.length).toBeGreaterThan(0);
    expect(signalEvents[0].message).toContain('new agent deployed');
  });

  it('uses default message when reason is omitted', async () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-refresh-default', (e) => received.push(e));

    await server.app.inject({
      method: 'POST',
      url: '/api/v5/dashboard/refresh-signal',
      payload: {},
    });

    unsub();

    const signalEvents = received.filter((e) => e.type === 'refresh_signal');
    expect(signalEvents.length).toBeGreaterThan(0);
    expect(signalEvents[0].message).toBeTruthy();
  });
});

describe('GET /api/v5/stream/status', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4793, listen: false });
  });

  afterAll(() => server.app.close());

  it('returns connectedClients count and timestamp', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v5/stream/status',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.data.connectedClients).toBe('number');
    expect(typeof body.data.timestamp).toBe('string');
  });
});
