/**
 * SSE Manager unit tests — P0-6
 *
 * Tests SseManager directly with mock FastifyReply objects.
 * No real HTTP server is started in this suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { SseManager } from '../../src/server/sse/sse-manager.js';

// ---------------------------------------------------------------------------
// Helper: create a mock FastifyReply with spy-able raw methods
// ---------------------------------------------------------------------------

function makeMockReply(): FastifyReply {
  return {
    raw: {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    },
  } as unknown as FastifyReply;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SseManager', () => {
  let manager: SseManager;

  beforeEach(() => {
    manager = new SseManager();
  });

  // -------------------------------------------------------------------------
  // addClient / getClientCount
  // -------------------------------------------------------------------------

  describe('addClient', () => {
    it('increments client count after adding a client', () => {
      expect(manager.getClientCount()).toBe(0);
      manager.addClient('c1', makeMockReply());
      expect(manager.getClientCount()).toBe(1);
    });

    it('registers the client without setting headers (route handler sets them)', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);
      // addClient just stores the client; the route handler is responsible for SSE headers
      expect(manager.getClientCount()).toBe(1);
    });

    it('supports multiple clients with distinct IDs', () => {
      manager.addClient('c1', makeMockReply());
      manager.addClient('c2', makeMockReply());
      manager.addClient('c3', makeMockReply());
      expect(manager.getClientCount()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // removeClient
  // -------------------------------------------------------------------------

  describe('removeClient', () => {
    it('decrements client count after removing a client', () => {
      manager.addClient('c1', makeMockReply());
      manager.removeClient('c1');
      expect(manager.getClientCount()).toBe(0);
    });

    it('is a no-op when removing a client that does not exist', () => {
      manager.addClient('c1', makeMockReply());
      manager.removeClient('unknown-id');
      expect(manager.getClientCount()).toBe(1);
    });

    it('only removes the targeted client', () => {
      manager.addClient('c1', makeMockReply());
      manager.addClient('c2', makeMockReply());
      manager.removeClient('c1');
      expect(manager.getClientCount()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getClientCount
  // -------------------------------------------------------------------------

  describe('getClientCount', () => {
    it('returns 0 when no clients are connected', () => {
      expect(manager.getClientCount()).toBe(0);
    });

    it('reflects the accurate count after adds and removes', () => {
      manager.addClient('c1', makeMockReply());
      manager.addClient('c2', makeMockReply());
      manager.removeClient('c1');
      expect(manager.getClientCount()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // broadcast
  // -------------------------------------------------------------------------

  describe('broadcast', () => {
    it('sends a formatted SSE message to a connected client', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);
      manager.broadcast('session.started', { sessionId: 'abc' });
      const { write } = reply.raw as unknown as { write: ReturnType<typeof vi.fn> };
      expect(write).toHaveBeenCalledOnce();
      const call = write.mock.calls[0][0] as string;
      expect(call).toMatch(/^event: session\.started\n/);
      expect(call).toMatch(/data: /);
      expect(call).toMatch(/"sessionId":"abc"/);
      expect(call).toMatch(/\n\n$/);
    });

    it('broadcasts to all connected clients', () => {
      const r1 = makeMockReply();
      const r2 = makeMockReply();
      manager.addClient('c1', r1);
      manager.addClient('c2', r2);
      manager.broadcast('test.event', { x: 1 });
      expect((r1.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
      expect((r2.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
    });

    it('is a no-op when no clients are connected', () => {
      // Should not throw
      expect(() => manager.broadcast('test.event', {})).not.toThrow();
    });

    it('removes a client whose write throws and continues to others', () => {
      const badReply = {
        raw: {
          setHeader: vi.fn(),
          write: vi.fn().mockImplementation(() => { throw new Error('socket closed'); }),
          end: vi.fn(),
        },
      } as unknown as FastifyReply;

      const goodReply = makeMockReply();
      manager.addClient('bad', badReply);
      manager.addClient('good', goodReply);

      expect(() => manager.broadcast('ping', {})).not.toThrow();

      // Bad client should have been evicted
      expect(manager.getClientCount()).toBe(1);
      // Good client should still have received the event
      expect((goodReply.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
    });

    it('produces valid JSON in the data field', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);
      const payload = { nested: { a: 1 }, arr: [1, 2, 3] };
      manager.broadcast('complex.event', payload);
      const written = (reply.raw as unknown as { write: ReturnType<typeof vi.fn> }).write.mock.calls[0][0] as string;
      const dataLine = written.split('\n').find((l) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse(dataLine!.slice('data: '.length)) as unknown;
      expect(parsed).toEqual(payload);
    });
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears all clients', () => {
      manager.addClient('c1', makeMockReply());
      manager.addClient('c2', makeMockReply());
      manager.destroy();
      expect(manager.getClientCount()).toBe(0);
    });

    it('calls end() on each connected client reply', () => {
      const r1 = makeMockReply();
      const r2 = makeMockReply();
      manager.addClient('c1', r1);
      manager.addClient('c2', r2);
      manager.destroy();
      expect((r1.raw as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalledOnce();
      expect((r2.raw as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalledOnce();
    });

    it('does not throw when destroy is called on an empty manager', () => {
      expect(() => manager.destroy()).not.toThrow();
    });

    it('handles end() throwing without propagating the error', () => {
      const badReply = {
        raw: {
          setHeader: vi.fn(),
          write: vi.fn(),
          end: vi.fn().mockImplementation(() => { throw new Error('already closed'); }),
        },
      } as unknown as FastifyReply;
      manager.addClient('c1', badReply);
      expect(() => manager.destroy()).not.toThrow();
      expect(manager.getClientCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // MAX_BUFFER eviction
  // -------------------------------------------------------------------------

  describe('MAX_BUFFER eviction', () => {
    it('evicts the oldest client when the buffer is full', () => {
      // Fill up to 100 clients
      const replies: FastifyReply[] = [];
      for (let i = 0; i < 100; i++) {
        const r = makeMockReply();
        replies.push(r);
        manager.addClient(`client-${i}`, r);
      }
      expect(manager.getClientCount()).toBe(100);

      // Adding one more should evict the oldest (client-0)
      const newReply = makeMockReply();
      manager.addClient('client-new', newReply);

      expect(manager.getClientCount()).toBe(100); // still 100, oldest was removed
      // The oldest reply should have had end() called on it
      expect((replies[0].raw as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalledOnce();
    });
  });
});
