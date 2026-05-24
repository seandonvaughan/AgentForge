import { test, expect, type Page, type Route } from '@playwright/test';

type StreamEvent = {
  id?: string;
  type: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
};

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function injectMockEventSource(page: Page) {
  await page.addInitScript(() => {
    const sources: Array<{
      onopen: ((e: Event) => void) | null;
      onmessage: ((e: MessageEvent) => void) | null;
      onerror: ((e: Event) => void) | null;
      close: () => void;
    }> = [];

    class MockEventSource {
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      readyState = 0;

      constructor(_url: string) {
        sources.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event('open'));
        }, 10);
      }

      close() {
        this.readyState = 2;
      }
    }

    Object.assign(window, {
      __agentForgeLiveSourceCount() {
        return sources.length;
      },
      EventSource: MockEventSource,
      __emitAgentForgeLiveEvent(event: StreamEvent) {
        for (const source of sources) {
          source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
        }
      },
      __emitAgentForgeLiveRaw(raw: string) {
        for (const source of sources) {
          source.onmessage?.(new MessageEvent('message', { data: raw }));
        }
      },
      __errorAgentForgeLive() {
        for (const source of sources) {
          source.onerror?.(new Event('error'));
        }
      },
    });
  });
}

async function waitForLiveSource(page: Page) {
  await page.waitForFunction(() => {
    const count = (window as unknown as { __agentForgeLiveSourceCount?: () => number })
      .__agentForgeLiveSourceCount?.() ?? 0;
    return count > 0;
  });
}

async function emitEvent(page: Page, event: StreamEvent) {
  await page.evaluate((payload) => {
    (window as unknown as { __emitAgentForgeLiveEvent: (e: StreamEvent) => void }).__emitAgentForgeLiveEvent(payload);
  }, event);
}

async function emitRaw(page: Page, raw: string) {
  await page.evaluate((payload) => {
    (window as unknown as { __emitAgentForgeLiveRaw: (raw: string) => void }).__emitAgentForgeLiveRaw(payload);
  }, raw);
}

async function emitError(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __errorAgentForgeLive: () => void }).__errorAgentForgeLive();
  });
}

test.describe('Live Feed Page (/live)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('/api/v5/workspaces', (route) => fulfillJson(route, { data: [] }));
    await page.route('/api/v5/agents', (route) => fulfillJson(route, { data: [] }));
    await page.route('**/api/v5/sessions**', (route) => fulfillJson(route, { data: [] }));
    await page.route('/api/v5/costs', (route) => fulfillJson(route, { data: [] }));
    await page.route('/api/v5/health', (route) => fulfillJson(route, { data: { status: 'ok' } }));
    await page.route('/api/v5/cycle-sessions', (route) => fulfillJson(route, { data: [] }));
    await injectMockEventSource(page);
  });

  test('loads title, heading, and empty state', async ({ page }) => {
    await page.goto('/live');

    await expect(page).toHaveTitle(/Live Feed - AgentForge|Live Feed — AgentForge/i);
    await expect(page.locator('h1.af2-page-title')).toHaveText(/live activity feed/i);
    await expect(page.locator('.empty-state')).toContainText(/waiting for events/i);
  });

  test('shows reconnecting status and banner after stream failure', async ({ page }) => {
    await page.goto('/live');

    await waitForLiveSource(page);
    await expect(page.locator('.live-label')).toContainText(/live/i);
    await emitError(page);

    await expect(page.locator('.live-label')).toContainText(/reconnecting/i);
    await expect(page.locator('.banner--info')).toContainText(/reconnecting automatically/i);
  });

  test('renders cycle events with badge, category label, and message', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await emitEvent(page, {
      id: 'evt-cycle-1',
      type: 'cycle_event',
      category: 'phase.start',
      message: 'abcdef12 · phase.start · audit',
      timestamp: '2026-04-07T10:00:00.000Z',
      data: { cycleId: 'abcdef1234567890' },
    });

    await expect(page.locator('.feed-row')).toHaveCount(1);
    await expect(page.locator('.feed-row .feed-badge-wrap')).toContainText('Cycle');
    await expect(page.locator('.feed-row .feed-cat')).toContainText('Phase');
    await expect(page.locator('.feed-row .feed-msg')).toContainText('phase.start · audit');
  });

  test('cycle filter chip narrows list to cycle events only', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await emitEvent(page, { id: 'evt-1', type: 'cycle_event', category: 'phase.result', message: 'cycle msg', timestamp: '2026-04-07T10:00:00.000Z' });
    await emitEvent(page, { id: 'evt-2', type: 'agent_activity', category: 'run', message: 'agent msg', timestamp: '2026-04-07T10:00:05.000Z' });
    await emitEvent(page, { id: 'evt-3', type: 'cost_event', category: 'usage', message: 'cost msg', timestamp: '2026-04-07T10:00:10.000Z' });

    await expect(page.locator('.feed-row')).toHaveCount(3);
    await expect(page.locator('.event-count')).toContainText('3 events');

    await page.click('.chip:has-text("cycle.*")');

    await expect(page.locator('.feed-row')).toHaveCount(1);
    await expect(page.locator('.event-count')).toContainText('1 events');
    await expect(page.locator('.feed-row .feed-badge-wrap')).toContainText('Cycle');
  });

  test('filters out heartbeat system messages', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await emitEvent(page, {
      id: 'hb-1',
      type: 'system',
      category: 'system',
      message: 'heartbeat',
      timestamp: '2026-04-07T10:00:00.000Z',
    });
    await emitEvent(page, {
      id: 'evt-visible',
      type: 'cycle_event',
      category: 'phase.complete',
      message: 'visible cycle event',
      timestamp: '2026-04-07T10:00:01.000Z',
    });

    await expect(page.locator('.feed-row')).toHaveCount(1);
    await expect(page.locator('.feed-row .feed-msg')).toContainText('visible cycle event');
  });

  test('pause mode drops incoming events until resumed', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await page.click('button:has-text("Pause")');
    await emitEvent(page, {
      id: 'evt-paused-1',
      type: 'cycle_event',
      category: 'phase.start',
      message: 'should be dropped',
      timestamp: '2026-04-07T10:00:00.000Z',
    });

    await expect(page.locator('.feed-row')).toHaveCount(0);
    await page.click('button:has-text("Resume")');

    await emitEvent(page, {
      id: 'evt-resumed-1',
      type: 'cycle_event',
      category: 'phase.complete',
      message: 'should be visible',
      timestamp: '2026-04-07T10:00:01.000Z',
    });

    await expect(page.locator('.feed-row')).toHaveCount(1);
    await expect(page.locator('.feed-row .feed-msg')).toContainText('should be visible');
  });

  test('caps retained events at 500 to prevent unbounded feed growth', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await page.evaluate(() => {
      const emit = (window as unknown as {
        __emitAgentForgeLiveEvent: (event: StreamEvent) => void;
      }).__emitAgentForgeLiveEvent;
      for (let i = 0; i < 520; i += 1) {
        emit({
          id: `evt-bulk-${i}`,
          type: 'agent_activity',
          category: 'run',
          message: `bulk-${i}`,
          timestamp: '2026-04-07T10:00:00.000Z',
        });
      }
    });

    await expect(page.locator('.feed-row')).toHaveCount(500);
    await expect(page.locator('.event-count')).toContainText('500 events');
    await expect(page.locator('.feed-row .feed-msg').first()).toContainText('bulk-20');
    await expect(page.locator('.feed-row .feed-msg').last()).toContainText('bulk-519');
    await expect(page.locator('.feed-row .feed-msg', { hasText: 'bulk-0' })).toHaveCount(0);
  });

  test('ignores malformed stream payloads without crashing the page', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await emitRaw(page, '{bad json');

    await expect(page.locator('.feed-row')).toHaveCount(0);
    await expect(page.locator('.empty-state')).toContainText(/waiting for events/i);
  });

  test('shows refresh banner when refresh_signal arrives', async ({ page }) => {
    await page.goto('/live');
    await waitForLiveSource(page);

    await emitEvent(page, {
      id: 'refresh-1',
      type: 'refresh_signal',
      category: 'system',
      message: 'refresh requested',
      timestamp: '2026-04-07T10:00:02.000Z',
    });

    await expect(page.locator('.banner--warn')).toContainText(/new updates available/i);
  });
});
