import { describe, it, expect, beforeEach } from 'vitest';
import {
  TraceContext,
  Span,
  TraceCollector,
} from '../../packages/core/src/tracing/index.js';

describe('TraceContext', () => {
  it('creates a new root context with unique IDs', () => {
    const ctx1 = TraceContext.create();
    const ctx2 = TraceContext.create();
    expect(ctx1.traceId).toBeTruthy();
    expect(ctx1.spanId).toBeTruthy();
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
    expect(ctx1.sampled).toBe(true);
  });

  it('creates child context with same traceId but new spanId', () => {
    const parent = TraceContext.create();
    const child = parent.child();
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it('serializes to traceparent header format', () => {
    const ctx = new TraceContext('trace123', 'span456', true);
    const header = ctx.toHeader();
    expect(header).toBe('00|trace123|span456|01');
  });

  it('serializes unsampled context', () => {
    const ctx = new TraceContext('trace123', 'span456', false);
    const header = ctx.toHeader();
    expect(header).toContain('|00');
  });

  it('parses traceparent header', () => {
    const ctx = TraceContext.fromHeader('00|trace123|span456|01');
    expect(ctx).not.toBeNull();
    expect(ctx?.traceId).toBe('trace123');
    expect(ctx?.spanId).toBe('span456');
    expect(ctx?.sampled).toBe(true);
  });

  it('returns null for invalid header', () => {
    expect(TraceContext.fromHeader('')).toBeNull();
    expect(TraceContext.fromHeader('invalid')).toBeNull();
    expect(TraceContext.fromHeader('00-only-two')).toBeNull();
  });

  it('converts to SpanContext', () => {
    const ctx = TraceContext.create();
    const spanCtx = ctx.toSpanContext();
    expect(spanCtx.traceId).toBe(ctx.traceId);
    expect(spanCtx.spanId).toBe(ctx.spanId);
    expect(spanCtx.sampled).toBe(ctx.sampled);
  });

  it('injects into carrier', () => {
    const ctx = TraceContext.create();
    const carrier: Record<string, string> = {};
    ctx.inject(carrier);
    expect(carrier['traceparent']).toBeTruthy();
    expect(carrier['traceparent']).toContain(ctx.traceId);
  });

  it('extracts from carrier', () => {
    const ctx = TraceContext.create();
    const carrier: Record<string, string> = {};
    ctx.inject(carrier);
    const extracted = TraceContext.extract(carrier);
    expect(extracted?.traceId).toBe(ctx.traceId);
    expect(extracted?.spanId).toBe(ctx.spanId);
  });

  it('returns null when extracting from empty carrier', () => {
    expect(TraceContext.extract({})).toBeNull();
  });
});

describe('Span', () => {
  it('creates a span with default kind', () => {
    const span = new Span({ name: 'test-span', traceId: 'trace1', spanId: 'span1' });
    expect(span.name).toBe('test-span');
    expect(span.kind).toBe('internal');
    expect(span.status).toBe('unset');
    expect(span.isEnded).toBe(false);
  });

  it('sets attributes', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.setAttribute('key', 'value');
    expect(span.attributes['key']).toBe('value');
  });

  it('sets multiple attributes at once', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.setAttributes({ a: 1, b: 'hello' });
    expect(span.attributes['a']).toBe(1);
    expect(span.attributes['b']).toBe('hello');
  });

  it('sets status', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.setStatus('error', 'Something went wrong');
    expect(span.status).toBe('error');
    expect(span.statusMessage).toBe('Something went wrong');
  });

  it('adds events', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.addEvent('db.query', { sql: 'SELECT *' });
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe('db.query');
  });

  it('records exception', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.recordException(new Error('Something failed'));
    expect(span.status).toBe('error');
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe('exception');
  });

  it('ends the span and sets duration', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.end();
    expect(span.isEnded).toBe(true);
    expect(span.endTime).toBeTruthy();
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sets status to ok on end if unset', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.end();
    expect(span.status).toBe('ok');
  });

  it('does not mutate ended span', () => {
    const span = new Span({ name: 'test', traceId: 't1', spanId: 's1' });
    span.end();
    span.setAttribute('after-end', true);
    expect(span.attributes['after-end']).toBeUndefined();
    span.addEvent('after-end-event');
    expect(span.events).toHaveLength(0);
  });

  it('serializes to SpanData', () => {
    const span = new Span({ name: 'ops', traceId: 't1', spanId: 's1', attributes: { op: 'read' } });
    span.end();
    const data = span.toData();
    expect(data.name).toBe('ops');
    expect(data.traceId).toBe('t1');
    expect(data.attributes['op']).toBe('read');
    expect(data.endTime).toBeTruthy();
  });

  it('returns child trace context', () => {
    const span = new Span({ name: 'parent', traceId: 'trace1', spanId: 'span1' });
    const childCtx = span.context().child();
    expect(childCtx.traceId).toBe('trace1');
    expect(childCtx.spanId).not.toBe('span1');
  });
});

describe('TraceCollector', () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector({ serviceName: 'test-service' });
  });

  it('starts and ends a root span', () => {
    const span = collector.startRootSpan({ name: 'root-op' });
    expect(span.traceId).toBeTruthy();
    expect(span.parentSpanId).toBeUndefined();
    collector.endSpan(span);
    const trace = collector.getTrace(span.traceId);
    expect(trace).toBeTruthy();
    expect(trace?.spans).toHaveLength(1);
  });

  it('starts child span in same trace', () => {
    const root = collector.startRootSpan({ name: 'root' });
    const child = collector.startSpan({
      name: 'child',
      parentContext: root.context().toSpanContext(),
    });
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
  });

  it('assembles full trace from multiple spans', () => {
    const root = collector.startRootSpan({ name: 'request' });
    const child1 = collector.startSpan({ name: 'db', parentContext: root.context().toSpanContext() });
    const child2 = collector.startSpan({ name: 'cache', parentContext: root.context().toSpanContext() });
    collector.endSpan(child2);
    collector.endSpan(child1);
    collector.endSpan(root);

    const trace = collector.getTrace(root.traceId)!;
    expect(trace.spans).toHaveLength(3);
    expect(trace.spanCount).toBe(3);
  });

  it('marks trace as error when a span errors', () => {
    const root = collector.startRootSpan({ name: 'request' });
    root.setStatus('error', 'Upstream failed');
    collector.endSpan(root);

    const trace = collector.getTrace(root.traceId)!;
    expect(trace.status).toBe('error');
  });

  it('lists traces', () => {
    const r1 = collector.startRootSpan({ name: 'req-1' });
    collector.endSpan(r1);
    const r2 = collector.startRootSpan({ name: 'req-2' });
    collector.endSpan(r2);

    expect(collector.listTraces()).toHaveLength(2);
    expect(collector.traceCount()).toBe(2);
  });

  it('filters traces by status', () => {
    const ok = collector.startRootSpan({ name: 'ok-req' });
    ok.setStatus('ok');
    collector.endSpan(ok);

    const err = collector.startRootSpan({ name: 'err-req' });
    err.setStatus('error');
    collector.endSpan(err);

    const errors = collector.listTraces({ status: 'error' });
    expect(errors).toHaveLength(1);
  });

  it('returns undefined for unknown trace', () => {
    expect(collector.getTrace('nonexistent')).toBeUndefined();
  });

  it('withSpan convenience method completes span', async () => {
    let capturedSpan: Span | null = null;
    const result = await collector.withSpan({ name: 'auto-span' }, async (span) => {
      capturedSpan = span;
      return 'done';
    });
    expect(result).toBe('done');
    expect(capturedSpan!.isEnded).toBe(true);
    expect(capturedSpan!.status).toBe('ok');
  });

  it('withSpan records exceptions on failure', async () => {
    let capturedSpan: Span | null = null;
    await expect(
      collector.withSpan({ name: 'failing-span' }, async (span) => {
        capturedSpan = span;
        throw new Error('Boom!');
      })
    ).rejects.toThrow('Boom!');
    expect(capturedSpan!.status).toBe('error');
  });

  it('computes stats', () => {
    const r = collector.startRootSpan({ name: 'r' });
    collector.endSpan(r);
    const stats = collector.stats();
    expect(stats.traceCount).toBe(1);
    expect(stats.activeSpans).toBeGreaterThanOrEqual(0);
  });

  it('clears all state', () => {
    const r = collector.startRootSpan({ name: 'r' });
    collector.endSpan(r);
    collector.clear();
    expect(collector.traceCount()).toBe(0);
  });
});
