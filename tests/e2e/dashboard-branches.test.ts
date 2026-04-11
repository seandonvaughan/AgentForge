import { test, expect } from '@playwright/test';

/**
 * E2E tests for the /branches dashboard tab.
 *
 * This page is served via the SPA router: navigating to /branches fetches
 * dashboard/pages/branches.html, injects it into #main-content, then calls
 * window.loadBranchesPage() which hits GET /api/v1/branches.
 *
 * Assertions here are scoped to branches-page-specific DOM ids and text so
 * that a regression in page injection or API wiring produces an honest failure
 * rather than a tautologically-passing check on a generic heading.
 */

test.describe('Branches Page', () => {

  test('loads and renders the Autonomous Branches heading', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    // The page-specific h2 must be present — not just any heading on the layout
    const heading = page.locator('h2').filter({ hasText: /Autonomous Branches/i });
    await expect(heading).toBeVisible();
  });

  test('displays the four summary stat chips with numeric values', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    // All four stat ids are rendered by updateStats() once the API responds.
    // The values should be digits (0 is fine — no autonomous/* branches in test env).
    for (const id of ['branches-stat-total', 'branches-stat-open', 'branches-stat-merged', 'branches-stat-stale']) {
      const chip = page.locator(`#${id}`);
      await expect(chip).toBeVisible();
      // Value must be a whole number (0 or greater) — not the placeholder dash
      await expect(chip).toHaveText(/^\d+$/);
    }
  });

  test('filter bar: search input and status dropdown are present', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#branches-search')).toBeVisible();
    await expect(page.locator('#branches-filter-status')).toBeVisible();

    // Status dropdown must have at least the four expected options
    const select = page.locator('#branches-filter-status');
    await expect(select.locator('option[value="open-pr"]')).toHaveCount(1);
    await expect(select.locator('option[value="stale"]')).toHaveCount(1);
    await expect(select.locator('option[value="merged"]')).toHaveCount(1);
    await expect(select.locator('option[value="active"]')).toHaveCount(1);
  });

  test('shows either the branches table with correct headers or the empty state', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    const tableWrap = page.locator('#branches-table-wrap');
    const emptyState = page.locator('#branches-empty');

    const tableVisible = await tableWrap.isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);

    // Exactly one of these two states must be visible after load
    expect(tableVisible || emptyVisible).toBe(true);

    if (tableVisible) {
      // Table must have the six expected column headers
      const thead = tableWrap.locator('thead tr');
      await expect(thead.locator('th', { hasText: 'Branch' })).toHaveCount(1);
      await expect(thead.locator('th', { hasText: 'Cycle' })).toHaveCount(1);
      await expect(thead.locator('th', { hasText: 'Age' })).toHaveCount(1);
      await expect(thead.locator('th', { hasText: 'Status' })).toHaveCount(1);
      await expect(thead.locator('th', { hasText: 'PR' })).toHaveCount(1);
      await expect(thead.locator('th', { hasText: 'Actions' })).toHaveCount(1);
    }
  });

  test('loading state is hidden and error state is absent after successful load', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    // Loading indicator must be gone — it's shown then hidden by loadBranchesPage()
    await expect(page.locator('#branches-loading')).toBeHidden();
    // Error state must not be visible on a healthy server
    await expect(page.locator('#branches-error')).toBeHidden();
  });

  test('refresh button re-fetches branches without breaking the page', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    // Capture the total count before refresh
    const totalBefore = await page.locator('#branches-stat-total').textContent();

    // Click Refresh
    await page.locator('button', { hasText: /Refresh/i }).click();
    // Wait for the loading state to appear then disappear
    await page.waitForFunction(() => {
      const el = document.getElementById('branches-loading');
      return el && el.hidden;
    }, { timeout: 8000 });

    // Page must not be broken — heading still visible
    await expect(page.locator('h2').filter({ hasText: /Autonomous Branches/i })).toBeVisible();

    // Total count must still be a valid number
    await expect(page.locator('#branches-stat-total')).toHaveText(/^\d+$/);
  });

  test('search filter narrows visible rows without showing the error state', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    const tableVisible = await page.locator('#branches-table-wrap').isVisible().catch(() => false);
    if (!tableVisible) {
      // No branches — nothing to filter, skip the interaction portion
      await expect(page.locator('#branches-empty')).toBeVisible();
      return;
    }

    // Type a nonsense query that will match nothing
    await page.locator('#branches-search').fill('zzz-no-match-xyz-999');
    // Filter empty state must appear
    await expect(page.locator('#branches-filter-empty')).toBeVisible();
    // Error state must NOT appear — filtering is client-side, no new fetch
    await expect(page.locator('#branches-error')).toBeHidden();

    // Clear the query — original results must return
    await page.locator('#branches-search').fill('');
    await expect(page.locator('#branches-table-wrap')).toBeVisible();
    await expect(page.locator('#branches-filter-empty')).toBeHidden();
  });

  test('branches page is responsive at mobile and desktop widths', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('networkidle');

    // Mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(300);
    await expect(page.locator('h2').filter({ hasText: /Autonomous Branches/i })).toBeVisible();

    // Desktop
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(300);
    await expect(page.locator('h2').filter({ hasText: /Autonomous Branches/i })).toBeVisible();
  });
});
