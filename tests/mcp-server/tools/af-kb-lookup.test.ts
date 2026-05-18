/**
 * Tests for af_kb_lookup tool.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { afKbLookup } from '../../../packages/mcp-server/src/tools/af-kb-lookup.js';

// We mock the global fetch — the tool uses HTTP loopback calls.
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as Response);
}

describe('afKbLookup', () => {
  it('fetches KB metadata when only kb_id is provided', async () => {
    mockFetch(200, { slug: 'engineering-docs', title: 'Engineering Docs', description: 'Internal docs' });

    const result = await afKbLookup({ kb_id: 'engineering-docs' }, 'http://localhost:4751');

    expect(result.ok).toBe(true);
    expect(result.data?.kbId).toBe('engineering-docs');
    expect(result.data?.body).toContain('Engineering Docs');
  });

  it('fetches a doc by kb_id and doc_id', async () => {
    mockFetch(200, {
      slug: 'readme',
      body: { version: 3, bodyMd: '# Hello World' },
    });

    const result = await afKbLookup(
      { kb_id: 'engineering-docs', doc_id: 'readme' },
      'http://localhost:4751',
    );

    expect(result.ok).toBe(true);
    expect(result.data?.docId).toBe('readme');
    expect(result.data?.version).toBe(3);
    expect(result.data?.body).toBe('# Hello World');
  });

  it('fetches a specific doc version', async () => {
    mockFetch(200, { id: 'v1', version: 1, bodyMd: '# v1 content' });

    const result = await afKbLookup(
      { kb_id: 'engineering-docs', doc_id: 'readme', version: 1 },
      'http://localhost:4751',
    );

    expect(result.ok).toBe(true);
    expect(result.data?.version).toBe(1);
    expect(result.data?.body).toBe('# v1 content');
  });

  it('returns HTTP error when server responds with 404', async () => {
    mockFetch(404, { error: 'Not found' });

    const result = await afKbLookup({ kb_id: 'missing-kb' }, 'http://localhost:4751');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('HTTP_404');
  });

  it('returns INVALID_KB_ID for invalid kb_id characters', async () => {
    const result = await afKbLookup({ kb_id: '../../../etc' }, 'http://localhost:4751');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_KB_ID');
    // fetch should not have been set up (mock not installed for this test)
    expect(vi.isMockFunction(global.fetch)).toBe(false);
  });

  it('returns INVALID_DOC_ID for invalid doc_id', async () => {
    const result = await afKbLookup(
      { kb_id: 'valid-kb', doc_id: 'INVALID_DOC_ID!' },
      'http://localhost:4751',
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_DOC_ID');
  });

  it('returns NETWORK_ERROR when server is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await afKbLookup({ kb_id: 'engineering-docs' }, 'http://localhost:9999');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
    expect(result.error?.message).toContain('ECONNREFUSED');
  });
});
