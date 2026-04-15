import { generateId, nowIso } from '@agentforge/shared';
import { TraceContext } from './trace-context.js';
import type { Span as SpanData, SpanKind, SpanStatus, SpanEvent, SpanLink, SpanContext, StartSpanOptions } from './types.js';

/**
 * Span — represents a single unit of work within a distributed trace.
 * Mutable during its lifetime, sealed after end() is called.
 */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: SpanKind;
  private _status: SpanStatus = 'unset';
  private _statusMessage: string | undefined;
  readonly startTime: string;
  private _endTime: string | undefined;
  private _durationMs: number | undefined;
  private _attributes: Record<string, unknown>;
  private _events: SpanEvent[] = [];
  private _links: SpanLink[] = [];
  private _ended = false;

  constructor(opts: StartSpanOptions & { traceId: string; spanId: string; parentSpanId?: string }) {
    this.traceId = opts.traceId;
    this.spanId = opts.spanId;
    this.parentSpanId = opts.parentSpanId;
    this.name = opts.name;
    this.kind = opts.kind ?? 'internal';
    this._attributes = opts.attributes ?? {};
    this.startTime = nowIso();
  }

  // ── Mutation ─────────────────────────────────────────────────────────────────

  setAttribute(key: string, value: unknown): this {
    if (!this._ended) this._attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, unknown>): this {
    if (!this._ended) Object.assign(this._attributes, attrs);
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    if (!this._ended) {
      this._status = status;
      this._statusMessage = message;
    }
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    if (!this._ended) {
      this._events.push({
        name,
        timestamp: nowIso(),
        ...(attributes ? { attributes } : {}),
      });
    }
    return this;
  }

  addLink(context: SpanContext, attributes?: Record<string, unknown>): this {
    if (!this._ended) {
      this._links.push({
        context,
        ...(attributes ? { attributes } : {}),
      });
    }
    return this;
  }

  recordException(error: Error): this {
    this.addEvent('exception', {
      'exception.type': error.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack,
    });
    this.setStatus('error', error.message);
    return this;
  }

  /**
   * End the span, computing duration.
   */
  end(): this {
    if (!this._ended) {
      this._endTime = nowIso();
      const startMs = new Date(this.startTime).getTime();
      const endMs = new Date(this._endTime).getTime();
      this._durationMs = Math.max(0, endMs - startMs);
      if (this._status === 'unset') this._status = 'ok';
      this._ended = true;
    }
    return this;
  }

  get isEnded(): boolean {
    return this._ended;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────

  get status(): SpanStatus { return this._status; }
  get statusMessage(): string | undefined { return this._statusMessage; }
  get endTime(): string | undefined { return this._endTime; }
  get durationMs(): number | undefined { return this._durationMs; }
  get attributes(): Record<string, unknown> { return { ...this._attributes }; }
  get events(): SpanEvent[] { return [...this._events]; }
  get links(): SpanLink[] { return [...this._links]; }

  /**
   * Get the trace context for this span (for child span propagation).
   */
  context(): TraceContext {
    return new TraceContext(this.traceId, this.spanId, true);
  }

  /**
   * Serialize to a plain SpanData object.
   */
  toData(): SpanData {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: this.kind,
      status: this._status,
      startTime: this.startTime,
      ...(this._statusMessage ? { statusMessage: this._statusMessage } : {}),
      ...(this._endTime ? { endTime: this._endTime } : {}),
      ...(this._durationMs !== undefined ? { durationMs: this._durationMs } : {}),
      attributes: { ...this._attributes },
      events: [...this._events],
      links: [...this._links],
    };
  }
}
