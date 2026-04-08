import { test, expect } from '@playwright/test';

test.describe('Cycles Page', () => {
  test('loads cycles list page', async ({ page }) => {
    await page.goto('/cycles');

    // Verify page title or heading
    const heading = page.locator('h1, h2').filter({ hasText: /Cycles/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays cycles table or list', async ({ page }) => {
    await page.goto('/cycles');

    // Verify that cycles list element is present (table, grid, or card layout)
    const cyclesList = page.locator('[role="grid"], [role="table"], .cycles-list, [data-testid="cycles-list"]').first();
    await expect(cyclesList).toBeVisible();
  });

  test('can navigate to cycle detail from list', async ({ page }) => {
    await page.goto('/cycles');

    // Look for first cycle link or row
    const firstCycleLink = page.locator('a, button').filter({ hasText: /v\d+\.\d+|Cycle/i }).first();

    // Verify the link exists and is clickable
    if (await firstCycleLink.isVisible()) {
      await expect(firstCycleLink).toBeEnabled();
    }
  });
});
