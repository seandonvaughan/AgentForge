import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@xenova/transformers');
});

describe('encoder pipeline initialization', () => {
  it('shares one transformer initialization across concurrent encode calls', async () => {
    let createCalls = 0;
    let runCalls = 0;

    vi.doMock('@xenova/transformers', () => ({
      pipeline: vi.fn(async () => {
        createCalls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return async (input: string | string[]) => {
          const inputs = Array.isArray(input) ? input : [input];
          runCalls += inputs.length;
          return inputs.map(() => ({ data: new Float32Array(384) }));
        };
      }),
    }));

    const { encode } = await import('../encoder.js');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => encode(`document ${i}`)),
    );

    expect(createCalls).toBe(1);
    expect(runCalls).toBe(20);
  });
});
