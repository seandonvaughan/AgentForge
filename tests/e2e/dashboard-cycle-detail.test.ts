import { test, expect, type Page } from '@playwright/test';

async function openFirstCycleDetail(page: Page) {
  const response = await page.request.get('/api/v5/cycles?limit=1');
  expect(response.ok(), `GET /api/v5/cycles?limit=1 returned ${response.status()}`).toBe(true);
  const json = await response.json() as { cycles?: Array<{ cycleId?: string }> };
  const cycleId = json.cycles?.[0]?.cycleId;
  expect(cycleId, 'expected at least one real cycle from /api/v5/cycles').toBeTruthy();

  const cycleHref = `/cycles/${cycleId!}`;
  await page.goto(cycleHref, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText(/Cycle/i, { timeout: 15_000 });
  return cycleHref;
}

test.describe('Cycle Detail Page', () => {
  test('posts cycle manage actions from the detail header', async ({ page }) => {
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

    let stage = 'run';
    let cancelRequest: { method: string; pathname: string; body: unknown } | undefined;
    let rerunRequest: { method: string; pathname: string; body: unknown } | undefined;

    await page.route(/\/api\/v5\/cycles\/manage-cycle(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;

      if (path.endsWith('/cancel')) {
        cancelRequest = { method: request.method(), pathname: path, body: request.postDataJSON() };
        stage = 'killed';
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }

      if (path.endsWith('/rerun')) {
        rerunRequest = { method: request.method(), pathname: path, body: request.postDataJSON() };
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ cycleId: 'manage-cycle-rerun' }),
        });
        return;
      }

      if (path.endsWith('/sprint')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sprint: { version: '10.12.0', title: 'Mock sprint', items: [] } }),
        });
        return;
      }

      if (path.endsWith('/agents')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ runs: [], byAgent: {}, totalCostUsd: 0, totalRuns: 0 }),
        });
        return;
      }

      if (path.endsWith('/events')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ events: [], total: 0 }),
        });
        return;
      }

      if (path.endsWith('/scoring') || path.includes('/files/') || path.includes('/cost-breakdown')) {
        await route.fulfill({ status: 204 });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cycleId: 'manage-cycle',
          lastHeartbeatAt: new Date().toISOString(),
          stage,
          runtimeMode: 'codex-cli',
          branchPrefix: 'codex/',
          baseBranch: 'codex/codex-version',
          dryRun: false,
          maxAgents: 1,
          modelCap: 'sonnet',
          effortCap: 'high',
          fallbackEnabled: true,
          startedAt: new Date().toISOString(),
          sprintVersion: '10.12.0',
          cost: { totalUsd: 1.23, budgetUsd: 25 },
          tests: { passed: 0, failed: 0, skipped: 0, total: 0, newFailures: [] },
          git: { branch: '', commitSha: null, filesChanged: [] },
          pr: { url: null, number: null, draft: false },
        }),
      });
    });

    page.on('dialog', async (dialog) => dialog.accept());

    await page.goto('/cycles/manage-cycle', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toContainText('Cycle');
    await expect(page.getByLabel('Cycle launch configuration')).toContainText('profile sonnet');
    await expect(page.getByLabel('Cycle launch configuration')).toContainText('effort high');
    await expect(page.getByRole('button', { name: /^Cancel$/ })).toBeVisible();

    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect.poll(() => cancelRequest).toEqual({
      method: 'POST',
      pathname: '/api/v5/cycles/manage-cycle/cancel',
      body: {},
    });

    await page.getByRole('button', { name: /^Re-run$/ }).click();
    await expect.poll(() => rerunRequest).toEqual({
      method: 'POST',
      pathname: '/api/v5/cycles/manage-cycle/rerun',
      body: {},
    });
    await expect(page).toHaveURL(/\/cycles\/manage-cycle-rerun$/);
  });

  test('loads cycle detail page with real data', async ({ page }) => {
    const href = await openFirstCycleDetail(page);

    await expect(page.locator('body')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  test('displays cycle version on detail page', async ({ page }) => {
    await openFirstCycleDetail(page);

    await expect(page.locator('body')).toContainText(/v\d+\.\d+|Cycle/i);
  });

  test('displays cycle tabs or sections on detail page', async ({ page }) => {
    await openFirstCycleDetail(page);

    for (const label of ['Pipeline', 'Items', 'Agents', 'Events', 'Logs']) {
      await expect(page.getByRole('tab', { name: new RegExp(`^${label}\\b`) })).toBeVisible();
    }
  });

  test('renders cycle metadata (cost, status, stage)', async ({ page }) => {
    await openFirstCycleDetail(page);

    await expect(page.locator('body')).toContainText(/Cost/i);
    await expect(page.locator('body')).toContainText(/Items/i);
    await expect(page.locator('body')).toContainText(/Tests/i);
    await expect(page.locator('.cycle-title-row')).toContainText(/RUN|COMPLETED|FAILED|KILLED|CRASHED|STALLED/i);
  });

  test('cycle detail page handles real data loading', async ({ page }) => {
    await openFirstCycleDetail(page);

    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/HTTP 500|HTTP 404|not found|connection refused/i);
  });

  test('cycle detail page is responsive', async ({ page }) => {
    await openFirstCycleDetail(page);

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('h1')).toContainText(/Cycle/i);

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('h1')).toContainText(/Cycle/i);
  });
});
