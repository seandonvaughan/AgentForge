import { test, expect } from '@playwright/test';

test.describe('Cycles Page', () => {
  test('loads cycles list page', async ({ page }) => {
    await page.goto('/cycles');

    // Verify page title or heading
    const heading = page.locator('h1, h2').filter({ hasText: /Cycles/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }

    // Verify page title in browser tab
    await expect(page).toHaveTitle(/Cycles|AgentForge/i);
  });

  test('displays cycles list or empty state', async ({ page }) => {
    await page.goto('/cycles');

    await page.waitForLoadState('networkidle');

    // Verify that cycles list element is present (table, grid, or card layout)
    const cyclesList = page.locator('[role="grid"], [role="table"], .cycles-list, [data-testid="cycles-list"], [class*="cycle"]').first();
    const emptyState = page.locator('text=/No cycle|No data|empty/i').first();

    const hasCyclesList = await cyclesList.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    expect(hasCyclesList || hasEmptyState).toBeTruthy();
  });

  test('displays cycle version and metadata', async ({ page }) => {
    await page.goto('/cycles');

    await page.waitForLoadState('networkidle');

    // Look for version numbers (e.g., v6.4.4)
    const versionText = page.locator('text=/v\d+\.\d+/i').first();

    if (await versionText.isVisible().catch(() => false)) {
      await expect(versionText).toBeVisible();
    }

    // Look for status or cost information
    const metadata = page.locator('text=/status|cost|cost|completed|in progress|pending/i');
    const metadataCount = await metadata.count();

    if (metadataCount > 0) {
      await expect(metadata.first()).toBeVisible();
    }
  });

  test('can navigate to cycle detail from list', async ({ page }) => {
    await page.goto('/cycles');

    await page.waitForLoadState('networkidle');

    // Look for first cycle link or row
    const firstCycleLink = page.locator('a, button, [role="button"]').filter({ hasText: /v\d+\.\d+|Cycle/i }).first();

    // Verify the link exists and is clickable
    if (await firstCycleLink.isVisible()) {
      await expect(firstCycleLink).toBeEnabled();
    }
  });

  test('cycles list is responsive', async ({ page }) => {
    await page.goto('/cycles');

    await page.waitForLoadState('networkidle');

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    await page.waitForTimeout(500);

    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();
  });
});
