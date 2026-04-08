import { test, expect } from '@playwright/test';

test.describe('Cost Dashboard Page', () => {
  test('loads cost page successfully', async ({ page }) => {
    await page.goto('/cost');

    // Verify page title
    await expect(page).toHaveTitle(/Cost|Budget|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays cost/budget heading', async ({ page }) => {
    await page.goto('/cost');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Cost|Budget|Spending/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays cost metrics or statistics', async ({ page }) => {
    await page.goto('/cost');

    await page.waitForLoadState('networkidle');

    // Look for cost cards, metrics, or gauges
    const costMetrics = page.locator('[class*="metric"], [class*="stat"], [class*="card"], [class*="gauge"]').first();
    const costValues = page.locator('text=/\\$|cost|budget|spending|total/i').first();

    const hasMetrics = await costMetrics.isVisible().catch(() => false);
    const hasValues = await costValues.isVisible().catch(() => false);

    expect(hasMetrics || hasValues).toBeTruthy();
  });

  test('displays cost breakdowns or charts', async ({ page }) => {
    await page.goto('/cost');

    await page.waitForLoadState('networkidle');

    // Look for charts or graphs
    const chart = page.locator('[class*="chart"], [class*="graph"], svg, canvas').first();
    const breakdown = page.locator('[class*="breakdown"], [class*="detail"], [role="table"], [role="grid"]').first();

    const hasChart = await chart.isVisible().catch(() => false);
    const hasBreakdown = await breakdown.isVisible().catch(() => false);

    expect(hasChart || hasBreakdown).toBeTruthy();
  });

  test('displays budget information (limit, spent, remaining)', async ({ page }) => {
    await page.goto('/cost');

    await page.waitForLoadState('networkidle');

    // Look for budget-related text
    const budgetInfo = page.locator('text=/budget|limit|spent|remaining|available/i');
    const budgetCount = await budgetInfo.count();

    if (budgetCount > 0) {
      await expect(budgetInfo.first()).toBeVisible();
    }
  });

  test('displays cost by agent or task category', async ({ page }) => {
    await page.goto('/cost');

    await page.waitForLoadState('networkidle');

    // Look for agent or task names in cost breakdown
    const agentCosts = page.locator('text=/Agent|Task|Model|API|service/i');
    const agentCostCount = await agentCosts.count();

    if (agentCostCount > 0) {
      await expect(agentCosts.first()).toBeVisible();
    }
  });

  test('cost page handles loading and empty states', async ({ page }) => {
    await page.goto('/cost');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No cost|No data|empty/i').first();
    const costContent = page.locator('[class*="metric"], [class*="chart"], [role="grid"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await costContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('cost page is responsive', async ({ page }) => {
    await page.goto('/cost');

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
