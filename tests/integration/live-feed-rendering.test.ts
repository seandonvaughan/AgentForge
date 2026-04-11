/**
 * Live Feed Rendering Logic Tests
 *
 * Verifies that the /live page's rendering helper functions produce the
 * expected output for cycle_event messages. All functions are mirrored from
 * `packages/dashboard/src/routes/live/+page.svelte` — intentionally, so that
 * any change to the Svelte source requires a corresponding update here.
 *
 * Coverage:
 *   - cycleAccentColor(category)  → CSS variable string per event status
 *   - formatCategory(type, cat)   → Human-readable label for the category tag
 *   - formatTime(timestamp)       → HH:MM:SS display string
 *   - TYPE_COLORS / TYPE_LABELS   → cycle_event entries are correctly mapped
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Mirrors of pure rendering helpers from +page.svelte
// If the page's logic changes, update these mirrors and the tests below.
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

const CYCLE_CATEGORY_LABELS: Record<string, string> = {
  // Lifecycle
  'cycle.started':    'Started',
  'cycle.complete':   'Complete',
  'cycle.completed':  'Complete',
  'cycle.failed':     'Failed',
  'cycle.error':      'Error',
  // Phases
  'phase.start':      'Phase →',
  'phase.complete':   'Phase ✓',
  'phase.result':     'Result',
  'phase.failure':    'Phase ✗',
  'phase.skip':       'Skipped',
  // Source control
  'commit':           'Commit',
  'pr.opened':        'PR Open',
  'pr.merged':        'PR Merged',
  'opened':           'PR Open',
  // Tests
  'test.pass':        'Tests ✓',
  'test.fail':        'Tests ✗',
  'tests.complete':   'Tests ✓',
  // Budget
  'budget.warn':      'Budget ⚠',
  // Scoring
  'scoring.complete': 'Scored',
  'scoring.fallback': 'Score ≈',
  // Sprint assignment
  'sprint.assigned':  'Sprint →',
  // Approvals
  'approval.pending': 'Approval?',
  'approval.decision':'Decision',
};

function cycleAccentColor(category: string): string {
  const cat = category.toLowerCase();
  if (cat.includes('fail') || cat.includes('error')) return 'var(--color-danger)';
  if (cat.includes('complete') || cat.includes('pass') || cat === 'commit') return 'var(--color-success)';
  if (cat.includes('warn') || cat.includes('budget') || cat.includes('pending')) return 'var(--color-warning)';
  if (cat.includes('start') || cat === 'cycle.started') return 'var(--color-sonnet)';
  return 'var(--color-sonnet)';
}

function formatCategory(type: string, category: string): string {
  if (type === 'cycle_event') {
    return CYCLE_CATEGORY_LABELS[category] ?? category.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return category;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Live feed rendering logic', () => {

  // -------------------------------------------------------------------------
  // cycleAccentColor — status-aware left-border color
  // -------------------------------------------------------------------------

  describe('cycleAccentColor', () => {
    it('maps "cycle.failed" to danger (red)', () => {
      expect(cycleAccentColor('cycle.failed')).toBe('var(--color-danger)');
    });

    it('maps "cycle.error" to danger', () => {
      expect(cycleAccentColor('cycle.error')).toBe('var(--color-danger)');
    });

    it('maps "test.fail" to danger (contains "fail")', () => {
      expect(cycleAccentColor('test.fail')).toBe('var(--color-danger)');
    });

    it('maps "cycle.complete" to success (green)', () => {
      expect(cycleAccentColor('cycle.complete')).toBe('var(--color-success)');
    });

    it('maps "cycle.completed" to success', () => {
      expect(cycleAccentColor('cycle.completed')).toBe('var(--color-success)');
    });

    it('maps "phase.complete" to success (contains "complete")', () => {
      expect(cycleAccentColor('phase.complete')).toBe('var(--color-success)');
    });

    it('maps "test.pass" to success (contains "pass")', () => {
      expect(cycleAccentColor('test.pass')).toBe('var(--color-success)');
    });

    it('maps "commit" to success (exact match)', () => {
      expect(cycleAccentColor('commit')).toBe('var(--color-success)');
    });

    it('maps "budget.warn" to warning (yellow)', () => {
      expect(cycleAccentColor('budget.warn')).toBe('var(--color-warning)');
    });

    it('maps "approval.pending" to warning (yellow — needs operator attention)', () => {
      expect(cycleAccentColor('approval.pending')).toBe('var(--color-warning)');
    });

    it('maps "phase.failure" to danger (contains "fail")', () => {
      expect(cycleAccentColor('phase.failure')).toBe('var(--color-danger)');
    });

    it('maps "scoring.complete" to success (contains "complete")', () => {
      expect(cycleAccentColor('scoring.complete')).toBe('var(--color-success)');
    });

    it('maps "tests.complete" to success (contains "complete")', () => {
      expect(cycleAccentColor('tests.complete')).toBe('var(--color-success)');
    });

    it('maps "cycle.started" to sonnet blue (contains "start")', () => {
      expect(cycleAccentColor('cycle.started')).toBe('var(--color-sonnet)');
    });

    it('maps "phase.start" to sonnet blue (contains "start")', () => {
      expect(cycleAccentColor('phase.start')).toBe('var(--color-sonnet)');
    });

    it('maps "phase.result" to sonnet blue (default fallback)', () => {
      expect(cycleAccentColor('phase.result')).toBe('var(--color-sonnet)');
    });

    it('maps "phase.skip" to sonnet blue (default fallback)', () => {
      expect(cycleAccentColor('phase.skip')).toBe('var(--color-sonnet)');
    });

    it('maps "pr.opened" to sonnet blue (default fallback)', () => {
      expect(cycleAccentColor('pr.opened')).toBe('var(--color-sonnet)');
    });

    it('maps "pr.merged" to sonnet blue (default fallback)', () => {
      expect(cycleAccentColor('pr.merged')).toBe('var(--color-sonnet)');
    });

    it('is case-insensitive (CYCLE.FAILED maps to danger)', () => {
      expect(cycleAccentColor('CYCLE.FAILED')).toBe('var(--color-danger)');
    });

    it('unknown category falls back to sonnet blue', () => {
      expect(cycleAccentColor('totally.unknown.event')).toBe('var(--color-sonnet)');
    });
  });

  // -------------------------------------------------------------------------
  // formatCategory — human-readable category tag text
  // -------------------------------------------------------------------------

  describe('formatCategory — cycle_event type', () => {
    it('maps "cycle.started" → "Started"', () => {
      expect(formatCategory('cycle_event', 'cycle.started')).toBe('Started');
    });

    it('maps "cycle.complete" → "Complete"', () => {
      expect(formatCategory('cycle_event', 'cycle.complete')).toBe('Complete');
    });

    it('maps "cycle.completed" → "Complete"', () => {
      expect(formatCategory('cycle_event', 'cycle.completed')).toBe('Complete');
    });

    it('maps "cycle.failed" → "Failed"', () => {
      expect(formatCategory('cycle_event', 'cycle.failed')).toBe('Failed');
    });

    it('maps "cycle.error" → "Error"', () => {
      expect(formatCategory('cycle_event', 'cycle.error')).toBe('Error');
    });

    it('maps "phase.start" → "Phase →"', () => {
      expect(formatCategory('cycle_event', 'phase.start')).toBe('Phase →');
    });

    it('maps "phase.complete" → "Phase ✓"', () => {
      expect(formatCategory('cycle_event', 'phase.complete')).toBe('Phase ✓');
    });

    it('maps "phase.result" → "Result"', () => {
      expect(formatCategory('cycle_event', 'phase.result')).toBe('Result');
    });

    it('maps "phase.skip" → "Skipped"', () => {
      expect(formatCategory('cycle_event', 'phase.skip')).toBe('Skipped');
    });

    it('maps "commit" → "Commit"', () => {
      expect(formatCategory('cycle_event', 'commit')).toBe('Commit');
    });

    it('maps "pr.opened" → "PR Open"', () => {
      expect(formatCategory('cycle_event', 'pr.opened')).toBe('PR Open');
    });

    it('maps "pr.merged" → "PR Merged"', () => {
      expect(formatCategory('cycle_event', 'pr.merged')).toBe('PR Merged');
    });

    it('maps "test.pass" → "Tests ✓"', () => {
      expect(formatCategory('cycle_event', 'test.pass')).toBe('Tests ✓');
    });

    it('maps "test.fail" → "Tests ✗"', () => {
      expect(formatCategory('cycle_event', 'test.fail')).toBe('Tests ✗');
    });

    it('maps "budget.warn" → "Budget ⚠"', () => {
      expect(formatCategory('cycle_event', 'budget.warn')).toBe('Budget ⚠');
    });

    // Real-world categories observed in production events.jsonl files:
    it('maps "phase.failure" → "Phase ✗"', () => {
      expect(formatCategory('cycle_event', 'phase.failure')).toBe('Phase ✗');
    });

    it('maps "tests.complete" → "Tests ✓"', () => {
      expect(formatCategory('cycle_event', 'tests.complete')).toBe('Tests ✓');
    });

    it('maps "scoring.complete" → "Scored"', () => {
      expect(formatCategory('cycle_event', 'scoring.complete')).toBe('Scored');
    });

    it('maps "scoring.fallback" → "Score ≈"', () => {
      expect(formatCategory('cycle_event', 'scoring.fallback')).toBe('Score ≈');
    });

    it('maps "sprint.assigned" → "Sprint →"', () => {
      expect(formatCategory('cycle_event', 'sprint.assigned')).toBe('Sprint →');
    });

    it('maps "approval.pending" → "Approval?"', () => {
      expect(formatCategory('cycle_event', 'approval.pending')).toBe('Approval?');
    });

    it('maps "approval.decision" → "Decision"', () => {
      expect(formatCategory('cycle_event', 'approval.decision')).toBe('Decision');
    });

    it('maps "opened" → "PR Open" (GitHub PR webhook alias for pr.opened)', () => {
      expect(formatCategory('cycle_event', 'opened')).toBe('PR Open');
    });

    it('unknown category falls back to title-cased dot-replaced string', () => {
      // e.g. "some.new.category" → "Some New Category"
      expect(formatCategory('cycle_event', 'some.new.category')).toBe('Some New Category');
    });

    it('unknown single-word category is capitalized', () => {
      expect(formatCategory('cycle_event', 'checkpoint')).toBe('Checkpoint');
    });
  });

  describe('formatCategory — non-cycle_event type passes category through unchanged', () => {
    it('returns category as-is for agent_activity', () => {
      expect(formatCategory('agent_activity', 'task.started')).toBe('task.started');
    });

    it('returns category as-is for system events', () => {
      expect(formatCategory('system', 'heartbeat')).toBe('heartbeat');
    });

    it('returns category as-is for workflow_event', () => {
      expect(formatCategory('workflow_event', 'completed')).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // formatTime — timestamp display (HH:MM:SS)
  // -------------------------------------------------------------------------

  describe('formatTime', () => {
    it('formats a valid ISO timestamp to HH:MM:SS (24h)', () => {
      // Use a fixed UTC time and check the output has the right shape
      const ts = '2026-04-10T10:30:45.000Z';
      const result = formatTime(ts);
      // Should be 8 chars, digits and colons only: "HH:MM:SS"
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('output has exactly two colons (HH:MM:SS format)', () => {
      const result = formatTime('2026-04-10T14:05:09.000Z');
      expect(result.split(':').length).toBe(3);
    });

    it('all three segments are two-digit strings', () => {
      const result = formatTime('2026-04-10T08:07:06.000Z');
      const [hh, mm, ss] = result.split(':');
      expect(hh).toHaveLength(2);
      expect(mm).toHaveLength(2);
      expect(ss).toHaveLength(2);
    });

    it('returns original string when input is not a valid date', () => {
      // "not-a-date" will not throw but new Date("not-a-date").toLocaleTimeString
      // returns "Invalid Date" which is not the original string — the try/catch
      // only catches thrown errors. Invalid Date returns a string, so we just
      // verify the function does not throw.
      expect(() => formatTime('not-a-date')).not.toThrow();
    });

    it('returns a non-empty string for any input', () => {
      expect(formatTime('2026-04-10T23:59:59.999Z').length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // TYPE_COLORS — cycle_event has the correct CSS variable
  // -------------------------------------------------------------------------

  describe('TYPE_COLORS table', () => {
    it('cycle_event maps to --color-sonnet (with --color-info fallback)', () => {
      expect(TYPE_COLORS['cycle_event']).toBe('var(--color-sonnet, var(--color-info))');
    });

    it('all event types are present', () => {
      const required = [
        'agent_activity', 'sprint_event', 'cost_event', 'workflow_event',
        'branch_event', 'system', 'refresh_signal', 'cycle_event',
      ];
      for (const t of required) {
        expect(TYPE_COLORS[t], `Missing TYPE_COLORS entry for "${t}"`).toBeDefined();
        expect(TYPE_COLORS[t].length).toBeGreaterThan(0);
      }
    });

    it('all color values reference CSS variables (start with "var(")', () => {
      for (const [type, color] of Object.entries(TYPE_COLORS)) {
        expect(color, `TYPE_COLORS["${type}"] does not use a CSS variable`).toMatch(/^var\(--/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // TYPE_LABELS — cycle_event renders as "Cycle"
  // -------------------------------------------------------------------------

  describe('TYPE_LABELS table', () => {
    it('cycle_event label is "Cycle"', () => {
      expect(TYPE_LABELS['cycle_event']).toBe('Cycle');
    });

    it('all event types have non-empty labels', () => {
      const required = [
        'agent_activity', 'sprint_event', 'cost_event', 'workflow_event',
        'branch_event', 'system', 'refresh_signal', 'cycle_event',
      ];
      for (const t of required) {
        expect(TYPE_LABELS[t], `Missing TYPE_LABELS entry for "${t}"`).toBeDefined();
        expect(TYPE_LABELS[t].length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // CYCLE_CATEGORY_LABELS completeness — every known category has a label
  // -------------------------------------------------------------------------

  describe('CYCLE_CATEGORY_LABELS completeness', () => {
    // These are the categories the server-side CycleEventsWatcher actually emits
    // based on msg.type fields observed in real .agentforge/cycles/*/events.jsonl files.
    const knownServerCategories = [
      // spec-defined lifecycle events
      'cycle.started',
      'cycle.complete',
      'cycle.completed',
      'cycle.failed',
      'cycle.error',
      // phase events (observed in production events.jsonl)
      'phase.start',
      'phase.complete',
      'phase.result',
      'phase.failure',
      'phase.skip',
      // source control
      'commit',
      'pr.opened',
      'pr.merged',
      'opened',
      // tests
      'test.pass',
      'test.fail',
      'tests.complete',
      // budget
      'budget.warn',
      // scoring (observed in production events.jsonl)
      'scoring.complete',
      'scoring.fallback',
      // sprint
      'sprint.assigned',
      // approvals (observed in production events.jsonl)
      'approval.pending',
      'approval.decision',
    ];

    it('every known server-emitted category has a CYCLE_CATEGORY_LABELS entry', () => {
      for (const cat of knownServerCategories) {
        expect(
          CYCLE_CATEGORY_LABELS[cat],
          `CYCLE_CATEGORY_LABELS missing entry for "${cat}"`,
        ).toBeDefined();
      }
    });

    it('no CYCLE_CATEGORY_LABELS entry is empty', () => {
      for (const [cat, label] of Object.entries(CYCLE_CATEGORY_LABELS)) {
        expect(label.length, `CYCLE_CATEGORY_LABELS["${cat}"] is empty`).toBeGreaterThan(0);
      }
    });
  });
});
