import { test, expect, type Page, type Route } from '@playwright/test';

const LAUNCHED_CYCLE_ID = 'pw-cycle-001';

function cycleFixture() {
  return {
    cycleId: LAUNCHED_CYCLE_ID,
    lastHeartbeatAt: new Date().toISOString(),
    stage: 'run',
    runtimeMode: 'codex-cli',
    branchPrefix: 'codex/',
    baseBranch: 'codex/codex-version',
    dryRun: true,
    maxAgents: 1,
    modelCap: 'haiku',
    effortCap: 'medium',
    fallbackEnabled: true,
    startedAt: new Date().toISOString(),
    sprintVersion: '10.12.0',
    cost: { totalUsd: 0, budgetUsd: 18 },
    tests: { passed: 0, failed: 0, skipped: 0, total: 0, newFailures: [] },
    git: { branch: '', commitSha: null, filesChanged: [] },
    pr: { url: null, number: null, draft: false },
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockRedirectedCycleDetail(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readyState = 0;

      constructor(public url: string) {
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event('open'));
        }, 10);
      }

      close() {
        this.readyState = 2;
      }
    }

    Object.assign(window, { EventSource: MockEventSource });
  });

  await page.route((url) => url.pathname.startsWith(`/api/v5/cycles/${LAUNCHED_CYCLE_ID}`), async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith('/sprint')) {
      await fulfillJson(route, { sprint: { version: '10.12.0', title: 'Mock sprint', items: [] } });
      return;
    }

    if (path.endsWith('/agents')) {
      await fulfillJson(route, { runs: [], byAgent: {}, totalCostUsd: 0, totalRuns: 0 });
      return;
    }

    if (path.endsWith('/events')) {
      await fulfillJson(route, { events: [], total: 0 });
      return;
    }

    if (path.endsWith('/prs')) {
      await fulfillJson(route, {
        data: [],
        meta: {
          cycleId: LAUNCHED_CYCLE_ID,
          total: 0,
          counts: { open: 0, merged: 0, closed: 0, pending: 0 },
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    if (
      path.endsWith('/scoring') ||
      path.endsWith('/decomposition') ||
      path.endsWith('/epic-review') ||
      path.endsWith('/spend-report') ||
      path.includes('/files/') ||
      path.includes('/logs/') ||
      path.includes('/cost-breakdown')
    ) {
      await route.fulfill({ status: 404 });
      return;
    }

    await fulfillJson(route, cycleFixture());
  });

  await page.route((url) => {
    return url.pathname === '/api/v5/quality/step-scores' &&
      url.searchParams.get('cycle_id') === LAUNCHED_CYCLE_ID;
  }, async (route) => {
    await fulfillJson(route, { cycleId: LAUNCHED_CYCLE_ID, scores: [] });
  });
}

test.describe('Cycle Launch Page', () => {
  test('submits Codex launch settings and redirects to the new cycle', async ({ page }) => {
    let postedBody: Record<string, unknown> | undefined;

    await mockRedirectedCycleDetail(page);

    await page.route(/\/api\/v5\/cycles(?:\?.*)?$/, async (route: Route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        postedBody = request.postDataJSON() as Record<string, unknown>;
        await fulfillJson(route, { cycleId: LAUNCHED_CYCLE_ID }, 202);
        return;
      }

      await fulfillJson(route, { cycles: [] });
    });

    await page.goto('/cycles/new');
    await expect(page.locator('h1')).toHaveText('Launch autonomous cycle');
    await expect(page.getByRole('button', { name: /Run Cycle/ })).toBeEnabled();

    await page.getByLabel('Budget in USD').fill('18');
    await page.getByLabel('Max items per sprint').fill('2');
    await page.locator('input[aria-label="Max agents"]').fill('1');
    await page.locator('#branchPrefix').fill('codex/');
    await page.locator('#baseBranch').fill('codex/codex-version');
    await page.locator('#modelCap').selectOption('haiku');
    await page.locator('#effortCap').selectOption('medium');
    await page.locator('#tagsInput').fill('playwright dashboard');
    await page.locator('#comment').fill('Playwright verification launch');
    await page.locator('.toggle').filter({ hasText: 'Dry run' }).click();

    const detailNavigation = page.waitForURL(
      (url) => url.pathname === `/cycles/${LAUNCHED_CYCLE_ID}`,
      { timeout: 45_000 },
    );

    await page.getByRole('button', { name: /Run Cycle/ }).click();

    await expect.poll(() => postedBody).toBeTruthy();
    expect(postedBody).toMatchObject({
      budgetUsd: 18,
      maxItems: 2,
      maxAgents: 1,
      dryRun: true,
      branchPrefix: 'codex/',
      baseBranch: 'codex/codex-version',
      comment: 'Playwright verification launch',
      tags: ['playwright', 'dashboard'],
      modelCap: 'haiku',
      effortCap: 'medium',
      fallbackEnabled: true,
    });

    await detailNavigation;
  });
});
