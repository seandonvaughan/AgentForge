/**
 * Tests for Compressor — streaming/compressor.ts
 *
 * Verifies that the compression module correctly round-trips data and that
 * resource cleanup is implicit (no manual destroy() calls required by callers).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Compressor } from '../../packages/core/src/streaming/compressor.js';

describe('Compressor', () => {
  let compressor: Compressor;

  beforeEach(() => {
    compressor = new Compressor();
  });

  // ── Round-trip ──────────────────────────────────────────────────────────────

  it('round-trips a short string through compress → decompress', async () => {
    const original = 'Hello, AgentForge!';
    const compressed = await compressor.compress(original);
    const restored = await compressor.decompress(compressed);
    expect(restored).toBe(original);
  });

  it('round-trips an empty string without error', async () => {
    const compressed = await compressor.compress('');
    const restored = await compressor.decompress(compressed);
    expect(restored).toBe('');
  });

  it('round-trips a large payload (100 KB)', async () => {
    const large = 'x'.repeat(100_000);
    const compressed = await compressor.compress(large);
    const restored = await compressor.decompress(compressed);
    expect(restored).toBe(large);
  });

  it('accepts a Buffer as input to compress()', async () => {
    const buf = Buffer.from('buffer input', 'utf8');
    const compressed = await compressor.compress(buf);
    const restored = await compressor.decompress(compressed);
    expect(restored).toBe('buffer input');
  });

  // ── Compression effectiveness ───────────────────────────────────────────────

  it('produces output smaller than input for compressible data', async () => {
    const repetitive = 'abcdefgh'.repeat(1_000); // highly compressible
    const compressed = await compressor.compress(repetitive);
    expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(repetitive, 'utf8'));
  });

  it('compress() returns a Buffer', async () => {
    const result = await compressor.compress('test');
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  // ── Stats tracking ──────────────────────────────────────────────────────────

  it('tracks totalCompressed after each compress() call', async () => {
    await compressor.compress('a');
    await compressor.compress('b');
    expect(compressor.getStats().totalCompressed).toBe(2);
  });

  it('tracks totalDecompressed after each decompress() call', async () => {
    const c = await compressor.compress('hello');
    await compressor.decompress(c);
    await compressor.decompress(c);
    expect(compressor.getStats().totalDecompressed).toBe(2);
  });

  it('totalInputBytes reflects bytes fed into compress()', async () => {
    const str = 'hello';
    await compressor.compress(str);
    expect(compressor.getStats().totalInputBytes).toBe(Buffer.byteLength(str, 'utf8'));
  });

  it('totalOutputBytes is greater than 0 after compress()', async () => {
    await compressor.compress('some content');
    expect(compressor.getStats().totalOutputBytes).toBeGreaterThan(0);
  });

  it('getStats() returns a snapshot — mutations do not affect internal state', async () => {
    await compressor.compress('x');
    const snap = compressor.getStats();
    (snap as Record<string, unknown>)['totalCompressed'] = 9999;
    expect(compressor.getStats().totalCompressed).toBe(1);
  });

  it('resetStats() zeroes all counters', async () => {
    await compressor.compress('data');
    compressor.resetStats();
    const stats = compressor.getStats();
    expect(stats.totalCompressed).toBe(0);
    expect(stats.totalDecompressed).toBe(0);
    expect(stats.totalInputBytes).toBe(0);
    expect(stats.totalOutputBytes).toBe(0);
  });

  // ── Custom compression level ────────────────────────────────────────────────

  it('respects a custom compression level option', async () => {
    const fast = new Compressor({ level: 1 });
    const compressed = await fast.compress('compress this string at level 1');
    const restored = await fast.decompress(compressed);
    expect(restored).toBe('compress this string at level 1');
  });

  // ── Concurrency / resource cleanup ─────────────────────────────────────────

  it('handles many concurrent compress calls without error (resource cleanup)', async () => {
    const payload = 'concurrent payload data';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => compressor.compress(payload)),
    );
    // All should produce valid compressed buffers that round-trip correctly
    for (const compressed of results) {
      const restored = await compressor.decompress(compressed);
      expect(restored).toBe(payload);
    }
  });
});
