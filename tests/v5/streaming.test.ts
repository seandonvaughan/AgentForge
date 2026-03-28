import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ResponseStreamer, StreamingExecutor, StreamChunk } from '../../packages/core/src/streaming/index.js';
import { createServerV5 } from '../../packages/server/src/server.js';

// ── Unit tests: ResponseStreamer ───────────────────────────────────────────────

describe('ResponseStreamer', () => {
  const streamer = new ResponseStreamer();

  it('streams content in chunks of the specified size', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream('Hello World!!', { chunkSize: 5 })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(3); // "Hello", " Worl", "d!!"
    expect(chunks[0].content).toBe('Hello');
    expect(chunks[1].content).toBe(' Worl');
    expect(chunks[2].content).toBe('d!!');
  });

  it('marks only the last chunk as done: true', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream('ABCDE', { chunkSize: 2 })) {
      chunks.push(chunk);
    }
    const notDone = chunks.slice(0, -1);
    const last = chunks[chunks.length - 1];
    expect(notDone.every((c) => c.done === false)).toBe(true);
    expect(last.done).toBe(true);
  });

  it('assigns sequential 0-based index to each chunk', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream('0123456789', { chunkSize: 3 })) {
      chunks.push(chunk);
    }
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('each chunk has a valid ISO timestamp', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream('test', { chunkSize: 2 })) {
      chunks.push(chunk);
    }
    for (const c of chunks) {
      expect(() => new Date(c.timestamp)).not.toThrow();
      expect(new Date(c.timestamp).getTime()).toBeGreaterThan(0);
    }
  });

  it('handles empty string by yielding one done chunk', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream('', {})) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('');
    expect(chunks[0].done).toBe(true);
    expect(chunks[0].index).toBe(0);
  });

  it('uses default chunkSize of 20 when config is omitted', async () => {
    const content = 'A'.repeat(50);
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream(content)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(3); // ceil(50/20) = 3
  });

  it('streams single character content as one chunk', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream('X', { chunkSize: 20 })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('X');
    expect(chunks[0].done).toBe(true);
  });

  it('reassembles original content from all chunks', async () => {
    const original = 'The quick brown fox jumps over the lazy dog';
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamer.stream(original, { chunkSize: 7 })) {
      chunks.push(chunk);
    }
    const reassembled = chunks.map((c) => c.content).join('');
    expect(reassembled).toBe(original);
  });

  it('toSSE() formats a chunk as SSE data line', () => {
    const chunk: StreamChunk = {
      index: 0,
      content: 'hello',
      done: false,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = streamer.toSSE(chunk);
    expect(sse).toMatch(/^data: /);
    expect(sse).toMatch(/\n\n$/);
    const parsed = JSON.parse(sse.slice(6).trim());
    expect(parsed.content).toBe('hello');
    expect(parsed.index).toBe(0);
    expect(parsed.done).toBe(false);
  });

  it('toSSE() marks done chunk correctly', () => {
    const chunk: StreamChunk = { index: 2, content: 'end', done: true, timestamp: new Date().toISOString() };
    const sse = streamer.toSSE(chunk);
    const parsed = JSON.parse(sse.slice(6).trim());
    expect(parsed.done).toBe(true);
  });
});

// ── Unit tests: StreamingExecutor ─────────────────────────────────────────────

describe('StreamingExecutor', () => {
  const executor = new StreamingExecutor();

  it('calls onChunk for every chunk of the executor output', async () => {
    const chunks: StreamChunk[] = [];
    await executor.execute(
      'run task',
      (c) => chunks.push(c),
      async () => 'Result: done',
    );
    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.map((c) => c.content).join('');
    expect(text).toBe('Result: done');
  });

  it('returns the full response string', async () => {
    const result = await executor.execute(
      'sum',
      () => {},
      async () => '42',
    );
    expect(result).toBe('42');
  });

  it('uses default executor when none provided', async () => {
    const result = await executor.execute('hello', () => {});
    expect(result).toBe('Executed: hello');
  });

  it('last chunk from executor stream has done: true', async () => {
    const chunks: StreamChunk[] = [];
    await executor.execute('task', (c) => chunks.push(c), async () => 'some output');
    const last = chunks[chunks.length - 1];
    expect(last.done).toBe(true);
  });

  it('first chunk from executor stream has index: 0', async () => {
    const chunks: StreamChunk[] = [];
    await executor.execute('task', (c) => chunks.push(c), async () => 'output text here');
    expect(chunks[0].index).toBe(0);
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

describe('GET /api/v5/stream/response/:taskId/info', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4851, listen: false });
  });

  afterAll(() => server.app.close());

  it('returns taskId, contentLength, and estimatedChunks', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v5/stream/response/default/info',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.taskId).toBe('default');
    expect(typeof body.data.contentLength).toBe('number');
    expect(body.data.contentLength).toBeGreaterThan(0);
    expect(typeof body.data.estimatedChunks).toBe('number');
  });

  it('returns estimatedChunks > 1 for long tasks', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v5/stream/response/unknown-task/info',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Falls back to default content which is long
    expect(body.data.estimatedChunks).toBeGreaterThan(1);
  });
});
