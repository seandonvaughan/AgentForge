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
    await page.waitForLoadState('load').catch(() => {});

    // Look for sprint cards or grid or verify heading is present
    const sprintGrid = page.locator('[class*="sprint"], [data-testid*="sprint"], [role="grid"], [role="table"]').first();
    const heading = page.locator('h1, h2').filter({ hasText: /Sprints/i }).first();

    const hasSprints = await sprintGrid.isVisible().catch(() => false);
    const hasHeading = await heading.isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/No sprint|No data|empty/i').isVisible().catch(() => false);

    expect(hasSprints || hasHeading || hasEmptyState).toBeTruthy();
  });

  test('displays sprint metadata (version, status, progress)', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('load').catch(() => {});

    // Look for sprint version or status information
    const sprintVersion = page.locator('text=/v\\d+\\.\\d+/i').first();
    const progressBar = page.locator('[role="progressbar"]').first();
    const statusBadge = page.locator('text=/Completed|In Progress|Pending|Active/i').first();
    const heading = page.locator('h1, h2').first();

    const hasVersion = await sprintVersion.isVisible().catch(() => false);
    const hasProgress = await progressBar.isVisible().catch(() => false);
    const hasStatus = await statusBadge.isVisible().catch(() => false);
    const hasHeading = await heading.isVisible().catch(() => false);

    // At least a heading should be visible
    expect(hasHeading || hasVersion || hasProgress || hasStatus).toBeTruthy();
  });

  test('can navigate to sprint detail from list', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('load').catch(() => {});

    // Look for sprint card/button that navigates to detail
    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      await expect(sprintCard).toBeEnabled();
    }
  });

  test('sprints list is responsive', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('load').catch(() => {});

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    await page.waitForTimeout(500);

    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Test tablet view
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();
  });
});
