import { TraceCollector } from './trace-collector.js';
import type { Span as SpanData, TraceRecord } from './types.js';

export interface TraceExporter {
  exportSpan(span: SpanData, trace: TraceRecord): Promise<void> | void;
}

interface OtlpHttpTraceExporterOptions {
  endpoint: string;
  serviceName: string;
  headers?: Record<string, string>;
}

/**
 * Minimal OTLP/HTTP trace exporter.
 * Enabled only when AGENTFORGE_OTEL_EXPORT_URL is set.
 */
class OtlpHttpTraceExporter implements TraceExporter {
  constructor(private readonly options: OtlpHttpTraceExporterOptions) {}

  async exportSpan(span: SpanData, trace: TraceRecord): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: this.options.serviceName },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'agentforge.trace-collector' },
              spans: [toOtlpSpan(span, trace)],
            },
          ],
        },
      ],
    };

    try {
      await fetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Export failures must not fail runtime execution paths.
    }
  }
}

const configuredExporter = buildExporterFromEnv();
const globalTraceCollector = new TraceCollector({
  serviceName: process.env['AGENTFORGE_TRACE_SERVICE_NAME'] ?? 'agentforge',
  maxTraces: 2_000,
  onSpanEnded: (span, trace) => {
    if (!configuredExporter) return;
    void configuredExporter.exportSpan(span.toData(), trace);
  },
});

export function getGlobalTraceCollector(): TraceCollector {
  return globalTraceCollector;
}

function buildExporterFromEnv(): TraceExporter | undefined {
  const endpoint = process.env['AGENTFORGE_OTEL_EXPORT_URL']?.trim();
  if (!endpoint) return undefined;
  const serviceName = process.env['AGENTFORGE_TRACE_SERVICE_NAME']?.trim() || 'agentforge';
  const headers = parseExporterHeaders(process.env['AGENTFORGE_OTEL_EXPORT_HEADERS']);
  return new OtlpHttpTraceExporter({ endpoint, serviceName, ...(headers ? { headers } : {}) });
}

function parseExporterHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toOtlpSpan(span: SpanData, trace: TraceRecord): Record<string, unknown> {
  return {
    traceId: normalizeOtelId(span.traceId, 32),
    spanId: normalizeOtelId(span.spanId, 16),
    ...(span.parentSpanId ? { parentSpanId: normalizeOtelId(span.parentSpanId, 16) } : {}),
    name: span.name,
    kind: mapSpanKind(span.kind),
    startTimeUnixNano: isoToUnixNano(span.startTime),
    endTimeUnixNano: isoToUnixNano(span.endTime ?? span.startTime),
    attributes: [
      ...toOtlpAttributes(span.attributes),
      { key: 'agentforge.trace.id', value: { stringValue: trace.traceId } },
    ],
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: isoToUnixNano(event.timestamp),
      attributes: toOtlpAttributes(event.attributes ?? {}),
    })),
    status: {
      code: mapStatusCode(span.status),
      ...(span.statusMessage ? { message: span.statusMessage } : {}),
    },
  };
}

function toOtlpAttributes(input: Record<string, unknown>): Array<{ key: string; value: Record<string, unknown> }> {
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(input)) {
    out.push({ key, value: toOtlpAnyValue(value) });
  }
  return out;
}

function toOtlpAnyValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (value === null || value === undefined) return { stringValue: '' };
  return { stringValue: JSON.stringify(value) };
}

function mapStatusCode(status: SpanData['status']): number {
  if (status === 'ok') return 1;
  if (status === 'error') return 2;
  return 0;
}

function mapSpanKind(kind: SpanData['kind']): number {
  switch (kind) {
    case 'server': return 2;
    case 'client': return 3;
    case 'producer': return 4;
    case 'consumer': return 5;
    default: return 1;
  }
}

function isoToUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  const nanos = Number.isFinite(ms) ? Math.trunc(ms * 1_000_000) : Date.now() * 1_000_000;
  return String(nanos);
}

function normalizeOtelId(raw: string, length: number): string {
  const hex = raw.toLowerCase().replace(/[^a-f0-9]/g, '');
  if (hex.length >= length) return hex.slice(0, length);
  return hex.padEnd(length, '0');
}
