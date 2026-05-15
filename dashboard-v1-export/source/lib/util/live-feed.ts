/**
 * live-feed.ts
 *
 * Pure helper functions for the /live activity feed page.
 * Extracted from +page.svelte so they can be unit-tested independently.
 */

// ─── Event type meta ─────────────────────────────────────────────────────────

export type EventType =
  | 'agent_activity'
  | 'sprint_event'
  | 'cost_event'
  | 'workflow_event'
  | 'branch_event'
  | 'system'
  | 'refresh_signal'
  | 'cycle_event';

/** CSS custom-property color per event type, used for badge styling. */
export const TYPE_COLORS: Record<string, string> = {
  agent_activity: 'var(--color-brand)',
  sprint_event:   'var(--color-opus)',
  cost_event:     'var(--color-warning)',
  workflow_event: 'var(--color-info)',
  branch_event:   'var(--color-haiku)',
  system:         'var(--color-text-muted)',
  refresh_signal: 'var(--color-danger)',
  cycle_event:    'var(--color-sonnet, var(--color-info))',
};

/** Human-readable label shown inside each type badge. */
export const TYPE_LABELS: Record<string, string> = {
  agent_activity: 'Agent',
  sprint_event:   'Sprint',
  cost_event:     'Cost',
  workflow_event: 'Workflow',
  branch_event:   'Branch',
  system:         'System',
  refresh_signal: 'Refresh',
  cycle_event:    'Cycle',
};

// ─── Cycle event category labels ─────────────────────────────────────────────

/**
 * Map dot-notation cycle event category strings (e.g. "phase.start",
 * "cycle.failed") to human-readable labels shown in the category tag.
 */
export const CYCLE_CATEGORY_LABELS: Record<string, string> = {
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
  // Approvals (require human attention — rendered in warning accent)
  'approval.pending': 'Approval?',
  'approval.decision':'Decision',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a status-aware accent color for a cycle_event row from its category.
 *
 * - Failures / errors → danger (red)
 * - Completions / passes / commits → success (green)
 * - Warnings / budget / pending → warning (yellow)  ← draws operator attention
 * - Starts / anything else → sonnet (blue)
 */
export function cycleAccentColor(category: string): string {
  const cat = category.toLowerCase();
  if (cat.includes('fail') || cat.includes('error')) return 'var(--color-danger)';
  if (cat.includes('complete') || cat.includes('pass') || cat === 'commit') return 'var(--color-success)';
  if (cat.includes('warn') || cat.includes('budget') || cat.includes('pending')) return 'var(--color-warning)';
  return 'var(--color-sonnet)';
}

/**
 * Resolve a category string to a human-readable label.
 * For cycle_event types, looks up CYCLE_CATEGORY_LABELS first, then
 * title-cases the dot-notation string (e.g. "phase.start" → "Phase Start").
 */
export function formatCategory(type: string, category: string): string {
  if (type === 'cycle_event') {
    return CYCLE_CATEGORY_LABELS[category]
      ?? category.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return category;
}

/**
 * Format an ISO timestamp as HH:MM:SS (24-hour).
 * Falls back to the raw string if the value is not a valid date.
 * Note: `new Date(invalid)` does not throw — it produces Invalid Date —
 * so we must guard with `isNaN(d.getTime())` rather than a try/catch.
 */
export function formatTime(ts: string): string {
  if (!ts) return ts;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Returns true for SSE messages that should be silently discarded
 * rather than shown in the activity feed.
 */
export function isSilentSystemMessage(type: string, message: string): boolean {
  if (type !== 'system') return false;
  return message === 'heartbeat' || message === 'connected';
}
