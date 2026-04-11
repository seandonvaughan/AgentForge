// packages/dashboard/src/__tests__/live-feed.test.ts
//
// Unit tests for the live activity feed helper utilities.
// Covers color resolution, category label formatting, and system-message
// filtering — the three rendering concerns for cycle_event SSE messages.

import { describe, it, expect } from 'vitest';
import {
  TYPE_COLORS,
  TYPE_LABELS,
  CYCLE_CATEGORY_LABELS,
  cycleAccentColor,
  formatCategory,
  formatTime,
  isSilentSystemMessage,
} from '../lib/util/live-feed.js';

// ─── TYPE_COLORS ─────────────────────────────────────────────────────────────

describe('TYPE_COLORS', () => {
  it('defines a color for every known event type', () => {
    const types = [
      'agent_activity', 'sprint_event', 'cost_event', 'workflow_event',
      'branch_event', 'system', 'refresh_signal', 'cycle_event',
    ];
    for (const t of types) {
      expect(TYPE_COLORS[t], `missing color for ${t}`).toBeTruthy();
    }
  });

  it('cycle_event uses --color-sonnet as primary', () => {
    expect(TYPE_COLORS['cycle_event']).toContain('--color-sonnet');
  });

  it('all values reference CSS custom properties (no hardcoded hex)', () => {
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      expect(color, `${type} should use var()`).toContain('var(--');
    }
  });
});

// ─── TYPE_LABELS ─────────────────────────────────────────────────────────────

describe('TYPE_LABELS', () => {
  it('cycle_event label is "Cycle"', () => {
    expect(TYPE_LABELS['cycle_event']).toBe('Cycle');
  });

  it('labels exist for all types that have colors', () => {
    for (const type of Object.keys(TYPE_COLORS)) {
      expect(TYPE_LABELS[type], `missing label for ${type}`).toBeTruthy();
    }
  });
});

// ─── cycleAccentColor ────────────────────────────────────────────────────────

describe('cycleAccentColor', () => {
  it('returns danger color for "cycle.failed"', () => {
    expect(cycleAccentColor('cycle.failed')).toBe('var(--color-danger)');
  });

  it('returns danger color for "phase.failure"', () => {
    expect(cycleAccentColor('phase.failure')).toBe('var(--color-danger)');
  });

  it('returns danger color for "cycle.error"', () => {
    expect(cycleAccentColor('cycle.error')).toBe('var(--color-danger)');
  });

  it('returns success color for "cycle.complete"', () => {
    expect(cycleAccentColor('cycle.complete')).toBe('var(--color-success)');
  });

  it('returns success color for "cycle.completed"', () => {
    expect(cycleAccentColor('cycle.completed')).toBe('var(--color-success)');
  });

  it('returns success color for "test.pass"', () => {
    expect(cycleAccentColor('test.pass')).toBe('var(--color-success)');
  });

  it('returns success color for bare "commit"', () => {
    expect(cycleAccentColor('commit')).toBe('var(--color-success)');
  });

  it('returns warning color for "budget.warn"', () => {
    expect(cycleAccentColor('budget.warn')).toBe('var(--color-warning)');
  });

  it('returns warning color for "approval.pending"', () => {
    expect(cycleAccentColor('approval.pending')).toBe('var(--color-warning)');
  });

  it('returns sonnet color for "cycle.started"', () => {
    expect(cycleAccentColor('cycle.started')).toBe('var(--color-sonnet)');
  });

  it('returns sonnet color for "phase.start"', () => {
    expect(cycleAccentColor('phase.start')).toBe('var(--color-sonnet)');
  });

  it('returns sonnet color for unknown/unrecognised category', () => {
    expect(cycleAccentColor('some.unknown.event')).toBe('var(--color-sonnet)');
  });

  it('is case-insensitive', () => {
    expect(cycleAccentColor('CYCLE.FAILED')).toBe('var(--color-danger)');
    expect(cycleAccentColor('Phase.Complete')).toBe('var(--color-success)');
  });
});

// ─── formatCategory ──────────────────────────────────────────────────────────

describe('formatCategory', () => {
  it('maps "cycle.failed" to "Failed"', () => {
    expect(formatCategory('cycle_event', 'cycle.failed')).toBe('Failed');
  });

  it('maps "phase.start" to "Phase →"', () => {
    expect(formatCategory('cycle_event', 'phase.start')).toBe('Phase →');
  });

  it('maps "approval.pending" to "Approval?"', () => {
    expect(formatCategory('cycle_event', 'approval.pending')).toBe('Approval?');
  });

  it('title-cases unknown cycle categories', () => {
    expect(formatCategory('cycle_event', 'some.new.category')).toBe('Some New Category');
  });

  it('returns category unchanged for non-cycle events', () => {
    expect(formatCategory('sprint_event', 'sprint.started')).toBe('sprint.started');
    expect(formatCategory('agent_activity', 'agent.invoked')).toBe('agent.invoked');
  });

  it('CYCLE_CATEGORY_LABELS covers all keys referenced in the component', () => {
    const expectedKeys = [
      'cycle.started', 'cycle.complete', 'cycle.completed', 'cycle.failed',
      'phase.start', 'phase.complete', 'phase.failure',
      'test.pass', 'test.fail',
      'approval.pending', 'approval.decision',
    ];
    for (const key of expectedKeys) {
      expect(CYCLE_CATEGORY_LABELS[key], `missing label for "${key}"`).toBeDefined();
    }
  });
});

// ─── formatTime ──────────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('formats an ISO timestamp as HH:MM:SS', () => {
    // Use a UTC-based time to avoid locale/timezone flakiness in CI.
    // We test that the output is a time string with the expected shape.
    const result = formatTime('2026-04-11T14:32:45.000Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('falls back to the raw string for an unparseable timestamp', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date');
  });

  it('handles empty string gracefully', () => {
    // new Date('') produces Invalid Date; should return the empty string
    expect(formatTime('')).toBe('');
  });
});

// ─── isSilentSystemMessage ───────────────────────────────────────────────────

describe('isSilentSystemMessage', () => {
  it('returns true for heartbeat system messages', () => {
    expect(isSilentSystemMessage('system', 'heartbeat')).toBe(true);
  });

  it('returns true for connected system messages', () => {
    expect(isSilentSystemMessage('system', 'connected')).toBe(true);
  });

  it('returns false for non-system types even if message matches', () => {
    expect(isSilentSystemMessage('cycle_event', 'heartbeat')).toBe(false);
    expect(isSilentSystemMessage('agent_activity', 'connected')).toBe(false);
  });

  it('returns false for system messages with other content', () => {
    expect(isSilentSystemMessage('system', 'something-else')).toBe(false);
  });

  it('returns false for a real cycle_event', () => {
    expect(isSilentSystemMessage('cycle_event', 'abc12345 · phase.start · plan')).toBe(false);
  });
});
