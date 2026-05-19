import { test, expect, type Route } from '@playwright/test';

test.describe('Cycle Launch Page', () => {
  test('submits Codex launch settings and redirects to the new cycle', async ({ page }) => {
    let postedBody: Record<string, unknown> | undefined;

    await page.route(/\/api\/v5\/cycles(?:\?.*)?$/, async (route: Route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        postedBody = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ cycleId: 'pw-cycle-001' }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ cycles: [] }),
      });
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

    await expect(page).toHaveURL(/\/cycles\/pw-cycle-001$/, { timeout: 15_000 });
  });
});
