import type { StreamChunk, StreamConfig } from './types.js';

const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_DELAY_MS = 0;

/**
 * ResponseStreamer wraps a response string and emits it in chunks via an
 * async iterator. Supports configurable chunk size and optional delay.
 */
export class ResponseStreamer {
  /**
   * Stream a content string as an async iterable of StreamChunks.
   */
  async *stream(content: string, config: StreamConfig = {}): AsyncIterable<StreamChunk> {
    const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const delayMs = config.delayMs ?? DEFAULT_DELAY_MS;
    const totalChunks = Math.ceil(content.length / chunkSize) || 1;

    let index = 0;

    if (content.length === 0) {
      yield {
        index: 0,
        content: '',
        done: true,
        timestamp: new Date().toISOString(),
      };
      return;
    }

    for (let offset = 0; offset < content.length; offset += chunkSize) {
      const slice = content.slice(offset, offset + chunkSize);
      const done = offset + chunkSize >= content.length;

      yield {
        index,
        content: slice,
        done,
        timestamp: new Date().toISOString(),
      };

      index++;

      if (!done && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Format a StreamChunk as an SSE (Server-Sent Events) string.
   */
  toSSE(chunk: StreamChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
}
