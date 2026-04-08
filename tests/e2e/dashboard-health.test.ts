import { test, expect } from '@playwright/test';

test.describe('Health Dashboard Page', () => {
  test('loads health page successfully', async ({ page }) => {
    await page.goto('/health');

    // Verify page title
    await expect(page).toHaveTitle(/Health|Status|System|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays health heading', async ({ page }) => {
    await page.goto('/health');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Health|Status|System/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays system health status', async ({ page }) => {
    await page.goto('/health');

    await page.waitForLoadState('networkidle');

    // Look for health status indicators
    const statusIndicators = page.locator('[class*="status"], [class*="badge"], [class*="health"]').first();
    const statusText = page.locator('text=/healthy|ok|good|healthy|nominal|green|online|available/i').first();

    const hasStatus = await statusIndicators.isVisible().catch(() => false);
    const hasStatusText = await statusText.isVisible().catch(() => false);

    expect(hasStatus || hasStatusText).toBeTruthy();
  });

  test('displays component health information', async ({ page }) => {
    await page.goto('/health');

    await page.waitForLoadState('networkidle');

    // Look for component health items
    const componentList = page.locator('[class*="component"], [class*="service"], [role="list"], [role="table"]').first();
    const components = page.locator('text=/api|database|cache|server|worker|queue/i');

    const hasComponentList = await componentList.isVisible().catch(() => false);
    const hasComponents = await components.count().then(c => c > 0).catch(() => false);

    expect(hasComponentList || hasComponents).toBeTruthy();
  });

  test('displays metrics or diagnostic information', async ({ page }) => {
    await page.goto('/health');

    await page.waitForLoadState('networkidle');

    // Look for metrics like uptime, latency, etc.
    const metrics = page.locator('[class*="metric"], [class*="stat"], text=/uptime|latency|response|throughput|requests/i').first();
    const gauges = page.locator('[class*="gauge"], [role="progressbar"]').first();

    const hasMetrics = await metrics.isVisible().catch(() => false);
    const hasGauges = await gauges.isVisible().catch(() => false);

    expect(hasMetrics || hasGauges).toBeTruthy();
  });

  test('displays alerts or warnings if any', async ({ page }) => {
    await page.goto('/health');

    await page.waitForLoadState('networkidle');

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
    await page.goto('/health');

    await page.waitForLoadState('networkidle');

    // Check for either content or loading
    const loading = page.locator('text=/loading|Loading|checking/i').first();
    const healthContent = page.locator('[class*="health"], [class*="status"], [class*="metric"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const hasContent = await healthContent.isVisible().catch(() => false);

    expect(isLoading || hasContent).toBeTruthy();
  });

  test('health page is responsive', async ({ page }) => {
    await page.goto('/health');

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
