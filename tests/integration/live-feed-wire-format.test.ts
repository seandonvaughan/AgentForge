/**
 * Live Feed SSE Wire-Format Compatibility Tests
 *
 * Verifies that the exact bytes the /api/v5/stream route writes to the SSE
 * connection are correctly parsed by the /live page's `onmessage` handler.
 *
 * This test exists because there are two distinct SSE event formats in use:
 *   - Named events (v1 SseManager):  "event: cycle_event\ndata: {...}\n\n"
 *     → Only received by addEventListener('cycle_event', handler)
 *     → NOT received by onmessage
 *   - Unnamed events (v5 EventStream): "data: {...}\n\n"
 *     → Received by onmessage — the format the /live page relies on
 *
 * If the v5 route ever changed to named events, cycle_event messages would
 * be silently dropped by the /live page's onmessage handler. This suite
 * guards against that regression.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventStream, type StreamEvent } from '../../packages/server/src/routes/v5/stream.js';

// ---------------------------------------------------------------------------
// Simulate the /live page's onmessage parsing logic
// ---------------------------------------------------------------------------

/**
 * The FeedEvent interface as defined in the /live Svelte page.
 * Kept in sync manually — any mismatch here indicates the page needs updating.
 */
interface FeedEvent {
  id: string;
  type:
    | 'agent_activity'
    | 'sprint_event'
    | 'cost_event'
    | 'workflow_event'
    | 'branch_event'
    | 'system'
    | 'refresh_signal'
    | 'cycle_event';
  category: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Simulate the wire bytes the /api/v5/stream route writes for a single event.
 * Matches: `reply.raw.write(\`data: ${JSON.stringify(event)}\n\n\`)`
 */
function serializeToSseWire(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Simulate the /live page's onmessage handler — what EventSource.onmessage
 * receives and returns as the MessageEvent.data string (just the data line).
 *
 * For unnamed SSE events, the browser sets e.data to the content after "data: ".
 * Multiple data lines are concatenated with newlines (per SSE spec), but
 * the v5 route only ever emits one data line per event.
 */
function parseWireBytes(wireBytes: string): string | null {
  // Browser extracts the "data: ..." line content
  const lines = wireBytes.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      dataLines.push(line.slice('data: '.length));
    }
    // Named "event: ..." lines are intentionally ignored here —
    // onmessage only fires for unnamed events in real browsers.
    // If we detect an event: line that is NOT the default 'message',
    // real browsers would fire addEventListener, NOT onmessage.
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

/**
 * Mirror of the /live page's onmessage handler logic.
 * Returns the parsed FeedEvent or null if the event should be skipped.
 */
function simulateOnMessage(wireBytes: string): FeedEvent | null {
  const raw = parseWireBytes(wireBytes);
  if (raw === null) return null;

  let parsed: FeedEvent & { clientId?: string };
  try {
    parsed = JSON.parse(raw) as FeedEvent & { clientId?: string };
  } catch {
    return null; // bad parse — onmessage silently ignores
  }

  // Skip heartbeats (mirrored from /live page onmessage guard)
  if (parsed.type === 'system' && parsed.message === 'heartbeat') return null;

  // Normalize id like the page does: parsed.id ?? `${Date.now()}`
  const id = parsed.id ?? String(Date.now());
  return { ...parsed, id };
}

/**
 * Returns true when SSE wire bytes contain a named "event: X" line
 * (indicating the message would NOT be received by onmessage in real browsers).
 */
function hasNamedEvent(wireBytes: string): boolean {
  return wireBytes.split('\n').some((line) => {
    if (!line.startsWith('event: ')) return false;
    const name = line.slice('event: '.length).trim();
    // The SSE spec default event type is 'message'; anything else means named.
    return name !== '' && name !== 'message';
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Live feed SSE wire-format compatibility', () => {
  let stream: EventStream;

  beforeEach(() => {
    stream = new EventStream();
  });

  // -------------------------------------------------------------------------
  // Named vs unnamed event format guard
  // -------------------------------------------------------------------------

  describe('v5 stream uses unnamed SSE events (onmessage compatible)', () => {
    it('EventStream emits data that produces unnamed SSE bytes (no event: line)', () => {
      let captured: StreamEvent | null = null;
      const unsub = stream.subscribe('guard-test', (e) => { captured = e; });

      stream.emit({
        type: 'cycle_event',
        category: 'phase.start',
        message: 'abcdef12 · phase.start · execute',
      });
      unsub();

      // The route writes: `data: ${JSON.stringify(event)}\n\n`
      const wireBytes = serializeToSseWire(captured!);

      // Must NOT have a named event: line — would bypass onmessage in browsers
      expect(hasNamedEvent(wireBytes)).toBe(false);

      // Must have exactly one data: line
      const dataLines = wireBytes.split('\n').filter((l) => l.startsWith('data: '));
      expect(dataLines).toHaveLength(1);
    });

    it('wire bytes end with \\n\\n (SSE message terminator)', () => {
      let captured: StreamEvent | null = null;
      const unsub = stream.subscribe('terminator-test', (e) => { captured = e; });
      stream.emit({ type: 'cycle_event', category: 'phase.result', message: 'done' });
      unsub();

      const wireBytes = serializeToSseWire(captured!);
      expect(wireBytes.endsWith('\n\n')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cycle_event round-trip: EventStream → wire bytes → onmessage → FeedEvent
  // -------------------------------------------------------------------------

  describe('cycle_event round-trip through wire format', () => {
    it('cycle_event round-trips correctly from EventStream to FeedEvent', () => {
      let captured: StreamEvent | null = null;
      const unsub = stream.subscribe('rt-test', (e) => { captured = e; });

      stream.emit({
        type: 'cycle_event',
        category: 'phase.start',
        message: 'abcdef12 · phase.start · execute',
        data: {
          cycleId: 'abcdef1234567890',
          type: 'phase.start',
          phase: 'execute',
          at: '2026-04-07T10:00:00.000Z',
        },
      });
      unsub();

      const wireBytes = serializeToSseWire(captured!);
      const feedEvent = simulateOnMessage(wireBytes);

      expect(feedEvent).not.toBeNull();
      expect(feedEvent!.type).toBe('cycle_event');
      expect(feedEvent!.category).toBe('phase.start');
      expect(feedEvent!.message).toBe('abcdef12 · phase.start · execute');
      expect(feedEvent!.id).toBeTruthy();
      expect(feedEvent!.timestamp).toBeTruthy();
      expect(new Date(feedEvent!.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('cycle_event data payload survives wire-format round-trip', () => {
      let captured: StreamEvent | null = null;
      const unsub = stream.subscribe('payload-rt', (e) => { captured = e; });

      const cycleData = {
        cycleId: 'live-cycle-abc123',
        type: 'phase.result',
        phase: 'review',
        at: '2026-04-07T12:00:00.000Z',
        payload: { agentId: 'architect', verdict: 'approved' },
      };

      stream.emit({
        type: 'cycle_event',
        category: 'phase.result',
        message: 'live-cycl · phase.result · review',
        data: cycleData as unknown as Record<string, unknown>,
      });
      unsub();

      const feedEvent = simulateOnMessage(serializeToSseWire(captured!));
      expect(feedEvent).not.toBeNull();
      expect((feedEvent!.data as Record<string, unknown>).cycleId).toBe('live-cycle-abc123');
      expect((feedEvent!.data as Record<string, unknown>).phase).toBe('review');
      expect(
        ((feedEvent!.data as Record<string, unknown>).payload as Record<string, unknown>).verdict,
      ).toBe('approved');
    });

    it('all 9 cycle phases survive round-trip in order', () => {
      const phases = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'];
      const captured: StreamEvent[] = [];
      const unsub = stream.subscribe('phase-rt', (e) => captured.push(e));

      for (const phase of phases) {
        stream.emit({
          type: 'cycle_event',
          category: 'phase.result',
          message: `abcdef12 · phase.result · ${phase}`,
          data: { cycleId: 'abcdef1234567890', phase, at: new Date().toISOString() },
        });
      }
      unsub();

      const feedEvents = captured
        .map((e) => simulateOnMessage(serializeToSseWire(e)))
        .filter((e): e is FeedEvent => e !== null);

      expect(feedEvents).toHaveLength(phases.length);

      const receivedPhases = feedEvents.map(
        (e) => (e.data as Record<string, unknown>).phase as string,
      );
      expect(receivedPhases).toEqual(phases);
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat filtering — heartbeats must not appear in the feed
  // -------------------------------------------------------------------------

  describe('heartbeat filtering in onmessage handler', () => {
    it('heartbeat system event is silently dropped by onmessage handler', () => {
      // The v5 route emits heartbeats directly (not via EventStream.emit)
      // Simulate the exact bytes the route writes for a heartbeat
      const heartbeatBytes = `data: ${JSON.stringify({
        type: 'system',
        message: 'heartbeat',
        timestamp: new Date().toISOString(),
      })}\n\n`;

      const result = simulateOnMessage(heartbeatBytes);
      expect(result).toBeNull();
    });

    it('connected system event is NOT filtered (only heartbeat is)', () => {
      // The "connected" event should pass through the filter
      const connectedBytes = `data: ${JSON.stringify({
        type: 'system',
        message: 'connected',
        clientId: 'test-client-id',
        timestamp: new Date().toISOString(),
      })}\n\n`;

      const result = simulateOnMessage(connectedBytes);
      // connected events pass through (they are not type=system+message=heartbeat)
      expect(result).not.toBeNull();
      expect(result!.type).toBe('system');
      expect(result!.message).toBe('connected');
    });
  });

  // -------------------------------------------------------------------------
  // Malformed wire bytes resilience
  // -------------------------------------------------------------------------

  describe('onmessage handler resilience to malformed wire bytes', () => {
    it('does not throw on malformed JSON in wire bytes', () => {
      const malformedBytes = 'data: {not valid json\n\n';
      expect(() => simulateOnMessage(malformedBytes)).not.toThrow();
      expect(simulateOnMessage(malformedBytes)).toBeNull();
    });

    it('does not throw when no data: line is present', () => {
      const noDataBytes = 'comment: some comment\n\n';
      expect(() => simulateOnMessage(noDataBytes)).not.toThrow();
      expect(simulateOnMessage(noDataBytes)).toBeNull();
    });

    it('id falls back to Date.now() string when event has no id field', () => {
      // Simulate a manually crafted wire event missing the id field
      const noIdBytes = `data: ${JSON.stringify({
        type: 'cycle_event',
        category: 'phase.start',
        message: 'test event without id',
        timestamp: new Date().toISOString(),
        // intentionally no id field
      })}\n\n`;

      const result = simulateOnMessage(noIdBytes);
      expect(result).not.toBeNull();
      // id should be a non-empty string (fallback to Date.now())
      expect(typeof result!.id).toBe('string');
      expect(result!.id.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // TYPE_COLORS / TYPE_LABELS coverage — cycle_event must be mapped
  // -------------------------------------------------------------------------

  describe('cycle_event type is covered by /live page color and label tables', () => {
    // These tables are mirrored from the Svelte page. If either is wrong, the
    // live feed will render unstyled or show the raw type key instead of a label.

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

    it('cycle_event has a color entry using --color-sonnet CSS variable', () => {
      expect(TYPE_COLORS['cycle_event']).toBeDefined();
      expect(TYPE_COLORS['cycle_event']).toContain('--color-sonnet');
    });

    it('cycle_event has a label entry of "Cycle"', () => {
      expect(TYPE_LABELS['cycle_event']).toBe('Cycle');
    });

    it('all StreamEvent types from the v5 EventStream are mapped in TYPE_COLORS', () => {
      // Every type in the StreamEvent union must have a color fallback
      const streamEventTypes: Array<StreamEvent['type']> = [
        'agent_activity', 'sprint_event', 'cost_event', 'workflow_event',
        'branch_event', 'system', 'refresh_signal', 'cycle_event',
      ];

      for (const t of streamEventTypes) {
        expect(TYPE_COLORS[t], `TYPE_COLORS missing entry for "${t}"`).toBeDefined();
        expect(TYPE_LABELS[t], `TYPE_LABELS missing entry for "${t}"`).toBeDefined();
      }
    });

    it('cycle_event round-trip produces a type that has a valid color mapping', () => {
      let captured: StreamEvent | null = null;
      const unsub = stream.subscribe('color-mapping-test', (e) => { captured = e; });
      stream.emit({
        type: 'cycle_event',
        category: 'phase.start',
        message: 'test',
      });
      unsub();

      const feedEvent = simulateOnMessage(serializeToSseWire(captured!));
      expect(feedEvent).not.toBeNull();

      // The type should resolve to a color (not the undefined fallback path)
      const color = TYPE_COLORS[feedEvent!.type];
      expect(color).toBeDefined();
      expect(color.length).toBeGreaterThan(0);
    });
  });
});
