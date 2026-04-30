/**
 * E2E Tests: /live Activity Feed — cycle_event SSE Rendering
 *
 * Verifies that the /live page:
 *   1. Loads and displays the correct title and structure
 *   2. Subscribes to the SSE stream (EventSource at /api/v5/stream)
 *   3. Renders cycle_event messages with proper type badge, color, category, and timestamp
 *   4. Filters events by type (cycle_event filter)
 *   5. Handles reconnect behavior on connection loss
 *
 * Uses `page.addInitScript()` to inject a MockEventSource before the Svelte page
 * mounts — this intercepts the `new EventSource(...)` call in `connect()` and
 * delivers synthetic events without requiring a live SSE server.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared MockEventSource injection
// ---------------------------------------------------------------------------

/**
 * Injects a MockEventSource into the page context that immediately fires onopen
 * and then delivers the provided events at staggered intervals.
 *
 * This replaces window.EventSource before any page scripts run, so the Svelte
 * component's `new EventSource(SSE_URL)` picks it up automatically.
 */
async function injectMockEventSource(
  page: Page,
  events: Array<{
    id: string;
    type: string;
    category: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }>,
  options: { errorAfterMs?: number } = {},
) {
  await page.addInitScript(
    ({ mockEvents, mockOptions }: { mockEvents: typeof events; mockOptions: typeof options }) => {
      const sources: Array<{
        onopen: ((e: Event) => void) | null;
        onmessage: ((e: MessageEvent) => void) | null;
        onerror: ((e: Event) => void) | null;
      }> = [];

      class MockEventSource {
        onopen: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        readyState = 1; // OPEN

        constructor(_url: string) {
          sources.push(this);
          // Deliver each event at 50ms intervals after open
          mockEvents.forEach((event, i) => {
            setTimeout(() => {
              if (this.onmessage) {
                this.onmessage(
                  new MessageEvent('message', { data: JSON.stringify(event) }),
                );
              }
            }, 80 + i * 40);
          });

          if (mockOptions.errorAfterMs !== undefined) {
            setTimeout(() => {
              if (this.onerror) this.onerror(new Event('error'));
            }, mockOptions.errorAfterMs);
          }
        }

        close() {
          // no-op for mock
        }
      }

      // Override window.EventSource with our mock before Svelte mounts
      Object.assign(window, {
        EventSource: MockEventSource,
        __agentForgeSseSourceCount() {
          return sources.length;
        },
        __openAgentForgeSse() {
          for (const source of sources) {
            source.onopen?.(new Event('open'));
          }
        },
        __errorAgentForgeSse() {
          for (const source of sources) {
            source.onerror?.(new Event('error'));
          }
        },
      });
    },
    { mockEvents: events, mockOptions: options },
  );
}

async function openMockSse(page: Page) {
  await page.waitForFunction(() => {
    const count = (window as unknown as { __agentForgeSseSourceCount?: () => number })
      .__agentForgeSseSourceCount?.() ?? 0;
    return count > 0;
  });
  await page.evaluate(() => {
    (window as unknown as { __openAgentForgeSse: () => void }).__openAgentForgeSse();
  });
}

async function errorMockSse(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __errorAgentForgeSse: () => void }).__errorAgentForgeSse();
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CYCLE_EVENTS = [
  {
    id: 'evt-audit-1',
    type: 'cycle_event',
    category: 'phase.start',
    message: 'abcdef12 · phase.start · audit',
    timestamp: '2026-04-07T10:00:00.000Z',
    data: { cycleId: 'abcdef1234567890', type: 'phase.start', phase: 'audit', at: '2026-04-07T10:00:00.000Z' },
  },
  {
    id: 'evt-execute-1',
    type: 'cycle_event',
    category: 'phase.result',
    message: 'abcdef12 · phase.result · execute',
    timestamp: '2026-04-07T10:01:00.000Z',
    data: { cycleId: 'abcdef1234567890', type: 'phase.result', phase: 'execute', at: '2026-04-07T10:01:00.000Z' },
  },
  {
    id: 'evt-learn-1',
    type: 'cycle_event',
    category: 'phase.result',
    message: 'abcdef12 · phase.result · learn',
    timestamp: '2026-04-07T10:02:00.000Z',
    data: { cycleId: 'abcdef1234567890', type: 'phase.result', phase: 'learn', at: '2026-04-07T10:02:00.000Z' },
  },
];

const MIXED_EVENTS = [
  ...CYCLE_EVENTS,
  {
    id: 'evt-agent-1',
    type: 'agent_activity',
    category: 'task',
    message: 'Architect completed plan phase',
    timestamp: '2026-04-07T10:00:30.000Z',
    data: {},
  },
  {
    id: 'evt-cost-1',
    type: 'cost_event',
    category: 'usage',
    message: '$0.42 spent in last cycle',
    timestamp: '2026-04-07T10:02:30.000Z',
    data: {},
  },
];

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Live Feed Page (/live)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('/api/v5/workspaces', route => fulfillJson(route, { data: [] }));
    await page.route('/api/v5/agents', route => fulfillJson(route, { data: [] }));
    await page.route('**/api/v5/sessions**', route => fulfillJson(route, { data: [] }));
    await page.route('/api/v5/costs', route => fulfillJson(route, { data: [] }));
    await page.route('/api/v5/health', route => fulfillJson(route, { data: { status: 'ok' } }));
    await page.route('/api/v5/cycle-sessions', route => fulfillJson(route, { data: [] }));
  });

  // -------------------------------------------------------------------------
  // Page structure
  // -------------------------------------------------------------------------

  test.describe('page structure', () => {
    test('displays the correct page title', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');
      await expect(page).toHaveTitle(/Live Feed — AgentForge/i);
    });

    test('displays the Live Activity Feed heading', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');

      const heading = page.locator('h1').filter({ hasText: /Live Activity Feed/i });
      await expect(heading).toBeVisible();
    });

    test('displays subtitle mentioning real-time events', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');

      const subtitle = page.locator('p').filter({ hasText: /real.time/i }).first();
      await expect(subtitle).toBeVisible();
    });

    test('displays the feed container', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');

      const feedContainer = page.locator('.feed-container');
      await expect(feedContainer).toBeVisible();
    });

    test('shows empty state when no events have arrived', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');

      // Wait for mount and mock EventSource to fire onopen
      await page.waitForTimeout(200);

      const emptyState = page.locator('.empty-state');
      await expect(emptyState).toBeVisible();

      // Should contain "Waiting for events" copy
      await expect(emptyState).toContainText(/Waiting for events/i);
    });

    test('has event type filter dropdown with cycle_event option', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');

      const filterSelect = page.locator('#type-filter');
      await expect(filterSelect).toBeVisible();

      // Verify cycle_event is a filter option
      const cycleOption = filterSelect.locator('option[value="cycle_event"]');
      await expect(cycleOption).toHaveText('Cycle Events');
    });
  });

  // -------------------------------------------------------------------------
  // SSE connection indicator
  // -------------------------------------------------------------------------

  test.describe('SSE connection state', () => {
    test('shows live status dot when connected', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');
      await openMockSse(page);

      const liveDot = page.locator('.status-dot.live');
      await expect(liveDot).toBeVisible();

      const statusLabel = page.locator('.status-label');
      await expect(statusLabel).toHaveText('Live');
    });

    test('shows reconnect warning when the SSE connection drops', async ({ page }) => {
      await injectMockEventSource(page, []);
      await page.goto('/live');
      await openMockSse(page);
      await errorMockSse(page);

      await expect(page.locator('.status-label')).toHaveText('Reconnecting…');
      await expect(page.locator('.reconnect-banner')).toContainText('reconnecting automatically');
    });
  });

  // -------------------------------------------------------------------------
  // cycle_event rendering
  // -------------------------------------------------------------------------

  test.describe('cycle_event message rendering', () => {
    test('renders cycle_event rows in the feed', async ({ page }) => {
      await injectMockEventSource(page, CYCLE_EVENTS);
      await page.goto('/live');

      // Wait for all 3 mock events to be delivered (80ms open + 3×40ms = 200ms)
      await page.waitForTimeout(350);

      const rows = page.locator('.feed-row');
      await expect(rows).toHaveCount(3);
    });

    test('cycle_event row displays a CYCLE type badge', async ({ page }) => {
      await injectMockEventSource(page, [CYCLE_EVENTS[0]]);
      await page.goto('/live');

      await page.waitForTimeout(250);

      const typeBadge = page.locator('.feed-row .type-badge').first();
      await expect(typeBadge).toBeVisible();
      await expect(typeBadge).toHaveText('Cycle');
    });

    test('cycle_event type badge is styled with --color-sonnet CSS variable', async ({ page }) => {
      await injectMockEventSource(page, [CYCLE_EVENTS[0]]);
      await page.goto('/live');

      await page.waitForTimeout(250);

      const typeBadge = page.locator('.feed-row .type-badge').first();

      // Inline style is generated from TYPE_COLORS['cycle_event'] = 'var(--color-sonnet, var(--color-info))'
      // The badge background/color/border should reference this CSS variable
      const inlineStyle = await typeBadge.getAttribute('style');
      expect(inlineStyle).toBeTruthy();
      expect(inlineStyle).toContain('--color-sonnet');
    });

    test('cycle_event row displays the category tag', async ({ page }) => {
      await injectMockEventSource(page, [CYCLE_EVENTS[0]]);
      await page.goto('/live');

      await page.waitForTimeout(250);

      // The live page shows the formatCategory()-transformed label in .category-tag, not
      // the raw category string. For cycle_event, 'phase.start' maps to 'Phase →'
      // (see CYCLE_CATEGORY_LABELS in +page.svelte and the matching unit test in
      // live-feed-rendering.test.ts → formatCategory → 'maps "phase.start" → "Phase →"').
      const categoryTag = page.locator('.feed-row .category-tag').first();
      await expect(categoryTag).toBeVisible();
      await expect(categoryTag).toHaveText('Phase →');
    });

    test('cycle_event row displays the event message', async ({ page }) => {
      await injectMockEventSource(page, [CYCLE_EVENTS[0]]);
      await page.goto('/live');

      await page.waitForTimeout(250);

      const messageSpan = page.locator('.feed-row .event-message').first();
      await expect(messageSpan).toBeVisible();
      await expect(messageSpan).toHaveText('abcdef12 · phase.start · audit');
    });

    test('cycle_event row displays a formatted timestamp', async ({ page }) => {
      await injectMockEventSource(page, [CYCLE_EVENTS[0]]);
      await page.goto('/live');

      await page.waitForTimeout(250);

      const timestampSpan = page.locator('.feed-row .timestamp').first();
      await expect(timestampSpan).toBeVisible();

      // formatTime('2026-04-07T10:00:00.000Z') → '10:00:00' (24h format)
      const timestampText = await timestampSpan.textContent();
      expect(timestampText?.trim()).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    test('multiple cycle_event rows render in arrival order', async ({ page }) => {
      await injectMockEventSource(page, CYCLE_EVENTS);
      await page.goto('/live');

      await expect(page.locator('.feed-row')).toHaveCount(3);

      const messages = page.locator('.feed-row .event-message');
      const texts = await messages.allTextContents();

      expect(texts[0]).toContain('phase.start · audit');
      expect(texts[1]).toContain('phase.result · execute');
      expect(texts[2]).toContain('phase.result · learn');
    });
  });

  // -------------------------------------------------------------------------
  // Event type filter
  // -------------------------------------------------------------------------

  test.describe('event type filter', () => {
    test('filter to cycle_event shows only cycle rows', async ({ page }) => {
      await injectMockEventSource(page, MIXED_EVENTS);
      await page.goto('/live');

      // Wait for all 5 events to land
      await expect(page.locator('.feed-row')).toHaveCount(5);

      // All 5 events should be visible initially
      let rows = page.locator('.feed-row');
      await expect(rows).toHaveCount(5);

      // Apply cycle_event filter
      await page.selectOption('#type-filter', 'cycle_event');

      // Only 3 cycle_event rows should remain visible
      rows = page.locator('.feed-row');
      await expect(rows).toHaveCount(3);

      // Each remaining badge should read "Cycle"
      const badges = page.locator('.feed-row .type-badge');
      for (let i = 0; i < 3; i++) {
        await expect(badges.nth(i)).toHaveText('Cycle');
      }
    });

    test('event count reflects filter selection', async ({ page }) => {
      await injectMockEventSource(page, MIXED_EVENTS);
      await page.goto('/live');

      await page.waitForTimeout(500);

      // All events count
      const eventCount = page.locator('.event-count');
      await expect(eventCount).toContainText('5');

      // Filter to cycle_event
      await page.selectOption('#type-filter', 'cycle_event');
      await expect(eventCount).toContainText('3');
    });

    test('clearing filter back to all restores all events', async ({ page }) => {
      await injectMockEventSource(page, MIXED_EVENTS);
      await page.goto('/live');

      await page.waitForTimeout(500);

      // Filter down
      await page.selectOption('#type-filter', 'cycle_event');
      await expect(page.locator('.feed-row')).toHaveCount(3);

      // Restore to all
      await page.selectOption('#type-filter', 'all');
      await expect(page.locator('.feed-row')).toHaveCount(5);
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat filtering
  // -------------------------------------------------------------------------

  test.describe('heartbeat filtering', () => {
    test('heartbeat system events do not appear in the feed', async ({ page }) => {
      const eventsWithHeartbeat = [
        {
          id: 'hb-1',
          type: 'system',
          category: 'system',
          message: 'heartbeat',
          timestamp: '2026-04-07T10:00:00.000Z',
        },
        CYCLE_EVENTS[0],
      ];

      await injectMockEventSource(page, eventsWithHeartbeat);
      await page.goto('/live');

      await page.waitForTimeout(300);

      // Only 1 row — the heartbeat should be filtered out by the page's onmessage handler
      const rows = page.locator('.feed-row');
      await expect(rows).toHaveCount(1);

      // Verify the remaining row is the cycle_event
      const badge = rows.first().locator('.type-badge');
      await expect(badge).toHaveText('Cycle');
    });
  });

  // -------------------------------------------------------------------------
  // Clear button
  // -------------------------------------------------------------------------

  test.describe('clear feed', () => {
    test('clear button removes all events from the feed', async ({ page }) => {
      await injectMockEventSource(page, CYCLE_EVENTS);
      await page.goto('/live');

      await page.waitForTimeout(350);
      await expect(page.locator('.feed-row')).toHaveCount(3);

      // Click clear
      await page.click('button:has-text("Clear")');

      // Feed should be empty
      await expect(page.locator('.empty-state')).toBeVisible();
      await expect(page.locator('.feed-row')).toHaveCount(0);
    });
  });
});
