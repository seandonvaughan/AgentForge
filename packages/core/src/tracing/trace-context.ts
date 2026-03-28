import { generateId } from '@agentforge/shared';
import type { SpanContext } from './types.js';

/**
 * TraceContext — immutable value object representing trace propagation context.
 * Inspired by W3C TraceContext specification.
 */
export class TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;

  constructor(traceId: string, spanId: string, sampled = true) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.sampled = sampled;
  }

  /**
   * Create a brand new root trace context.
   */
  static create(sampled = true): TraceContext {
    return new TraceContext(generateId(), generateId(), sampled);
  }

  /**
   * Create a child context for a new span within the same trace.
   */
  child(): TraceContext {
    return new TraceContext(this.traceId, generateId(), this.sampled);
  }

  /**
   * Serialize to traceparent header format.
   * Format: 00|traceId|spanId|flags
   * Uses | as separator to avoid conflicts with IDs that contain hyphens.
   */
  toHeader(): string {
    const flags = this.sampled ? '01' : '00';
    return `00|${this.traceId}|${this.spanId}|${flags}`;
  }

  /**
   * Parse a traceparent header into a TraceContext.
   * Returns null if header is invalid.
   */
  static fromHeader(header: string): TraceContext | null {
    if (!header) return null;
    // Support both | separator (native format) and legacy - separator
    const sep = header.includes('|') ? '|' : '-';
    const parts = header.split(sep);
    if (parts.length < 4) return null;
    // For hyphen-separated IDs, traceId and spanId may themselves contain hyphens
    // so we need special parsing: version, flags are always at pos 0 and last
    const version = parts[0];
    const flags = parts[parts.length - 1];
    // Everything between version and flags is split into traceId and spanId
    // For | format: exactly [version, traceId, spanId, flags]
    // For - format: more complex, use simple [1] and [2] which works for non-compound IDs
    const traceId = parts[1];
    const spanId = parts[2];
    if (!traceId || !spanId) return null;
    return new TraceContext(traceId, spanId, flags === '01');
  }

  /**
   * Convert to plain SpanContext object.
   */
  toSpanContext(): SpanContext {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      sampled: this.sampled,
    };
  }

  /**
   * Inject context into a carrier object (e.g., HTTP headers).
   */
  inject(carrier: Record<string, string>): void {
    carrier['traceparent'] = this.toHeader();
  }

  /**
   * Extract context from a carrier object.
   */
  static extract(carrier: Record<string, string>): TraceContext | null {
    return TraceContext.fromHeader(carrier['traceparent'] ?? '');
  }
}
