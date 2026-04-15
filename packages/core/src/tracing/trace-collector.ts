import { TraceContext } from './trace-context.js';
import { Span } from './span.js';
import type { TraceRecord, StartSpanOptions, TraceQueryFilters } from './types.js';

/**
 * TraceCollector — creates spans, assembles complete traces, and stores them.
 * Lightweight native implementation of OTel concepts.
 */
export class TraceCollector {
  private spans = new Map<string, Span>(); // spanId -> Span
  private traces = new Map<string, TraceRecord>(); // traceId -> TraceRecord
  private readonly maxTraces: number;
  private readonly defaultServiceName: string;

  constructor(opts: { maxTraces?: number; serviceName?: string } = {}) {
    this.maxTraces = opts.maxTraces ?? 1000;
    this.defaultServiceName = opts.serviceName ?? 'agentforge';
  }

  // ── Span creation ────────────────────────────────────────────────────────────

  /**
   * Start a new root span (creates a new trace).
   */
  startRootSpan(opts: Omit<StartSpanOptions, 'parentContext'>): Span {
    const ctx = TraceContext.create();
    return this.createSpan({
      ...opts,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    });
  }

  /**
   * Start a child span within an existing trace.
   */
  startSpan(opts: StartSpanOptions): Span {
    if (opts.parentContext) {
      const childCtx = new TraceContext(
        opts.parentContext.traceId,
        opts.parentContext.spanId,
        opts.parentContext.sampled,
      ).child();

      return this.createSpan({
        ...opts,
        traceId: opts.parentContext.traceId,
        spanId: childCtx.spanId,
        parentSpanId: opts.parentContext.spanId,
      });
    }
    return this.startRootSpan(opts);
  }

  private createSpan(opts: StartSpanOptions & { traceId: string; spanId: string; parentSpanId?: string }): Span {
    const span = new Span(opts);
    this.spans.set(span.spanId, span);
    return span;
  }

  // ── Span completion ──────────────────────────────────────────────────────────

  /**
   * End a span and collect it into the trace record.
   */
  endSpan(span: Span): void {
    if (!span.isEnded) span.end();
    this.collectSpan(span);
  }

  private collectSpan(span: Span): void {
    const traceId = span.traceId;
    const existing = this.traces.get(traceId);

    if (existing) {
      existing.spans.push(span.toData());
      existing.spanCount = existing.spans.length;
      // Update trace status: if any span is error, trace is error
      if (span.status === 'error') existing.status = 'error';
      if (span.endTime && (!existing.endTime || span.endTime > existing.endTime)) {
        existing.endTime = span.endTime;
      }
      if (existing.startTime && existing.endTime) {
        existing.totalDurationMs = new Date(existing.endTime).getTime() - new Date(existing.startTime).getTime();
      }
    } else {
      // First span for this trace — create the record
      const record: TraceRecord = {
        traceId,
        rootSpanId: span.spanId,
        serviceName: (span.attributes['service.name'] as string) ?? this.defaultServiceName,
        spans: [span.toData()],
        startTime: span.startTime,
        status: span.status,
        spanCount: 1,
        ...(span.endTime ? { endTime: span.endTime } : {}),
        ...(span.durationMs !== undefined ? { totalDurationMs: span.durationMs } : {}),
      };
      this.traces.set(traceId, record);

      // Evict oldest trace if over limit
      if (this.traces.size > this.maxTraces) {
        const oldest = this.traces.keys().next().value;
        if (oldest) this.traces.delete(oldest);
      }
    }
  }

  // ── Query ────────────────────────────────────────────────────────────────────

  getTrace(traceId: string): TraceRecord | undefined {
    return this.traces.get(traceId);
  }

  listTraces(filters: TraceQueryFilters = {}): TraceRecord[] {
    let result = [...this.traces.values()];

    if (filters.serviceName) {
      result = result.filter(t => t.serviceName === filters.serviceName);
    }
    if (filters.status) {
      result = result.filter(t => t.status === filters.status);
    }
    if (filters.since) {
      result = result.filter(t => t.startTime >= filters.since!);
    }

    // Sort by startTime descending
    result.sort((a, b) => (b.startTime > a.startTime ? 1 : -1));

    const limit = filters.limit ?? 100;
    return result.slice(0, limit);
  }

  traceCount(): number {
    return this.traces.size;
  }

  spanCount(): number {
    return this.spans.size;
  }

  clear(): void {
    this.traces.clear();
    this.spans.clear();
  }

  // ── Convenience ──────────────────────────────────────────────────────────────

  /**
   * Run a function within a new span, automatically ending it.
   */
  async withSpan<T>(
    opts: StartSpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(opts);
    try {
      const result = await fn(span);
      span.setStatus('ok');
      return result;
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      else span.setStatus('error', String(err));
      throw err;
    } finally {
      this.endSpan(span);
    }
  }

  stats(): {
    traceCount: number;
    activeSpans: number;
    errorTraces: number;
    avgDurationMs: number;
  } {
    const traces = [...this.traces.values()];
    const errorTraces = traces.filter(t => t.status === 'error').length;
    const durations = traces.filter(t => t.totalDurationMs !== undefined).map(t => t.totalDurationMs!);
    const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const activeSpans = [...this.spans.values()].filter(s => !s.isEnded).length;

    return {
      traceCount: this.traces.size,
      activeSpans,
      errorTraces,
      avgDurationMs: Math.round(avgDurationMs * 100) / 100,
    };
  }
}
