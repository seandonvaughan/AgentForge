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

// ─── cycleAccentColor — full CYCLE_CATEGORY_LABELS coverage ──────────────────
//
// Each key in CYCLE_CATEGORY_LABELS maps to a category that could arrive on the
// SSE stream. These tests verify the accent color the /live feed row would
// receive for every recognised category.

describe('cycleAccentColor — every CYCLE_CATEGORY_LABELS key', () => {
  // Danger group (failure / error keywords)
  it('test.fail → danger', () => {
    expect(cycleAccentColor('test.fail')).toBe('var(--color-danger)');
  });

  // Success group (complete / pass / merged keywords)
  it('tests.complete → success', () => {
    expect(cycleAccentColor('tests.complete')).toBe('var(--color-success)');
  });

  it('scoring.complete → success', () => {
    expect(cycleAccentColor('scoring.complete')).toBe('var(--color-success)');
  });

  it('phase.complete → success', () => {
    expect(cycleAccentColor('phase.complete')).toBe('var(--color-success)');
  });

  // Warning group (warn / budget / pending keywords)
  it('budget.warn → warning', () => {
    // already tested in main suite; re-assert for completeness
    expect(cycleAccentColor('budget.warn')).toBe('var(--color-warning)');
  });

  // Sonnet (default) group — no danger/success/warning keyword
  it('pr.opened → sonnet (default)', () => {
    expect(cycleAccentColor('pr.opened')).toBe('var(--color-sonnet)');
  });

  it('pr.merged → sonnet (default)', () => {
    expect(cycleAccentColor('pr.merged')).toBe('var(--color-sonnet)');
  });

  it('opened → sonnet (default)', () => {
    expect(cycleAccentColor('opened')).toBe('var(--color-sonnet)');
  });

  it('scoring.fallback → sonnet (default)', () => {
    expect(cycleAccentColor('scoring.fallback')).toBe('var(--color-sonnet)');
  });

  it('sprint.assigned → sonnet (default)', () => {
    expect(cycleAccentColor('sprint.assigned')).toBe('var(--color-sonnet)');
  });

  it('phase.result → sonnet (default)', () => {
    expect(cycleAccentColor('phase.result')).toBe('var(--color-sonnet)');
  });

  it('phase.skip → sonnet (default)', () => {
    expect(cycleAccentColor('phase.skip')).toBe('var(--color-sonnet)');
  });

  it('approval.decision → sonnet (default)', () => {
    expect(cycleAccentColor('approval.decision')).toBe('var(--color-sonnet)');
  });
});

// ─── formatCategory — remaining CYCLE_CATEGORY_LABELS entries ────────────────

describe('formatCategory — remaining cycle categories', () => {
  it('cycle.started → "Started"', () => {
    expect(formatCategory('cycle_event', 'cycle.started')).toBe('Started');
  });

  it('cycle.error → "Error"', () => {
    expect(formatCategory('cycle_event', 'cycle.error')).toBe('Error');
  });

  it('phase.complete → "Phase ✓"', () => {
    expect(formatCategory('cycle_event', 'phase.complete')).toBe('Phase ✓');
  });

  it('phase.result → "Result"', () => {
    expect(formatCategory('cycle_event', 'phase.result')).toBe('Result');
  });

  it('phase.skip → "Skipped"', () => {
    expect(formatCategory('cycle_event', 'phase.skip')).toBe('Skipped');
  });

  it('commit → "Commit"', () => {
    expect(formatCategory('cycle_event', 'commit')).toBe('Commit');
  });

  it('pr.opened → "PR Open"', () => {
    expect(formatCategory('cycle_event', 'pr.opened')).toBe('PR Open');
  });

  it('pr.merged → "PR Merged"', () => {
    expect(formatCategory('cycle_event', 'pr.merged')).toBe('PR Merged');
  });

  it('opened → "PR Open"', () => {
    expect(formatCategory('cycle_event', 'opened')).toBe('PR Open');
  });

  it('test.fail → "Tests ✗"', () => {
    expect(formatCategory('cycle_event', 'test.fail')).toBe('Tests ✗');
  });

  it('tests.complete → "Tests ✓"', () => {
    expect(formatCategory('cycle_event', 'tests.complete')).toBe('Tests ✓');
  });

  it('budget.warn → "Budget ⚠"', () => {
    expect(formatCategory('cycle_event', 'budget.warn')).toBe('Budget ⚠');
  });

  it('scoring.complete → "Scored"', () => {
    expect(formatCategory('cycle_event', 'scoring.complete')).toBe('Scored');
  });

  it('scoring.fallback → "Score ≈"', () => {
    expect(formatCategory('cycle_event', 'scoring.fallback')).toBe('Score ≈');
  });

  it('sprint.assigned → "Sprint →"', () => {
    expect(formatCategory('cycle_event', 'sprint.assigned')).toBe('Sprint →');
  });

  it('approval.decision → "Decision"', () => {
    expect(formatCategory('cycle_event', 'approval.decision')).toBe('Decision');
  });
});

// ─── cycle_event rendering pipeline ─────────────────────────────────────────
//
// These tests simulate the full /live page rendering path for a cycle_event
// SSE message: the shape of the payload emitted by stream.ts, processed through
// isSilentSystemMessage → cycleAccentColor + formatCategory + formatTime.
// They verify that an operator looking at the feed sees the right colors and
// human-readable timestamps for each significant lifecycle event.

describe('cycle_event rendering pipeline', () => {
  // Helpers that mirror the logic in +page.svelte's {#each} block
  function renderRow(event: { type: string; category: string; timestamp: string }) {
    const isCycle = event.type === 'cycle_event';
    const accentColor = isCycle
      ? cycleAccentColor(event.category)
      : (TYPE_COLORS[event.type] ?? 'var(--color-text-muted)');
    const categoryLabel = formatCategory(event.type, event.category);
    const timeLabel     = formatTime(event.timestamp);
    const typeBadgeColor = TYPE_COLORS[event.type] ?? 'var(--color-text-muted)';
    return { isCycle, accentColor, categoryLabel, timeLabel, typeBadgeColor };
  }

  it('cycle.failed event → danger accent, "Failed" label, HH:MM:SS time', () => {
    const r = renderRow({ type: 'cycle_event', category: 'cycle.failed', timestamp: '2026-04-17T10:05:30.000Z' });
    expect(r.isCycle).toBe(true);
    expect(r.accentColor).toBe('var(--color-danger)');
    expect(r.categoryLabel).toBe('Failed');
    expect(r.timeLabel).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('cycle.completed event → success accent, "Complete" label', () => {
    const r = renderRow({ type: 'cycle_event', category: 'cycle.completed', timestamp: '2026-04-17T10:10:00.000Z' });
    expect(r.accentColor).toBe('var(--color-success)');
    expect(r.categoryLabel).toBe('Complete');
  });

  it('approval.pending event → warning accent, "Approval?" label', () => {
    const r = renderRow({ type: 'cycle_event', category: 'approval.pending', timestamp: '2026-04-17T10:12:00.000Z' });
    expect(r.accentColor).toBe('var(--color-warning)');
    expect(r.categoryLabel).toBe('Approval?');
  });

  it('phase.start event → sonnet accent, "Phase →" label', () => {
    const r = renderRow({ type: 'cycle_event', category: 'phase.start', timestamp: '2026-04-17T10:01:00.000Z' });
    expect(r.accentColor).toBe('var(--color-sonnet)');
    expect(r.categoryLabel).toBe('Phase →');
  });

  it('cycle_event type badge uses --color-sonnet color', () => {
    const r = renderRow({ type: 'cycle_event', category: 'cycle.started', timestamp: '2026-04-17T09:59:00.000Z' });
    expect(r.typeBadgeColor).toContain('--color-sonnet');
  });

  it('non-cycle event is not treated as cycle row', () => {
    const r = renderRow({ type: 'sprint_event', category: 'sprint.started', timestamp: '2026-04-17T09:00:00.000Z' });
    expect(r.isCycle).toBe(false);
    // accent color comes from TYPE_COLORS, not cycleAccentColor
    expect(r.accentColor).toBe(TYPE_COLORS['sprint_event']);
  });

  it('cycle_event with invalid timestamp falls back to raw string', () => {
    const r = renderRow({ type: 'cycle_event', category: 'phase.start', timestamp: 'bad-ts' });
    expect(r.timeLabel).toBe('bad-ts');
  });

  it('cycle_event with unknown category title-cases the label', () => {
    const r = renderRow({ type: 'cycle_event', category: 'custom.new.phase', timestamp: '2026-04-17T10:00:00.000Z' });
    expect(r.categoryLabel).toBe('Custom New Phase');
    expect(r.accentColor).toBe('var(--color-sonnet)');
  });

  it('heartbeat system event is filtered before rendering', () => {
    expect(isSilentSystemMessage('system', 'heartbeat')).toBe(true);
    expect(isSilentSystemMessage('cycle_event', 'heartbeat')).toBe(false);
  });
});
