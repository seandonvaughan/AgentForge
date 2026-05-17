import { test, expect } from '@playwright/test';

test.describe('Insights Page (/insights)', () => {
  test('loads insights page', async ({ page }) => {
    await page.goto('/insights');

    // Verify page loaded successfully
    await expect(page).toHaveTitle(/Insights|Analytics|AgentForge/i);

    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays insights heading', async ({ page }) => {
    await page.goto('/insights');

    await page.waitForLoadState('load').catch(() => {});

    // Verify main heading is visible
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 8000 });

    const headingText = await heading.textContent();
    expect(headingText).toBeTruthy();
    expect(/[A-Za-z]/.test(headingText ?? '')).toBeTruthy(); // Has real text, not empty
  });

  test('displays insights metrics or data visualizations', async ({ page }) => {
    await page.goto('/insights');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Look for common analytics elements: charts, metrics, cards, stats
    const metrics = page.locator('[data-testid="metric"], [data-testid="card"], [data-testid="stat"], .metric-card, .insight-card');
    const charts = page.locator('[role="img"], canvas, svg[role="img"]');
    const emptyState = page.locator('[data-testid="empty-state"], .empty-state').first();

    const hasMetrics = await metrics.count().catch(() => 0);
    const hasCharts = await charts.count().catch(() => 0);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    // Should have metrics, charts, or an empty state
    expect(hasMetrics > 0 || hasCharts > 0 || hasEmptyState).toBeTruthy();
  });

  test('insights page has no critical errors', async ({ page }) => {
    await page.goto('/insights');

    await page.waitForLoadState('load').catch(() => {});

    // Check for error messages
    const errorMessages = page.locator('text=/Error|500|Failed to load|Connection refused/i');
    const errorCount = await errorMessages.count();

    expect(errorCount).toBe(0);
  });

  test('insights page displays meaningful content', async ({ page }) => {
    await page.goto('/insights');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Page should have substantial content
    const body = page.locator('body');
    const html = await body.innerHTML();

    // Should have more than minimal HTML
    expect(html.length).toBeGreaterThan(500);
  });

  test('insights page is responsive', async ({ page }) => {
    await page.goto('/insights');

    await page.waitForLoadState('load').catch(() => {});

    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Test tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Test desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('insights metrics are initialized with default values if no data', async ({ page }) => {
    await page.goto('/insights');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Look for any metric values (should be 0 or a number if initialized)
    const metricValues = page.locator('[data-testid="metric-value"], .metric-number, .stat-value');

    if (await metricValues.count().catch(() => 0) > 0) {
      const firstValue = await metricValues.first().textContent();
      // Should be a number or default value
      expect(/[0-9%\-$]/.test(firstValue ?? '')).toBeTruthy();
    }
  });
});
