/** OpenTelemetry-inspired Distributed Tracing types (native implementation) */

export type SpanStatus = 'unset' | 'ok' | 'error';
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface SpanContext {
  traceId: string;
  spanId: string;
  /** Whether this trace should be sampled/exported */
  sampled: boolean;
}

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

export interface SpanLink {
  context: SpanContext;
  attributes?: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  statusMessage?: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  links: SpanLink[];
}

export interface TraceRecord {
  traceId: string;
  rootSpanId: string;
  serviceName: string;
  spans: Span[];
  startTime: string;
  endTime?: string;
  totalDurationMs?: number;
  status: SpanStatus;
  spanCount: number;
}

export interface StartSpanOptions {
  name: string;
  kind?: SpanKind;
  parentContext?: SpanContext;
  attributes?: Record<string, unknown>;
  serviceName?: string;
}

export interface TraceQueryFilters {
  serviceName?: string;
  status?: SpanStatus;
  since?: string;
  limit?: number;
}
