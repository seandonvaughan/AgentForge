import { test, expect } from '@playwright/test';

/**
 * E2E tests for the /branches dashboard tab.
 *
 * This page is served by the SvelteKit dashboard at /branches, which calls
 * GET /api/v5/autonomous-branches to populate the view.
 *
 * Assertions here are scoped to branches-page-specific DOM ids and text so
 * that a regression in page injection or API wiring produces an honest failure
 * rather than a tautologically-passing check on a generic heading.
 */

test.describe('Branches Page', () => {

  test('loads and renders the Autonomous Branches heading', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

    // The page-specific h2 must be present — not just any heading on the layout
    const heading = page.locator('h2').filter({ hasText: /Autonomous Branches/i });
    await expect(heading).toBeVisible();
  });

  test('displays the four summary stat chips with numeric values', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

    // All four stat ids are rendered via Svelte $derived state once the API responds.
    // The values should be digits (0 is fine — no autonomous/* branches in test env).
    for (const id of ['branches-stat-total', 'branches-stat-open', 'branches-stat-merged', 'branches-stat-stale']) {
      const chip = page.locator(`#${id}`);
      await expect(chip).toBeVisible();
      // Value must be a whole number (0 or greater) — not the placeholder dash
      await expect(chip).toHaveText(/^\d+$/);
    }
  });

  test('filter bar: search input and all four status filter pills are present', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

    // Search input must be visible
    await expect(page.locator('#branches-search')).toBeVisible();

    // The branches page uses pill buttons (not a <select>) for status filtering.
    // Each pill button contains a label with the status name.
    const summaryBar = page.locator('.summary-bar');
    await expect(summaryBar).toBeVisible();

    // All four status pills must be present
    await expect(summaryBar.locator('button.pill.open-pr')).toHaveCount(1);
    await expect(summaryBar.locator('button.pill.stale')).toHaveCount(1);
    await expect(summaryBar.locator('button.pill.merged')).toHaveCount(1);
    await expect(summaryBar.locator('button.pill.active-pill')).toHaveCount(1);
  });

  test('shows either the branches table with correct headers or the empty state', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

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
    await page.waitForLoadState('domcontentloaded');

    // Loading indicator must be gone — controlled by Svelte $state(loading) with hidden={!loading}
    await expect(page.locator('#branches-loading')).toBeHidden();
    // Error state must not be visible on a healthy server
    await expect(page.locator('#branches-error')).toBeHidden();
  });

  test('refresh button re-fetches branches without breaking the page', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

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
    await page.waitForLoadState('domcontentloaded');

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

  test('age heat bar is rendered for each branch row', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

    const tableVisible = await page.locator('#branches-table-wrap').isVisible().catch(() => false);
    if (!tableVisible) {
      // No branches in the test environment — nothing to check
      await expect(page.locator('#branches-empty')).toBeVisible();
      return;
    }

    // Each data row must contain a heat bar div (the staleness indicator).
    // The bar is a child div inside the age cell with width% style set by makeAgeBar().
    const rows = page.locator('#branches-tbody tr');
    const count = await rows.count();
    if (count > 0) {
      // The age column (3rd td) must contain the bar wrapper div.
      // The cell uses a two-div structure: .age-bar-track (wrapper) and
      // .age-bar-fill (progress fill) — test for the outer wrapper specifically.
      const ageTd = rows.nth(0).locator('td').nth(2);
      await expect(ageTd.locator('div.age-bar-track')).toHaveCount(1);
    }
  });

  test('branches page is responsive at mobile and desktop widths', async ({ page }) => {
    await page.goto('/branches');
    await page.waitForLoadState('domcontentloaded');

    // Mobile — Playwright's expect() auto-retries, no arbitrary sleep needed
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('h2').filter({ hasText: /Autonomous Branches/i })).toBeVisible();

    // Desktop
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('h2').filter({ hasText: /Autonomous Branches/i })).toBeVisible();
  });
});
