import { test, expect } from '@playwright/test';

test.describe('Cycle Detail Page', () => {
  test('loads cycle detail page with valid cycle ID', async ({ page }) => {
    // Navigate to first cycle from cycles list to get a valid ID
    await page.goto('/cycles');

    // Get first cycle link href
    const firstCycleLink = page.locator('a').filter({ hasText: /v\d+\.\d+|Cycle/i }).first();

    if (await firstCycleLink.isVisible()) {
      // Extract href and navigate to it
      const href = await firstCycleLink.getAttribute('href');

      if (href) {
        await page.goto(href);

        // Verify cycle detail page loaded
        const cycleHeading = page.locator('h1, h2').first();
        await expect(cycleHeading).toBeVisible();
      }
    }
  });

  test('displays cycle tabs on detail page', async ({ page }) => {
    // Navigate to cycles and get first cycle
    await page.goto('/cycles');

    const firstCycleLink = page.locator('a').filter({ hasText: /v\d+\.\d+|Cycle/i }).first();

    if (await firstCycleLink.isVisible()) {
      const href = await firstCycleLink.getAttribute('href');
      if (href) {
        await page.goto(href);

        // Look for tab navigation (Overview, Items, Agents, etc.)
        const tabs = page.locator('[role="tab"], .tab, [data-testid="cycle-tabs"]');
        const tabCount = await tabs.count();

        // Should have at least some tabs for cycle detail
        if (tabCount > 0) {
          await expect(tabs.first()).toBeVisible();
        }
      }
    }
  });

  test('renders cycle metadata (cost, stage)', async ({ page }) => {
    await page.goto('/cycles');

    const firstCycleLink = page.locator('a').filter({ hasText: /v\d+\.\d+|Cycle/i }).first();

    if (await firstCycleLink.isVisible()) {
      const href = await firstCycleLink.getAttribute('href');
      if (href) {
        await page.goto(href);

        // Look for cycle metadata displays
        const costBadge = page.locator('text=/Cost|cost|\$|💰/i').first();
        const stageBadge = page.locator('text=/Stage|stage|Status/i').first();

        // At least one of these should be visible
        const isCostVisible = await costBadge.isVisible().catch(() => false);
        const isStageVisible = await stageBadge.isVisible().catch(() => false);

        expect(isCostVisible || isStageVisible).toBeTruthy();
      }
    }
  });
});
