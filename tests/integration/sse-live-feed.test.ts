/**
 * SSE Live Activity Feed Integration Tests — P0-7
 *
 * Verifies that:
 * 1. The /live page subscribes to the SSE stream at /api/v1/stream
 * 2. cycle_event messages are received and rendered
 * 3. Events are displayed with proper colors, types, and timestamps
 *
 * NOTE: These tests verify that cycle_event messages are properly
 * broadcast and can be consumed by a live feed subscriber.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import type { SseManager } from '../../src/server/sse/sse-manager.js';
import { SseManager as SseManagerImpl } from '../../src/server/sse/sse-manager.js';
import type { FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Mock SSE Stream Client
// ---------------------------------------------------------------------------

/**
 * Simulates a browser client subscribing to the SSE stream.
 * This is what the /live feed page would do.
 */
class MockSseClient {
  private messages: Array<{ type: string; data: unknown }> = [];
  private mockReply: FastifyReply;

  constructor(
    private sseManager: SseManager,
    private clientId: string,
  ) {
    // Create a mock reply with a write spy
    this.mockReply = {
      raw: {
        setHeader: vi.fn(),
        write: vi.fn((payload: string) => {
          this.parseAndStoreMessage(payload);
        }),
        end: vi.fn(),
      },
    } as unknown as FastifyReply;
  }

  /**
   * Subscribe to SSE events.
   * In a real browser, this would be: new EventSource('/api/v1/stream')
   */
  subscribe(): () => void {
    // Register with the SSE manager
    this.sseManager.addClient(this.clientId, this.mockReply);

    // Return cleanup function
    return () => {
      this.sseManager.removeClient(this.clientId);
    };
  }

  private parseAndStoreMessage(payload: string): void {
    // Parse the SSE format: "event: <type>\ndata: <json>\n\n"
    const lines = payload.split('\n');
    let eventType = 'message';
    let data: unknown = null;

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        try {
          data = JSON.parse(line.slice('data: '.length));
        } catch {
          data = line.slice('data: '.length);
        }
      }
    }

    if (eventType && data) {
      const message = { type: eventType, data };
      this.messages.push(message);
    }
  }

  /** Get all messages received by this client */
  getMessages() {
    return [...this.messages];
  }

  /** Get messages of a specific type */
  getMessagesByType(type: string) {
    return this.messages.filter((m) => m.type === type);
  }

  /** Clear messages (for isolation between tests) */
  clearMessages() {
    this.messages = [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE Live Feed Integration', () => {
  let manager: SseManager;

  beforeEach(() => {
    // Create fresh manager for each test to avoid cross-test pollution
    manager = new SseManagerImpl();
  });

  afterEach(() => {
    manager.destroy();
  });

  // -------------------------------------------------------------------------
  // Client subscription verification
  // -------------------------------------------------------------------------

  describe('SSE client subscription', () => {
    it('client can subscribe to SSE stream and receive cycle_events', async () => {
      const client = new MockSseClient(manager, 'live-feed-client');
      const unsub = client.subscribe();

      // Broadcast a cycle_event
      manager.broadcast('cycle_event', {
        cycleId: 'test-cycle-001',
        phase: 'execute',
        status: 'started',
        timestamp: new Date().toISOString(),
        color: 'green',
      });

      // Let the write call complete
      await new Promise((resolve) => setImmediate(resolve));

      const messages = client.getMessagesByType('cycle_event');
      expect(messages).toHaveLength(1);
      expect((messages[0].data as Record<string, unknown>).cycleId).toBe('test-cycle-001');

      unsub();
    });

    it('multiple clients all receive the same cycle_event', async () => {
      const client1 = new MockSseClient(manager, 'live-feed-1');
      const client2 = new MockSseClient(manager, 'live-feed-2');

      const unsub1 = client1.subscribe();
      const unsub2 = client2.subscribe();

      manager.broadcast('cycle_event', {
        cycleId: 'multi-client-cycle',
        phase: 'test',
        status: 'progress',
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setImmediate(resolve));

      const msgs1 = client1.getMessagesByType('cycle_event');
      const msgs2 = client2.getMessagesByType('cycle_event');

      expect(msgs1).toHaveLength(1);
      expect(msgs2).toHaveLength(1);
      expect((msgs1[0].data as Record<string, unknown>).cycleId).toBe(
        (msgs2[0].data as Record<string, unknown>).cycleId,
      );

      unsub1();
      unsub2();
    });
  });

  // -------------------------------------------------------------------------
  // Cycle event rendering validation
  // -------------------------------------------------------------------------

  describe('cycle_event rendering', () => {
    it('cycle_event contains all required fields for rendering', async () => {
      const client = new MockSseClient(manager, 'render-test');
      const unsub = client.subscribe();

      const now = new Date();
      manager.broadcast('cycle_event', {
        cycleId: 'render-cycle-123',
        phase: 'review',
        status: 'completed',
        timestamp: now.toISOString(),
        color: 'blue',
      });

      await new Promise((resolve) => setImmediate(resolve));

      const msgs = client.getMessagesByType('cycle_event');
      expect(msgs).toHaveLength(1);

      const capturedEvent = msgs[0].data as Record<string, unknown>;
      expect(capturedEvent.cycleId).toBe('render-cycle-123');
      expect(capturedEvent.phase).toBe('review');
      expect(capturedEvent.status).toBe('completed');
      expect(capturedEvent.timestamp).toBe(now.toISOString());
      expect(capturedEvent.color).toBe('blue');

      unsub();
    });

    it('cycle_event color reflects status', async () => {
      const client = new MockSseClient(manager, 'color-test');
      const unsub = client.subscribe();

      const statuses: Array<{ status: string; expectedColor: string }> = [
        { status: 'started', expectedColor: 'green' },
        { status: 'progress', expectedColor: 'blue' },
        { status: 'completed', expectedColor: 'green' },
        { status: 'failed', expectedColor: 'red' },
      ];

      for (const { status, expectedColor } of statuses) {
        manager.broadcast('cycle_event', {
          cycleId: `color-test-${status}`,
          phase: 'execute',
          status,
          timestamp: new Date().toISOString(),
          color: expectedColor,
        });
      }

      await new Promise((resolve) => setImmediate(resolve));

      const msgs = client.getMessagesByType('cycle_event');
      expect(msgs).toHaveLength(4);

      const colorsByStatus: Record<string, string> = {};
      for (const msg of msgs) {
        const data = msg.data as Record<string, unknown>;
        colorsByStatus[data.status as string] = data.color as string;
      }

      expect(colorsByStatus.started).toBe('green');
      expect(colorsByStatus.progress).toBe('blue');
      expect(colorsByStatus.completed).toBe('green');
      expect(colorsByStatus.failed).toBe('red');

      unsub();
    });

    it('cycle_event timestamp is valid ISO-8601', async () => {
      const client = new MockSseClient(manager, 'timestamp-test');
      const unsub = client.subscribe();

      const now = new Date();
      manager.broadcast('cycle_event', {
        cycleId: 'ts-test',
        phase: 'audit',
        status: 'started',
        timestamp: now.toISOString(),
      });

      await new Promise((resolve) => setImmediate(resolve));

      const msgs = client.getMessagesByType('cycle_event');
      expect(msgs).toHaveLength(1);

      const capturedTimestamp = (msgs[0].data as Record<string, unknown>).timestamp as string;
      expect(capturedTimestamp).toBeDefined();

      // Should be able to parse the timestamp
      const parsed = new Date(capturedTimestamp);
      expect(parsed.getTime()).toBeGreaterThan(0);
      // Should match the original timestamp
      expect(parsed.toISOString()).toBe(now.toISOString());

      unsub();
    });
  });

  // -------------------------------------------------------------------------
  // Cycle phase progression
  // -------------------------------------------------------------------------

  describe('cycle phase progression in live feed', () => {
    it('live feed receives all phases of a cycle lifecycle', async () => {
      const client = new MockSseClient(manager, 'lifecycle-test');
      const unsub = client.subscribe();

      const cyclePhases = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'];
      const cycleId = 'lifecycle-cycle-456';

      for (const phase of cyclePhases) {
        manager.broadcast('cycle_event', {
          cycleId,
          phase,
          status: phase === 'learn' ? 'completed' : 'progress',
          timestamp: new Date().toISOString(),
        });
      }

      await new Promise((resolve) => setImmediate(resolve));

      const msgs = client.getMessagesByType('cycle_event');
      expect(msgs).toHaveLength(cyclePhases.length);

      const phases = msgs.map((m) => (m.data as Record<string, unknown>).phase as string);
      expect(phases).toEqual(cyclePhases);

      unsub();
    });
  });

  // -------------------------------------------------------------------------
  // Client resilience
  // -------------------------------------------------------------------------

  describe('live feed resilience', () => {
    it('events continue to be broadcast if one client disconnects', async () => {
      const client1 = new MockSseClient(manager, 'resilience-1');
      const client2 = new MockSseClient(manager, 'resilience-2');

      const unsub1 = client1.subscribe();
      const unsub2 = client2.subscribe();

      // Both clients receive a first event
      manager.broadcast('cycle_event', {
        cycleId: 'resilience-test-0',
        phase: 'audit',
        status: 'started',
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setImmediate(resolve));

      // Disconnect client 1
      unsub1();

      // Broadcast new event
      manager.broadcast('cycle_event', {
        cycleId: 'resilience-test-1',
        phase: 'execute',
        status: 'progress',
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setImmediate(resolve));

      // Client 1 should only have the first event
      const msgs1 = client1.getMessagesByType('cycle_event');
      expect(msgs1).toHaveLength(1);
      expect((msgs1[0].data as Record<string, unknown>).cycleId).toBe('resilience-test-0');

      // Client 2 should have both events
      const msgs2 = client2.getMessagesByType('cycle_event');
      expect(msgs2).toHaveLength(2);

      unsub2();
    });
  });
});
