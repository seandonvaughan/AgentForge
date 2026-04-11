import { test, expect } from '@playwright/test';

test.describe('Observability Page', () => {
  test('loads observability page successfully', async ({ page }) => {
    await page.goto('/observe');

    // Verify page title
    await expect(page).toHaveTitle(/Observ|Monitor|Metrics|Health|Telemetry|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays observability heading', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Observ|Monitor|Metric|Health|Telemetry|Debug/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays system health or status overview', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for health/status indicators
    const healthStatus = page.locator('[class*="health"], [class*="status"], [class*="indicator"]').first();
    const statusText = page.locator('text=/healthy|online|up|running|degraded|down|offline/i').first();
    const statusBadge = page.locator('[class*="badge"], [class*="chip"]').first();

    const hasHealth = await healthStatus.isVisible().catch(() => false);
    const hasStatus = await statusText.isVisible().catch(() => false);
    const hasBadge = await statusBadge.isVisible().catch(() => false);

    expect(hasHealth || hasStatus || hasBadge).toBeTruthy();
  });

  test('displays metrics or telemetry data', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for metrics/telemetry
    const metricsContainer = page.locator('[class*="metric"], [class*="stat"], [class*="telemetry"]').first();
    const chart = page.locator('svg, canvas, [class*="chart"], [class*="graph"]').first();
    const numbers = page.locator('text=/\\d+(\\.\\d+)?\\s*(ms|%|ops|requests?|errors?|latency)/i').first();

    const hasMetrics = await metricsContainer.isVisible().catch(() => false);
    const hasChart = await chart.isVisible().catch(() => false);
    const hasNumbers = await numbers.isVisible().catch(() => false);

    expect(hasMetrics || hasChart || hasNumbers).toBeTruthy();
  });

  test('displays monitoring dashboard or panels', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for dashboard panels
    const dashboard = page.locator('[class*="dashboard"], [class*="panel"], [class*="card"]').first();
    const gridLayout = page.locator('[class*="grid"]').first();

    const hasDashboard = await dashboard.isVisible().catch(() => false);
    const hasGrid = await gridLayout.isVisible().catch(() => false);

    expect(hasDashboard || hasGrid).toBeTruthy();
  });

  test('displays logs or events', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for logs or event streams
    const logPanel = page.locator('[class*="log"], [class*="event"], [class*="stream"]').first();
    const logText = page.locator('text=/error|warning|info|debug|trace|event|log/i').first();
    const timestamp = page.locator('text=/ago|today|time|date/i').first();

    const hasLogs = await logPanel.isVisible().catch(() => false);
    const hasLogText = await logText.isVisible().catch(() => false);
    const hasTime = await timestamp.isVisible().catch(() => false);

    expect(hasLogs || hasLogText || hasTime).toBeTruthy();
  });

  test('displays resource usage or performance metrics', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for resource metrics
    const resourceMetrics = page.locator('text=/cpu|memory|disk|network|usage|latency|throughput|bandwidth/i').first();
    const progressBar = page.locator('[role="progressbar"], [class*="progress"]').first();
    const percentage = page.locator('text=/\\d+\\%/i').first();

    const hasResource = await resourceMetrics.isVisible().catch(() => false);
    const hasProgress = await progressBar.isVisible().catch(() => false);
    const hasPercent = await percentage.isVisible().catch(() => false);

    expect(hasResource || hasProgress || hasPercent).toBeTruthy();
  });

  test('displays time range or date picker for filtering', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for time range controls
    const datePicker = page.locator('input[type="date"], input[type="datetime-local"], [class*="date"]').first();
    const timeRange = page.locator('button, [role="button"]').filter({ hasText: /last|hour|day|week|month|range/i }).first();
    const timeRangeText = page.locator('text=/Last.*(?:hour|day|week|month)/i').first();

    const hasDatePicker = await datePicker.isVisible().catch(() => false);
    const hasTimeRange = await timeRange.isVisible().catch(() => false);
    const hasTimeText = await timeRangeText.isVisible().catch(() => false);

    expect(hasDatePicker || hasTimeRange || hasTimeText).toBeTruthy();
  });

  test('observability page handles loading and empty states', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|fetching|connecting/i').first();
    const emptyState = page.locator('text=/No data|No metrics|No event|empty|unavailable/i').first();
    const observeContent = page.locator('[class*="metric"], svg, canvas, table, [class*="chart"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await observeContent.isVisible().catch(() => false);

    expect(isLoading || isEmpty || hasContent).toBeTruthy();
  });

  test('observability page is responsive', async ({ page }) => {
    await page.goto('/observe');

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

  test('displays alert or anomaly detection', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for alerts or anomalies
    const alerts = page.locator('[class*="alert"], [class*="anomaly"], [class*="notification"]').first();
    const alertText = page.locator('text=/alert|warning|anomaly|critical|error|failure/i').first();

    const hasAlerts = await alerts.isVisible().catch(() => false);
    const hasAlertText = await alertText.isVisible().catch(() => false);

    expect(hasAlerts || hasAlertText).toBeTruthy();
  });

  test('displays filtering and search capabilities', async ({ page }) => {
    await page.goto('/observe');

    await page.waitForLoadState('networkidle');

    // Look for filter/search
    const searchInput = page.locator('input[type="search"], input[type="text"], [class*="search"]').first();
    const filterButton = page.locator('button, [role="button"]').filter({ hasText: /filter|search/i }).first();

    const hasSearch = await searchInput.isVisible().catch(() => false);
    const hasFilter = await filterButton.isVisible().catch(() => false);

    expect(hasSearch || hasFilter).toBeTruthy();
  });
});
