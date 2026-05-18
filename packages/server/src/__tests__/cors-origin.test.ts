/**
 * Unit tests for the shared localhost CORS origin checker.
 *
 * Replaces the per-route regex pattern (`/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`)
 * with equivalent coverage over the string-based isLocalhostCorsOrigin() helper.
 */

import { describe, it, expect } from 'vitest';
import {
  isLocalhostCorsOrigin,
  sseCorsOrigin,
  SSE_CORS_FALLBACK,
} from '../lib/cors-origin.js';

// 28 tests total across isLocalhostCorsOrigin and sseCorsOrigin suites.

describe('isLocalhostCorsOrigin', () => {
  // ── valid localhost origins ────────────────────────────────────────────────

  it('accepts http://localhost', () => {
    expect(isLocalhostCorsOrigin('http://localhost')).toBe(true);
  });

  it('accepts http://localhost:4751', () => {
    expect(isLocalhostCorsOrigin('http://localhost:4751')).toBe(true);
  });

  it('accepts http://localhost:4752 (second dev port)', () => {
    expect(isLocalhostCorsOrigin('http://localhost:4752')).toBe(true);
  });

  it('accepts http://localhost:4750 (API port)', () => {
    expect(isLocalhostCorsOrigin('http://localhost:4750')).toBe(true);
  });

  it('accepts http://127.0.0.1', () => {
    expect(isLocalhostCorsOrigin('http://127.0.0.1')).toBe(true);
  });

  it('accepts http://127.0.0.1:4751', () => {
    expect(isLocalhostCorsOrigin('http://127.0.0.1:4751')).toBe(true);
  });

  it('accepts http://127.0.0.1:4750', () => {
    expect(isLocalhostCorsOrigin('http://127.0.0.1:4750')).toBe(true);
  });

  // ── rejected: https scheme ─────────────────────────────────────────────────

  it('rejects https://localhost:4751 (HTTPS — server is HTTP-only)', () => {
    expect(isLocalhostCorsOrigin('https://localhost:4751')).toBe(false);
  });

  it('rejects https://127.0.0.1:4751', () => {
    expect(isLocalhostCorsOrigin('https://127.0.0.1:4751')).toBe(false);
  });

  it('rejects https://localhost', () => {
    expect(isLocalhostCorsOrigin('https://localhost')).toBe(false);
  });

  // ── rejected: external origins ────────────────────────────────────────────

  it('rejects http://evil.com', () => {
    expect(isLocalhostCorsOrigin('http://evil.com')).toBe(false);
  });

  it('rejects http://evil.com:4751', () => {
    expect(isLocalhostCorsOrigin('http://evil.com:4751')).toBe(false);
  });

  it('rejects http://evil.com:4751 with path', () => {
    expect(isLocalhostCorsOrigin('http://evil.com:4751/path')).toBe(false);
  });

  // ── rejected: subdomain tricks ────────────────────────────────────────────

  it('rejects http://localhost.evil.com', () => {
    // The afterHost check sees ".evil.com", which starts with '.' not ':'
    expect(isLocalhostCorsOrigin('http://localhost.evil.com')).toBe(false);
  });

  it('rejects http://localhost.evil.com:4751', () => {
    expect(isLocalhostCorsOrigin('http://localhost.evil.com:4751')).toBe(false);
  });

  it('rejects http://127.0.0.1.evil.com', () => {
    expect(isLocalhostCorsOrigin('http://127.0.0.1.evil.com')).toBe(false);
  });

  // ── rejected: path or query after hostname ────────────────────────────────

  it('rejects http://localhost/path (bare path without port)', () => {
    // afterHost is '/path' which does not start with ':' or equal ''
    expect(isLocalhostCorsOrigin('http://localhost/path')).toBe(false);
  });

  it('rejects http://localhost?query (bare query without port)', () => {
    expect(isLocalhostCorsOrigin('http://localhost?query')).toBe(false);
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it('rejects empty string', () => {
    expect(isLocalhostCorsOrigin('')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isLocalhostCorsOrigin(undefined)).toBe(false);
  });

  it('rejects wildcard *', () => {
    expect(isLocalhostCorsOrigin('*')).toBe(false);
  });
});

describe('sseCorsOrigin', () => {
  it('reflects a valid localhost origin back', () => {
    expect(sseCorsOrigin('http://localhost:4751')).toBe('http://localhost:4751');
  });

  it('reflects a valid 127.0.0.1 origin back', () => {
    expect(sseCorsOrigin('http://127.0.0.1:4751')).toBe('http://127.0.0.1:4751');
  });

  it('falls back to SSE_CORS_FALLBACK for an external origin', () => {
    expect(sseCorsOrigin('http://evil.com')).toBe(SSE_CORS_FALLBACK);
  });

  it('falls back to SSE_CORS_FALLBACK when origin is undefined', () => {
    expect(sseCorsOrigin(undefined)).toBe(SSE_CORS_FALLBACK);
  });

  it('falls back to SSE_CORS_FALLBACK for https://localhost', () => {
    expect(sseCorsOrigin('https://localhost:4751')).toBe(SSE_CORS_FALLBACK);
  });

  it('handles an array origin by using the first element', () => {
    expect(sseCorsOrigin(['http://localhost:4751'])).toBe('http://localhost:4751');
  });

  it('falls back when array is empty (undefined first element)', () => {
    // Array.isArray([]) → true; [0] → undefined → isLocalhostCorsOrigin(undefined) → false
    expect(sseCorsOrigin([])).toBe(SSE_CORS_FALLBACK);
  });
});
