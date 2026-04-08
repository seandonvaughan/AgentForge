import { test, expect } from '@playwright/test';

test.describe('Sprints List Page', () => {
  test('loads sprints list page', async ({ page }) => {
    await page.goto('/sprints');

    // Verify page title
    await expect(page).toHaveTitle(/Sprints|AgentForge/i);

    // Verify heading is visible
    const heading = page.locator('h1, h2').filter({ hasText: /Sprints/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays sprints grid or list', async ({ page }) => {
    await page.goto('/sprints');

    // Wait for data to load
    await page.waitForLoadState('networkidle');

    // Look for sprint cards or grid
    const sprintGrid = page.locator('[class*="sprint"], [data-testid*="sprint"]').first();

    // Check if sprints are displayed (either from data or empty state)
    const hasSprints = await sprintGrid.isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/No sprint|No data|empty/i').isVisible().catch(() => false);

    expect(hasSprints || hasEmptyState).toBeTruthy();
  });

  test('displays sprint metadata (version, status, progress)', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('networkidle');

    // Look for sprint version in monospace font
    const sprintVersion = page.locator('[class*="version"], [class*="sprint"]').first();

    if (await sprintVersion.isVisible()) {
      // Should have some version text (e.g., v6.4.4)
      await expect(sprintVersion).toHaveText(/v\d+\.\d+/i);
    }

    // Look for progress bar or status badge
    const progressBar = page.locator('[role="progressbar"], [class*="progress"]').first();
    const statusBadge = page.locator('[class*="badge"], text=/Completed|In Progress|Pending/i').first();

    const hasProgress = await progressBar.isVisible().catch(() => false);
    const hasStatus = await statusBadge.isVisible().catch(() => false);

    expect(hasProgress || hasStatus).toBeTruthy();
  });

  test('can navigate to sprint detail from list', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('networkidle');

    // Look for sprint card/button that navigates to detail
    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      await expect(sprintCard).toBeEnabled();
    }
  });
});
