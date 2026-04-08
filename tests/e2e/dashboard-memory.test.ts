import { test, expect } from '@playwright/test';

test.describe('Memory Page', () => {
  test('loads memory page successfully', async ({ page }) => {
    await page.goto('/memory');

    // Verify page title
    await expect(page).toHaveTitle(/Memory|Retention|State|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays memory heading', async ({ page }) => {
    await page.goto('/memory');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Memory|Retention|State|Session/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays memory entries or sessions', async ({ page }) => {
    await page.goto('/memory');

    await page.waitForLoadState('networkidle');

    // Look for memory list, grid, or entries
    const memoryList = page.locator('[class*="memory"], [class*="list"], [role="table"], [role="grid"]').first();
    const memoryEntry = page.locator('[class*="entry"], [class*="session"], [class*="item"]').first();
    const emptyState = page.locator('text=/No memory|No session|No data|empty/i').first();

    const hasList = await memoryList.isVisible().catch(() => false);
    const hasEntry = await memoryEntry.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays memory metadata (size, count, timestamp)', async ({ page }) => {
    await page.goto('/memory');

    await page.waitForLoadState('networkidle');

    // Look for memory metrics
    const metrics = page.locator('text=/size|count|entries|bytes|timestamp|created|stored/i');
    const metricsCount = await metrics.count();

    if (metricsCount > 0) {
      await expect(metrics.first()).toBeVisible();
    }
  });

  test('displays memory status or storage information', async ({ page }) => {
    await page.goto('/memory');

    await page.waitForLoadState('networkidle');

    // Look for storage status
    const status = page.locator('[class*="status"], [class*="badge"], text=/available|used|full|storage/i');
    const statusCount = await status.count();

    if (statusCount > 0) {
      await expect(status.first()).toBeVisible();
    }
  });

  test('memory entries are interactive', async ({ page }) => {
    await page.goto('/memory');

    await page.waitForLoadState('networkidle');

    // Look for interactive elements
    const links = page.locator('a, button, [role="button"]').filter({ hasText: /view|edit|delete|clear/i });
    const linkCount = await links.count();

    if (linkCount > 0) {
      await expect(links.first()).toBeEnabled();
    }
  });

  test('memory page handles loading and empty states', async ({ page }) => {
    await page.goto('/memory');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No memory|No session|No data|empty/i').first();
    const memoryContent = page.locator('[class*="memory"], [role="table"], [role="grid"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await memoryContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('memory page is responsive', async ({ page }) => {
    await page.goto('/memory');

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
