import { promisify } from 'node:util';
import { gzip, gunzip, constants as zlibConstants } from 'node:zlib';

/**
 * Promisified wrappers use the callback form of zlib, which manages the
 * underlying Transform stream internally and releases C++ resources on
 * completion. This avoids the memory leak caused by manually created
 * `zlib.createGzip()` streams that were never `.destroy()`-ed.
 */
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Compression level: 1 = fastest, 9 = smallest. Default matches zlib's Z_DEFAULT_COMPRESSION. */
export type CompressionLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface CompressorOptions {
  /** zlib compression level. Default: Z_DEFAULT_COMPRESSION (6). */
  level?: CompressionLevel;
}

export interface CompressionStats {
  /** Number of compress() calls completed. */
  totalCompressed: number;
  /** Number of decompress() calls completed. */
  totalDecompressed: number;
  /** Total bytes fed into compress(). */
  totalInputBytes: number;
  /** Total compressed bytes produced by compress(). */
  totalOutputBytes: number;
}

/**
 * Compressor provides gzip compress/decompress helpers with proper resource
 * cleanup. It replaces a prior implementation that leaked memory on large
 * file uploads by holding live `zlib.createGzip()` streams without calling
 * `.destroy()` after use.
 *
 * Fix: use the promisified one-shot zlib API, which creates an internal
 * stream, flushes it, and frees native resources before resolving.
 */
export class Compressor {
  private readonly level: number;
  private stats: CompressionStats = {
    totalCompressed: 0,
    totalDecompressed: 0,
    totalInputBytes: 0,
    totalOutputBytes: 0,
  };

  constructor(options: CompressorOptions = {}) {
    this.level = options.level ?? zlibConstants.Z_DEFAULT_COMPRESSION;
  }

  /**
   * Gzip-compress a string or Buffer.
   * The underlying zlib stream is created, flushed, and destroyed within the
   * call — no handles are retained after the returned Promise resolves.
   */
  async compress(input: string | Buffer): Promise<Buffer> {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const compressed = await gzipAsync(buf, { level: this.level });

    this.stats.totalCompressed++;
    this.stats.totalInputBytes += buf.byteLength;
    this.stats.totalOutputBytes += compressed.byteLength;

    return compressed;
  }

  /**
   * Gzip-decompress a Buffer back to a UTF-8 string.
   * Same lifetime guarantee: no zlib stream outlives this call.
   */
  async decompress(input: Buffer): Promise<string> {
    const decompressed = await gunzipAsync(input);

    this.stats.totalDecompressed++;

    return decompressed.toString('utf8');
  }

  /** Return a snapshot of compression stats (copy, not a live reference). */
  getStats(): CompressionStats {
    return { ...this.stats };
  }

  /** Reset stats counters (useful between test runs). */
  resetStats(): void {
    this.stats = {
      totalCompressed: 0,
      totalDecompressed: 0,
      totalInputBytes: 0,
      totalOutputBytes: 0,
    };
  }
}
