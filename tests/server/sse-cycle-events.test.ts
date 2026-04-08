/**
 * SSE Cycle Events Integration Tests — P0-7
 *
 * Verifies that cycle_event messages are properly broadcast through the SSE stream
 * with correct colors, types, and timestamps for the /live activity feed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
// Types
// ---------------------------------------------------------------------------

interface CycleEventMessage {
  type: 'cycle_event';
  cycleId: string;
  phase: string;
  status: 'started' | 'progress' | 'completed' | 'failed';
  timestamp: string;
  color?: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE Cycle Events Integration', () => {
  let manager: SseManager;

  beforeEach(() => {
    manager = new SseManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  // -------------------------------------------------------------------------
  // Basic cycle_event broadcast
  // -------------------------------------------------------------------------

  describe('cycle_event broadcast', () => {
    it('broadcasts cycle_event with all required fields', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);

      const cycleEvent: CycleEventMessage = {
        type: 'cycle_event',
        cycleId: 'abc123',
        phase: 'execute',
        status: 'started',
        timestamp: new Date().toISOString(),
      };

      manager.broadcast('cycle_event', cycleEvent);

      const { write } = reply.raw as unknown as { write: ReturnType<typeof vi.fn> };
      expect(write).toHaveBeenCalledOnce();

      const payload = write.mock.calls[0][0] as string;
      expect(payload).toMatch(/^event: cycle_event\n/);
      expect(payload).toMatch(/data: /);
      expect(payload).toMatch(/"cycleId":"abc123"/);
      expect(payload).toMatch(/"phase":"execute"/);
      expect(payload).toMatch(/"status":"started"/);
      expect(payload).toMatch(/\n\n$/);
    });

    it('includes color information for different statuses', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);

      const statuses: Array<{ status: 'started' | 'progress' | 'completed' | 'failed'; expectedColor: string }> = [
        { status: 'started', expectedColor: 'green' },
        { status: 'progress', expectedColor: 'blue' },
        { status: 'completed', expectedColor: 'green' },
        { status: 'failed', expectedColor: 'red' },
      ];

      for (const { status, expectedColor } of statuses) {
        const cycleEvent: CycleEventMessage = {
          type: 'cycle_event',
          cycleId: `cycle-${status}`,
          phase: 'test',
          status,
          timestamp: new Date().toISOString(),
          color: expectedColor,
        };

        manager.broadcast('cycle_event', cycleEvent);

        const { write } = reply.raw as unknown as { write: ReturnType<typeof vi.fn> };
        const lastCall = write.mock.calls[write.mock.calls.length - 1][0] as string;
        expect(lastCall).toMatch(new RegExp(`"color":"${expectedColor}"`));
      }
    });

    it('preserves timestamp in ISO-8601 format', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);

      const now = new Date();
      const isoTimestamp = now.toISOString();

      const cycleEvent: CycleEventMessage = {
        type: 'cycle_event',
        cycleId: 'ts-test',
        phase: 'audit',
        status: 'started',
        timestamp: isoTimestamp,
      };

      manager.broadcast('cycle_event', cycleEvent);

      const { write } = reply.raw as unknown as { write: ReturnType<typeof vi.fn> };
      const payload = write.mock.calls[0][0] as string;
      expect(payload).toMatch(new RegExp(`"timestamp":"${isoTimestamp.replace(/[.]/g, '\\.')}"`));

      // Verify the timestamp can be parsed back
      const dataLine = payload.split('\n').find((l) => l.startsWith('data: '));
      const parsed = JSON.parse(dataLine!.slice('data: '.length)) as CycleEventMessage;
      expect(() => new Date(parsed.timestamp)).not.toThrow();
      expect(new Date(parsed.timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple clients receiving cycle_events
  // -------------------------------------------------------------------------

  describe('cycle_event delivery to multiple clients', () => {
    it('broadcasts cycle_event to all connected clients', () => {
      const r1 = makeMockReply();
      const r2 = makeMockReply();
      const r3 = makeMockReply();

      manager.addClient('c1', r1);
      manager.addClient('c2', r2);
      manager.addClient('c3', r3);

      const cycleEvent: CycleEventMessage = {
        type: 'cycle_event',
        cycleId: 'shared-event',
        phase: 'release',
        status: 'completed',
        timestamp: new Date().toISOString(),
      };

      manager.broadcast('cycle_event', cycleEvent);

      expect((r1.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
      expect((r2.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
      expect((r3.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
    });

    it('continues broadcasting to healthy clients when one client fails', () => {
      const badReply = {
        raw: {
          setHeader: vi.fn(),
          write: vi.fn().mockImplementation(() => { throw new Error('socket closed'); }),
          end: vi.fn(),
        },
      } as unknown as FastifyReply;

      const goodR1 = makeMockReply();
      const goodR2 = makeMockReply();

      manager.addClient('bad', badReply);
      manager.addClient('good1', goodR1);
      manager.addClient('good2', goodR2);

      const cycleEvent: CycleEventMessage = {
        type: 'cycle_event',
        cycleId: 'resilience-test',
        phase: 'gate',
        status: 'progress',
        timestamp: new Date().toISOString(),
      };

      expect(() => manager.broadcast('cycle_event', cycleEvent)).not.toThrow();

      // Bad client should be evicted
      expect(manager.getClientCount()).toBe(2);

      // Good clients should have received the event
      expect((goodR1.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
      expect((goodR2.raw as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Phase transitions (cycle lifecycle)
  // -------------------------------------------------------------------------

  describe('cycle phase transitions', () => {
    it('broadcasts events for each phase of a cycle', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);

      const phases = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'];
      const cycleId = 'phase-transition-cycle';

      for (const phase of phases) {
        const cycleEvent: CycleEventMessage = {
          type: 'cycle_event',
          cycleId,
          phase,
          status: phase === 'learn' ? 'completed' : 'progress',
          timestamp: new Date().toISOString(),
        };

        manager.broadcast('cycle_event', cycleEvent);
      }

      const { write } = reply.raw as unknown as { write: ReturnType<typeof vi.fn> };
      expect(write).toHaveBeenCalledTimes(phases.length);

      // Verify each phase is in the broadcasts
      for (let i = 0; i < phases.length; i++) {
        const payload = write.mock.calls[i][0] as string;
        expect(payload).toMatch(new RegExp(`"phase":"${phases[i]}"`));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Proper JSON encoding of complex data
  // -------------------------------------------------------------------------

  describe('cycle_event JSON encoding', () => {
    it('properly encodes complex cycle_event data with nested objects', () => {
      const reply = makeMockReply();
      manager.addClient('c1', reply);

      const complexEvent = {
        type: 'cycle_event' as const,
        cycleId: 'complex-123',
        phase: 'execute',
        status: 'progress' as const,
        timestamp: new Date().toISOString(),
        metrics: {
          tasksCompleted: 5,
          tasksTotal: 10,
          successRate: 0.95,
        },
      };

      manager.broadcast('cycle_event', complexEvent);

      const { write } = reply.raw as unknown as { write: ReturnType<typeof vi.fn> };
      const payload = write.mock.calls[0][0] as string;

      const dataLine = payload.split('\n').find((l) => l.startsWith('data: '));
      const parsed = JSON.parse(dataLine!.slice('data: '.length)) as typeof complexEvent;

      expect(parsed.metrics).toEqual({
        tasksCompleted: 5,
        tasksTotal: 10,
        successRate: 0.95,
      });
    });
  });
});
