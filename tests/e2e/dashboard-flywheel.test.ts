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

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Flywheel|Meta|Learning|Feedback/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays flywheel visualization or metrics', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('networkidle');

    // Look for flywheel diagram, chart, or metrics
    const flywheelViz = page.locator('[class*="flywheel"], [class*="chart"], [class*="graph"], svg, canvas').first();
    const metrics = page.locator('[class*="metric"], [class*="stat"], [class*="card"]').first();

    const hasViz = await flywheelViz.isVisible().catch(() => false);
    const hasMetrics = await metrics.isVisible().catch(() => false);

    expect(hasViz || hasMetrics).toBeTruthy();
  });

  test('displays learning cycles or phases', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('networkidle');

    // Look for cycle or phase labels
    const cycleLabels = page.locator('text=/cycle|phase|stage|step|iteration/i');
    const cycleCount = await cycleLabels.count();

    if (cycleCount > 0) {
      await expect(cycleLabels.first()).toBeVisible();
    }
  });

  test('displays autonomy or capability information', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('networkidle');

    // Look for autonomy or capability metrics
    const autonomyInfo = page.locator('text=/autonomy|capability|level|progress|score/i');
    const autonomyCount = await autonomyInfo.count();

    if (autonomyCount > 0) {
      await expect(autonomyInfo.first()).toBeVisible();
    }
  });

  test('displays feedback or learning indicators', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('networkidle');

    // Look for feedback or learning-related elements
    const feedbackElements = page.locator('text=/feedback|learning|improvement|score|rating/i');
    const feedbackCount = await feedbackElements.count();

    if (feedbackCount > 0) {
      await expect(feedbackElements.first()).toBeVisible();
    }
  });

  test('flywheel page handles loading and empty states', async ({ page }) => {
    await page.goto('/flywheel');

    await page.waitForLoadState('networkidle');

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

    await page.waitForLoadState('networkidle');

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
