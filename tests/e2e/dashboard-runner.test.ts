import { test, expect, type Page, type Route } from '@playwright/test';

type StreamEvent = {
  type: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
};

type RunResponseOptions = {
  sessionId?: string;
  status?: number;
  responseDelayMs?: number;
};

async function injectMockEventSource(page: Page) {
  await page.addInitScript(() => {
    const sources: Array<{
      onopen: ((event: Event) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: Event) => void) | null;
      close: () => void;
    }> = [];

    class MockEventSource {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readyState = 0;

      constructor(public url: string) {
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
      EventSource: MockEventSource,
      __emitAgentForgeSse(event: StreamEvent) {
        for (const source of sources) {
          if (source.onmessage) {
            source.onmessage(new MessageEvent('message', { data: JSON.stringify(event) }));
          }
        }
      },
      __errorAgentForgeSse() {
        for (const source of sources) {
          source.onerror?.(new Event('error'));
        }
      },
    });
  });
}

async function mockRunnerApis(page: Page, options: RunResponseOptions = {}) {
  const sessionId = options.sessionId ?? 'run-test-1';
  const status = options.status ?? 202;

  await page.route('/api/v5/agents', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { agentId: 'coder', name: 'Coder', model: 'sonnet' },
          { agentId: 'architect', name: 'Architect', model: 'opus' },
        ],
      }),
    });
  });

  await page.route('/api/v5/run/history', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.route('/api/v5/run', async (route: Route) => {
    if (options.responseDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.responseDelayMs));
    }

    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          sessionId,
          agentId: 'coder',
          model: 'claude-sonnet-4-5',
          status: status === 202 ? 'running' : 'completed',
          providerKind: 'anthropic-sdk',
          runtimeModeResolved: 'sdk',
        },
      }),
    });
  });
}

async function emitSse(page: Page, event: StreamEvent) {
  await page.evaluate((payload) => {
    (window as unknown as { __emitAgentForgeSse: (event: StreamEvent) => void })
      .__emitAgentForgeSse(payload);
  }, event);
}

async function errorSse(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __errorAgentForgeSse: () => void }).__errorAgentForgeSse();
  });
}

async function openRunner(page: Page, options?: RunResponseOptions) {
  await injectMockEventSource(page);
  await mockRunnerApis(page, options);
  await page.goto('/runner');
  await expect(page.locator('h1')).toHaveText('Agent Runner');
  await expect(page.locator('#task-input')).toBeVisible();
}

test.describe('Runner Page', () => {
  test('accepts async 202 run starts and renders streamed chunks with operator metadata', async ({ page }) => {
    await openRunner(page);

    await page.fill('#task-input', 'Summarize the queue');
    await page.click('button:has-text("Run Agent")');

    await expect(page.locator('.output-header')).toContainText('Accepted');
    await expect(page.locator('.output-meta')).toContainText('Anthropic SDK');
    await expect(page.locator('.output-meta')).toContainText('SDK');
    await expect(page.locator('.latency-pill')).toContainText('Waiting for first token');

    await emitSse(page, {
      type: 'agent_activity',
      category: 'run',
      message: '[coder] chunk',
      data: { sessionId: 'run-test-1', content: 'Hello ', providerKind: 'anthropic-sdk', runtimeModeResolved: 'sdk' },
    });
    await emitSse(page, {
      type: 'agent_activity',
      category: 'run',
      message: '[coder] chunk',
      data: { sessionId: 'run-test-1', content: 'world' },
    });

    await expect(page.locator('.output-pre')).toContainText('Hello world');
    await expect(page.locator('.latency-pill')).toHaveText(/First token \d+ ms|First token \d+\.\d s/);

    await emitSse(page, {
      type: 'workflow_event',
      category: 'run',
      message: '[coder] run completed',
      data: { sessionId: 'run-test-1', status: 'completed', costUsd: 0.0123, providerKind: 'anthropic-sdk', runtimeModeResolved: 'sdk' },
    });

    await expect(page.locator('.running-indicator')).toHaveCount(0);
    await expect(page.locator('.history-item').first()).toContainText('completed');
  });

  test('replays chunks that arrive before the 202 response returns', async ({ page }) => {
    await openRunner(page, { sessionId: 'run-buffered-1', responseDelayMs: 150 });

    await page.fill('#task-input', 'Stream early');
    await page.click('button:has-text("Run Agent")');

    await emitSse(page, {
      type: 'agent_activity',
      category: 'run',
      message: '[coder] chunk',
      data: { sessionId: 'run-buffered-1', content: 'Buffered token' },
    });

    await expect(page.locator('.output-pre')).toContainText('Buffered token');
  });

  test('copies and clears streamed output', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://localhost:4751',
    });
    await openRunner(page);

    await page.fill('#task-input', 'Copy output');
    await page.click('button:has-text("Run Agent")');
    await emitSse(page, {
      type: 'agent_activity',
      category: 'run',
      message: '[coder] chunk',
      data: { sessionId: 'run-test-1', content: 'copy me' },
    });
    await emitSse(page, {
      type: 'workflow_event',
      category: 'run',
      message: '[coder] run completed',
      data: { sessionId: 'run-test-1', status: 'completed' },
    });

    await page.click('.output-actions button:has-text("Copy")');
    await expect(page.locator('.output-actions')).toContainText('Copied');
    await expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('copy me');

    await page.click('.output-actions button:has-text("Clear")');
    await expect(page.locator('.output-empty')).toContainText('Configure an agent and task');
    await expect(page.locator('.output-pre')).toHaveCount(0);
  });

  test('shows reconnect warning without ending the active run', async ({ page }) => {
    await openRunner(page);

    await page.fill('#task-input', 'Reconnect test');
    await page.click('button:has-text("Run Agent")');
    await errorSse(page);

    await expect(page.locator('.stream-warning')).toContainText('reconnecting automatically');
    await expect(page.locator('.running-indicator')).toContainText('Stream reconnecting');
  });

  test('runner page remains usable on mobile and desktop viewports', async ({ page }) => {
    await openRunner(page);

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('.runner-layout')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('.runner-layout')).toBeVisible();
  });
});
