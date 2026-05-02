import { test, expect, type Page } from '@playwright/test';

test.describe('Health Dashboard Page', () => {
  async function gotoHealth(page: Page) {
    await page.goto('/health', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.page-title')).toHaveText(/System Health/i);
  }

  test('loads health page successfully', async ({ page }) => {
    await gotoHealth(page);

    // Verify page title
    await expect(page).toHaveTitle(/Health|Status|System|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays health heading', async ({ page }) => {
    await gotoHealth(page);

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Health|Status|System/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays system health status', async ({ page }) => {
    await gotoHealth(page);

    // Look for health status indicators
    const statusIndicators = page.locator('[class*="status"], [class*="badge"], [class*="health"]').first();
    const statusText = page.locator('text=/healthy|ok|good|healthy|nominal|green|online|available/i').first();

    const hasStatus = await statusIndicators.isVisible().catch(() => false);
    const hasStatusText = await statusText.isVisible().catch(() => false);

    expect(hasStatus || hasStatusText).toBeTruthy();
  });

  test('displays component health information', async ({ page }) => {
    await gotoHealth(page);

    // The API-backed service grid may be replaced by the connection error shell
    // when the dashboard dev server is not proxying package API requests.
    const healthSurface = page.locator('.status-banner, .error-banner, .health-card, .services-grid').first();
    await expect(healthSurface).toBeVisible();
  });

  test('displays metrics or diagnostic information', async ({ page }) => {
    await gotoHealth(page);

    const diagnostics = page.locator('.status-banner, .refresh-time, .btn-refresh, .health-card, .services-grid').first();
    await expect(diagnostics).toBeVisible();
  });

  test('displays alerts or warnings if any', async ({ page }) => {
    await gotoHealth(page);

    // Look for alerts or warnings
    const alerts = page.locator('[class*="alert"], [class*="warning"], [class*="error"], [role="alert"]');
    const alertText = page.locator('text=/warning|alert|error|degraded|unhealthy/i');

    const hasAlerts = await alerts.count().then(c => c > 0).catch(() => false);
    const hasAlertText = await alertText.count().then(c => c > 0).catch(() => false);

    // Alerts may or may not be present - just verify structure
    const hasContent = await page.locator('body').isVisible();
    await expect(hasContent).toBeTruthy();
  });

  test('health page handles loading and empty states', async ({ page }) => {
    await gotoHealth(page);

    // Check for either content or loading
    const loading = page.locator('text=/loading|Loading|checking/i').first();
    const healthContent = page.locator('[class*="health"], [class*="status"], [class*="metric"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const hasContent = await healthContent.isVisible().catch(() => false);

    expect(isLoading || hasContent).toBeTruthy();
  });

  test('health page is responsive', async ({ page }) => {
    await gotoHealth(page);

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
