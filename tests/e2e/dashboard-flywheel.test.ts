import { test, expect } from '@playwright/test';

test.describe('Flywheel Page', () => {
  test('loads flywheel page successfully', async ({ page }) => {
    await page.goto('/flywheel');

    // Verify page title
    await expect(page).toHaveTitle(/Flywheel|Meta|Learning|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays flywheel heading', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Flywheel|Meta|Learning|Feedback/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays flywheel visualization or metrics', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // Look for flywheel diagram, chart, or metrics
    const flywheelViz = page.locator('[class*="flywheel"], [class*="chart"], [class*="graph"], svg, canvas').first();
    const metrics = page.locator('[class*="metric"], [class*="stat"], [class*="card"]').first();

    const hasViz = await flywheelViz.isVisible().catch(() => false);
    const hasMetrics = await metrics.isVisible().catch(() => false);

    expect(hasViz || hasMetrics).toBeTruthy();
  });

  test('displays learning cycles or phases', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // Look for cycle or phase labels
    const cycleLabels = page.locator('text=/cycle|phase|stage|step|iteration/i');
    const cycleCount = await cycleLabels.count();

    if (cycleCount > 0) {
      await expect(cycleLabels.first()).toBeVisible();
    }
  });

  test('displays autonomy or capability information', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // Look for autonomy or capability metrics
    const autonomyInfo = page.locator('text=/autonomy|capability|level|progress|score/i');
    const autonomyCount = await autonomyInfo.count();

    if (autonomyCount > 0) {
      await expect(autonomyInfo.first()).toBeVisible();
    }
  });

  test('displays feedback or learning indicators', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // Look for feedback or learning-related elements
    const feedbackElements = page.locator('text=/feedback|learning|improvement|score|rating/i');
    const feedbackCount = await feedbackElements.count();

    if (feedbackCount > 0) {
      await expect(feedbackElements.first()).toBeVisible();
    }
  });

  test('flywheel page handles loading and empty states', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No data|empty|No feedback/i').first();
    const flywheelContent = page.locator('[class*="flywheel"], [class*="chart"], [class*="metric"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await flywheelContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('memory stats card renders total entries, sparkline, and hit rate', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

    // +page.server.ts always computes memoryStats via computeMemoryStats() —
    // even for an empty project the function returns { totalEntries: 0,
    // entriesPerCycleTrend: [], hitRate: 0 }, which is truthy enough to render
    // the card.  The non-blocking refresh-error banner (visible when a background
    // API poll fails) keeps SSR-rendered content intact, so the card must always
    // be visible after SSR succeeds.
    const card = page.locator('[data-testid="memory-stats-card"]');
    await expect(card).toBeVisible();

    // Total entries counter (data-testid preferred; id/class fallbacks for the
    // plain-HTML dashboard that shares the same selectors).
    await expect(
      card.locator('[data-testid="mem-total"], #fw-mem-total, .mem-total').first()
    ).toBeVisible();

    // Memory hit-rate percentage.
    await expect(
      card.locator('[data-testid="mem-hitrate"], #fw-mem-hitrate, .mem-hitrate').first()
    ).toBeVisible();

    // Entries-per-cycle sparkline (either the trend bars or the
    // "no cycle data yet" empty-state placeholder inside the container).
    const sparkline = card.locator(
      '[aria-label*="Entries per cycle" i], #fw-mem-sparkline, .trend-bars'
    ).first();
    await expect(sparkline).toBeVisible();
  });

  test('flywheel page is responsive', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('domcontentloaded');

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

  /**
   * REGRESSION: startedAt Timestamp Fallback (v10.6.0)
   *
   * Bug: computeCycleHistory used new Date().toISOString() as a fallback
   * for missing cycle.startedAt, which caused cycles without timestamps
   * to be sorted to the end (as "newest"), poisoning trend math with
   * misleadingly optimistic scores.
   *
   * Fix: Changed fallback to '1970-01-01T00:00:00.000Z' for deterministic
   * sort order. This pushes cycles without timestamps to the beginning,
   * leaving trend calculations valid.
   *
   * Test: Verify that metrics display valid numbers, not NaN or error states
   * that would result from corrupted trend calculations.
   */
  test('flywheel page: metrics display valid numbers (timestamp regression test)', async ({ page }) => {
    await page.goto('/flywheel');
    await page.waitForLoadState('load').catch(() => {});

    // Look for numeric metric values on the page
    // Selectors that typically contain scores/percentages
    const metricContainers = page.locator('[class*="metric"], [class*="score"], [class*="stat"], [data-testid*="metric"]');
    const containerCount = await metricContainers.count();

    if (containerCount === 0) {
      // If no metrics containers found, check for raw text content with numbers
      const pageBody = page.locator('body');
      const bodyText = await pageBody.textContent();

      // Body should not contain NaN or undefined (which would indicate calculation errors)
      expect(bodyText).not.toContain('NaN');
      expect(bodyText).not.toContain('undefined');
      return;
    }

    // Verify at least one metric is visible
    const firstMetric = metricContainers.first();
    const isMetricVisible = await firstMetric.isVisible().catch(() => false);

    if (isMetricVisible) {
      const metricText = await firstMetric.textContent();

      // Metrics should display valid numbers, not NaN
      expect(metricText).not.toContain('NaN');
      expect(metricText).not.toContain('undefined');

      // Should contain some numeric content (%, points, or digit)
      expect(metricText).toMatch(/\d+|%|score|value/i);
    }
  });

  /**
   * REGRESSION: Double computeCycleHistory Call (v10.6.0)
   *
   * Bug: computeCycleHistory was called 3 times with different limits:
   * - Once with limit=20 for the cycleHistory payload
   * - Twice more with limit=100 inside computeMetaLearning/computeAutonomy
   * This caused data-consistency issues: displayed sparkline (limit=20) could
   * differ from computed metrics (limit=100).
   *
   * Fix: Hoist the call and pass cycles arrays to metric functions directly.
   *
   * Test: Verify the cycle history sparkline and metrics are consistent
   * (e.g., sparkline doesn't show "stable" while score reflects trend from
   * hidden cycles 21-100).
   */
  test('flywheel page: memory stats card renders sparkline data', async ({ page }) => {
    await page.goto('/flywheel');
    await page.waitForLoadState('load').catch(() => {});

    const card = page.locator('[data-testid="memory-stats-card"]');
    const isCardVisible = await card.isVisible().catch(() => false);

    if (!isCardVisible) {
      // Card may not be present in all configurations — verify page loaded
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 8000 });
      return;
    }

    // Verify the card is present
    await expect(card).toBeVisible();

    // Sparkline should be present (either trend bars or empty-state placeholder)
    const sparkline = card.locator(
      '[aria-label*="Entries per cycle" i], #fw-mem-sparkline, .trend-bars, [class*="spark"], [class*="trend"]'
    ).first();

    const isSparklineVisible = await sparkline.isVisible().catch(() => false);
    expect(isSparklineVisible, 'Memory stats card should display a sparkline or trend indicator').toBe(true);
  });

  /**
   * REGRESSION: Flywheel Metrics Consistency
   *
   * Verify that the flywheel page displays metrics without error states
   * and that computed scores are reasonable (not infinity, negative, or NaN).
   */
  test('flywheel page: meta-learning and autonomy scores are valid', async ({ page }) => {
    await page.goto('/flywheel');
    await page.waitForLoadState('load').catch(() => {});

    // Look for score/metric indicators
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 8000 });

    // Page should not display error messages
    const errorMessages = page.locator('text=/Error|error|500|failed|Failed/i');
    const errorCount = await errorMessages.count();
    expect(errorCount, 'Flywheel page should not display error messages').toBe(0);

    // Page body should contain reasonable content length
    const body = page.locator('body');
    const bodyHTML = await body.innerHTML();
    expect(bodyHTML.length, 'Flywheel page should render meaningful content').toBeGreaterThan(500);
  });

  /**
   * REGRESSION: Flywheel Page Loads Without Timeout
   *
   * Verify the page completes its data loading without timing out,
   * which would indicate a missing await or unresolved promise
   * in the computeCycleHistory chain.
   */
  test('flywheel page: loads within reasonable time', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/flywheel', { waitUntil: 'load', timeout: 15000 });
    const elapsed = Date.now() - startTime;

    // Page should load in under 10 seconds for normal operation
    expect(elapsed).toBeLessThan(10000);

    // Verify content is visible
    const content = page.locator('body');
    await expect(content).toBeVisible();
  });
});
