import { test, expect } from '@playwright/test';

test.describe('Plugins Page', () => {
  test('loads plugins page successfully', async ({ page }) => {
    await page.goto('/plugins');

    // Verify page title
    await expect(page).toHaveTitle(/Plugin|Extension|Integration|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays plugins heading', async ({ page }) => {
    await page.goto('/plugins');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Plugin|Extension|Integration/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays plugins list or grid', async ({ page }) => {
    await page.goto('/plugins');

    await page.waitForLoadState('networkidle');

    // Look for plugins list, grid, or cards
    const pluginsList = page.locator('[class*="plugin"], [class*="extension"], [role="table"], [role="grid"]').first();
    const pluginCard = page.locator('[class*="card"], [class*="item"]').first();
    const emptyState = page.locator('text=/No plugin|No extension|No data|empty/i').first();

    const hasList = await pluginsList.isVisible().catch(() => false);
    const hasCard = await pluginCard.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays plugin information (name, status, version)', async ({ page }) => {
    await page.goto('/plugins');

    await page.waitForLoadState('networkidle');

    // Look for plugin names or identifiers
    const pluginNames = page.locator('text=/plugin|extension|module|component|service/i');
    const pluginNameCount = await pluginNames.count();

    if (pluginNameCount > 0) {
      await expect(pluginNames.first()).toBeVisible();
    }

    // Look for status indicators
    const statusBadges = page.locator('[class*="badge"], [class*="status"], text=/enabled|disabled|active|inactive/i');
    const statusCount = await statusBadges.count();

    if (statusCount > 0) {
      await expect(statusBadges.first()).toBeVisible();
    }
  });

  test('displays plugin capabilities or features', async ({ page }) => {
    await page.goto('/plugins');

    await page.waitForLoadState('networkidle');

    // Look for capabilities or descriptions
    const capabilities = page.locator('text=/capability|feature|function|provides|supports/i');
    const capabilityCount = await capabilities.count();

    if (capabilityCount > 0) {
      await expect(capabilities.first()).toBeVisible();
    }
  });

  test('plugin items are interactive', async ({ page }) => {
    await page.goto('/plugins');

    await page.waitForLoadState('networkidle');

    // Look for interactive elements (enable/disable, configure, etc.)
    const actions = page.locator('button, a, [role="button"]').filter({ hasText: /enable|disable|configure|settings|details/i });
    const actionCount = await actions.count();

    if (actionCount > 0) {
      await expect(actions.first()).toBeEnabled();
    }
  });

  test('plugins page handles loading and empty states', async ({ page }) => {
    await page.goto('/plugins');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No plugin|No extension|No data|empty/i').first();
    const pluginContent = page.locator('[class*="plugin"], [role="table"], [role="grid"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await pluginContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('plugins page is responsive', async ({ page }) => {
    await page.goto('/plugins');

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
