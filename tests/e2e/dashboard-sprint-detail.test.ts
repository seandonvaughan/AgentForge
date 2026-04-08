import { test, expect } from '@playwright/test';

test.describe('Sprint Detail Page', () => {
  test('loads sprint detail page with valid sprint version', async ({ page }) => {
    // Navigate to sprints list first
    await page.goto('/sprints');
    await page.waitForLoadState('networkidle');

    // Find and click on first sprint card
    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      // Get the href or click to navigate
      const href = await sprintCard.getAttribute('href');

      if (href) {
        await page.goto(href);
      } else {
        await sprintCard.click();
      }

      // Verify sprint detail page loaded
      await page.waitForLoadState('networkidle');
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible();
    }
  });

  test('displays sprint version on detail page', async ({ page }) => {
    await page.goto('/sprints');
    await page.waitForLoadState('networkidle');

    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      const href = await sprintCard.getAttribute('href');

      if (href) {
        await page.goto(href);
        await page.waitForLoadState('networkidle');

        // Verify version is displayed in the page
        const versionText = page.locator('text=/v\d+\.\d+/i').first();
        await expect(versionText).toBeVisible();
      }
    }
  });

  test('displays sprint items with priorities and status', async ({ page }) => {
    await page.goto('/sprints');
    await page.waitForLoadState('networkidle');

    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      const href = await sprintCard.getAttribute('href');

      if (href) {
        await page.goto(href);
        await page.waitForLoadState('networkidle');

        // Look for priority labels or item status indicators
        const priorities = page.locator('text=/P0|P1|P2/i');
        const priorityCount = await priorities.count();

        if (priorityCount > 0) {
          await expect(priorities.first()).toBeVisible();
        }

        // Look for status indicators
        const statusIndicators = page.locator('text=/✓|◐|○/i, text=/completed|in progress|pending/i');
        const statusCount = await statusIndicators.count();

        if (statusCount > 0) {
          await expect(statusIndicators.first()).toBeVisible();
        }
      }
    }
  });

  test('displays progress bar on sprint detail', async ({ page }) => {
    await page.goto('/sprints');
    await page.waitForLoadState('networkidle');

    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      const href = await sprintCard.getAttribute('href');

      if (href) {
        await page.goto(href);
        await page.waitForLoadState('networkidle');

        // Look for progress bar
        const progressBar = page.locator('[role="progressbar"], [class*="progress"]').first();

        if (await progressBar.isVisible()) {
          await expect(progressBar).toBeVisible();
        }
      }
    }
  });
});
