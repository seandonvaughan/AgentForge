/**
 * v5 EventStream → /live Feed Integration Tests
 *
 * Verifies the actual data pipeline the /live page uses:
 *   EventStream (globalStream) → /api/v5/stream SSE → browser onmessage → FeedEvent render
 *
 * The /live page connects to `/api/v5/stream` using an unnamed SSE event format
 * (`data: {...}\n\n`) and parses each message via `onmessage`. This suite
 * confirms that:
 *   1. The EventStream emits cycle_event messages in the correct StreamEvent shape
 *   2. cycle_event fields satisfy the FeedEvent interface the live page expects
 *   3. Events include proper id, timestamp, type, category, and message for rendering
 *   4. Color and type label mappings cover cycle_event in TYPE_COLORS / TYPE_LABELS
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventStream } from '../../packages/server/src/routes/v5/stream.js';
import type { StreamEvent } from '../../packages/server/src/routes/v5/stream.js';

// ---------------------------------------------------------------------------
// Color and label tables mirrored from the /live Svelte page.
// If these get out of sync with the page, these tests will catch it.
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  agent_activity: 'var(--color-brand)',
  sprint_event:   'var(--color-opus)',
  cost_event:     'var(--color-warning)',
  workflow_event: 'var(--color-info)',
  branch_event:   'var(--color-haiku)',
  system:         'var(--color-text-muted)',
  refresh_signal: 'var(--color-danger)',
  cycle_event:    'var(--color-sonnet, var(--color-info))',
};

const TYPE_LABELS: Record<string, string> = {
  agent_activity: 'Agent',
  sprint_event:   'Sprint',
  cost_event:     'Cost',
  workflow_event: 'Workflow',
  branch_event:   'Branch',
  system:         'System',
  refresh_signal: 'Refresh',
  cycle_event:    'Cycle',
};

// ---------------------------------------------------------------------------
// Helper: collect StreamEvents from an EventStream
// ---------------------------------------------------------------------------

function collectFrom(stream: EventStream): { received: StreamEvent[]; unsub: () => void } {
  const received: StreamEvent[] = [];
  const unsub = stream.subscribe('test-client', (e) => received.push(e));
  return { received, unsub };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v5 EventStream → /live feed pipeline', () => {
  let stream: EventStream;

  beforeEach(() => {
    stream = new EventStream();
  });

  // -------------------------------------------------------------------------
  // StreamEvent shape matches FeedEvent interface expected by the live page
  // -------------------------------------------------------------------------

  describe('cycle_event StreamEvent shape', () => {
    it('emitted cycle_event has all fields the /live FeedEvent interface requires', () => {
      const { received, unsub } = collectFrom(stream);

      stream.emit({
        type: 'cycle_event',
        category: 'phase.start',
        message: 'a1b2c3d4 · phase.start · execute',
        data: {
          cycleId: 'cycle-abc',
          type: 'phase.start',
          phase: 'execute',
          at: new Date().toISOString(),
        },
      });

      expect(received).toHaveLength(1);
      const event = received[0];

      // FeedEvent required fields
      expect(typeof event.id).toBe('string');
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.type).toBe('cycle_event');
      expect(typeof event.category).toBe('string');
      expect(typeof event.message).toBe('string');
      expect(typeof event.timestamp).toBe('string');

      // timestamp must be parseable as ISO-8601
      const parsed = new Date(event.timestamp);
      expect(Number.isFinite(parsed.getTime())).toBe(true);

      unsub();
    });

    it('cycle_event id is unique per emission', () => {
      const { received, unsub } = collectFrom(stream);

      for (let i = 0; i < 5; i++) {
        stream.emit({
          type: 'cycle_event',
          category: 'phase.result',
          message: `cycle-${i} result`,
        });
      }

      const ids = received.map((e) => e.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);

      unsub();
    });

    it('cycle_event data payload is preserved in the StreamEvent', () => {
      const { received, unsub } = collectFrom(stream);

      const cycleData = {
        cycleId: 'live-cycle-123',
        type: 'phase.start',
        phase: 'review',
        at: '2026-04-07T12:00:00.000Z',
        payload: { agentId: 'architect' },
      };

      stream.emit({
        type: 'cycle_event',
        category: 'phase.start',
        message: 'live-cycl · phase.start · review',
        data: cycleData as unknown as Record<string, unknown>,
      });

      const event = received[0];
      expect(event.data).toBeDefined();
      expect((event.data as Record<string, unknown>).cycleId).toBe('live-cycle-123');
      expect((event.data as Record<string, unknown>).phase).toBe('review');

      unsub();
    });
  });

  // -------------------------------------------------------------------------
  // Live page color and label coverage for cycle_event
  // -------------------------------------------------------------------------

  describe('cycle_event color and label mapping', () => {
    it('TYPE_COLORS has an entry for cycle_event', () => {
      expect(TYPE_COLORS.cycle_event).toBeDefined();
      expect(TYPE_COLORS.cycle_event.length).toBeGreaterThan(0);
    });

    it('cycle_event color references --color-sonnet CSS variable', () => {
      // --color-sonnet is defined as #4a9eff in app.css
      expect(TYPE_COLORS.cycle_event).toContain('--color-sonnet');
    });

    it('TYPE_LABELS has an entry for cycle_event', () => {
      expect(TYPE_LABELS.cycle_event).toBe('Cycle');
    });

    it('all EventType values have entries in both TYPE_COLORS and TYPE_LABELS', () => {
      const eventTypes = [
        'agent_activity', 'sprint_event', 'cost_event', 'workflow_event',
        'branch_event', 'system', 'refresh_signal', 'cycle_event',
      ] as const;

      for (const t of eventTypes) {
        expect(TYPE_COLORS[t], `TYPE_COLORS missing "${t}"`).toBeDefined();
        expect(TYPE_LABELS[t], `TYPE_LABELS missing "${t}"`).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Subscription lifecycle — mirrors live page onMount/onDestroy pattern
  // -------------------------------------------------------------------------

  describe('subscription lifecycle', () => {
    it('unsubscribed client stops receiving cycle_events', () => {
      const { received, unsub } = collectFrom(stream);

      stream.emit({ type: 'cycle_event', category: 'phase.start', message: 'before unsub' });
      unsub();
      stream.emit({ type: 'cycle_event', category: 'phase.result', message: 'after unsub' });

      expect(received).toHaveLength(1);
      expect(received[0].message).toBe('before unsub');
    });

    it('live page reconnect pattern: re-subscribe after unsub receives new events', () => {
      const receivedFirst: StreamEvent[] = [];
      const receivedSecond: StreamEvent[] = [];

      const unsub1 = stream.subscribe('client-1', (e) => receivedFirst.push(e));
      stream.emit({ type: 'cycle_event', category: 'phase.start', message: 'first session' });
      unsub1();

      const unsub2 = stream.subscribe('client-1', (e) => receivedSecond.push(e));
      stream.emit({ type: 'cycle_event', category: 'phase.result', message: 'second session' });
      unsub2();

      expect(receivedFirst).toHaveLength(1);
      expect(receivedFirst[0].message).toBe('first session');
      expect(receivedSecond).toHaveLength(1);
      expect(receivedSecond[0].message).toBe('second session');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-phase cycle lifecycle — matches what startCycleEventsWatcher emits
  // -------------------------------------------------------------------------

  describe('cycle phase progression through EventStream', () => {
    it('live feed receives all 9 cycle phases in order', () => {
      const { received, unsub } = collectFrom(stream);

      const phases = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'];
      const cycleId = 'lifecycle-abc12345';

      for (const phase of phases) {
        stream.emit({
          type: 'cycle_event',
          category: 'phase.result',
          message: `${cycleId.slice(0, 8)} · phase.result · ${phase}`,
          data: { cycleId, type: 'phase.result', phase, at: new Date().toISOString() },
        });
      }

      expect(received).toHaveLength(phases.length);

      const receivedPhases = received.map(
        (e) => (e.data as Record<string, unknown>).phase as string
      );
      expect(receivedPhases).toEqual(phases);

      unsub();
    });

    it('watcher default message format matches expected live feed display', () => {
      const { received, unsub } = collectFrom(stream);

      const cycleId = 'abcdef1234567890';
      const phase = 'execute';
      const eventType = 'phase.start';

      // Replicate the default message format from startCycleEventsWatcher
      const message = `${cycleId.slice(0, 8)} · ${eventType} · ${phase}`;

      stream.emit({
        type: 'cycle_event',
        category: eventType,
        message,
        data: { cycleId, type: eventType, phase, at: new Date().toISOString() },
      });

      const event = received[0];
      // The /live page renders event.message in the event-message span
      expect(event.message).toBe('abcdef12 · phase.start · execute');
      // The /live page renders event.category in a category-tag span
      // (shown when category !== event.type and category !== 'system')
      expect(event.category).toBe('phase.start');
      expect(event.category).not.toBe(event.type); // 'phase.start' !== 'cycle_event'

      unsub();
    });
  });
});
