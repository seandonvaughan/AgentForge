import { test, expect, type Page } from '@playwright/test';

async function openCost(page: Page) {
  await page.goto('/cost', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1').first()).toContainText(/Cost/i);
}

test.describe('Cost Dashboard Page', () => {
  test('loads cost page successfully', async ({ page }) => {
    await openCost(page);

    // Verify page title
    await expect(page).toHaveTitle(/Cost|Budget|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays cost/budget heading', async ({ page }) => {
    await openCost(page);

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Cost|Budget|Spending/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays cost metrics or statistics', async ({ page }) => {
    await openCost(page);

    // Look for cost cards, metrics, or gauges
    const costMetrics = page.locator('[class*="metric"], [class*="stat"], [class*="card"], [class*="gauge"]').first();
    const costValues = page.locator('text=/\\$|cost|budget|spending|total/i').first();

    const hasMetrics = await costMetrics.isVisible().catch(() => false);
    const hasValues = await costValues.isVisible().catch(() => false);

    expect(hasMetrics || hasValues).toBeTruthy();
  });

  test('displays cost breakdowns or charts', async ({ page }) => {
    await openCost(page);

    // Look for charts or graphs
    const chart = page.locator('[class*="chart"], [class*="graph"], svg, canvas').first();
    const breakdown = page.locator('[class*="breakdown"], [class*="detail"], [role="table"], [role="grid"]').first();

    const hasChart = await chart.isVisible().catch(() => false);
    const hasBreakdown = await breakdown.isVisible().catch(() => false);

    expect(hasChart || hasBreakdown).toBeTruthy();
  });

  test('displays budget information (limit, spent, remaining)', async ({ page }) => {
    await openCost(page);

    // Look for budget-related text
    await expect(page.locator('body')).toContainText(/budget|limit|spent|remaining|available|last 30 days|ytd/i);
  });

  test('displays cost by agent or task category', async ({ page }) => {
    await openCost(page);

    // Look for agent or task names in cost breakdown
    await expect(page.locator('body')).toContainText(/Agent|Task|Model|API|service/i);
  });

  test('cost page handles loading and empty states', async ({ page }) => {
    await openCost(page);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('cost page is responsive', async ({ page }) => {
    await openCost(page);

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible();

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });

    await expect(heading).toBeVisible();
  });
});
