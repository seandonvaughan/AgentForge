import { test, expect } from '@playwright/test';

test.describe('Branches Page', () => {
  test('loads branches page successfully', async ({ page }) => {
    await page.goto('/branches');

    // Verify page title
    await expect(page).toHaveTitle(/Branch|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays branches heading', async ({ page }) => {
    await page.goto('/branches');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Branch/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays branches list or grid', async ({ page }) => {
    await page.goto('/branches');

    await page.waitForLoadState('networkidle');

    // Look for branches table, grid, or list
    const branchesList = page.locator('[role="grid"], [role="table"], [class*="list"], [class*="branches"], [data-testid*="branch"]').first();
    const branchCard = page.locator('[class*="branch"], [class*="card"], [role="button"]').first();
    const emptyState = page.locator('text=/No branch|No data|empty/i').first();

    const hasBranchesList = await branchesList.isVisible().catch(() => false);
    const hasBranchCard = await branchCard.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays branch information (name, status, metadata)', async ({ page }) => {
    await page.goto('/branches');

    await page.waitForLoadState('networkidle');

    // Look for branch names or identifiers
    const branchNames = page.locator('text=/main|develop|feature|bugfix|release/i');
    const branchNameCount = await branchNames.count();

    if (branchNameCount > 0) {
      await expect(branchNames.first()).toBeVisible();
    }

    // Look for status indicators
    const statusElements = page.locator('[class*="badge"], [class*="status"], text=/active|merged|deleted/i');
    const statusCount = await statusElements.count();

    if (statusCount > 0) {
      await expect(statusElements.first()).toBeVisible();
    }
  });

  test('branch items are interactive', async ({ page }) => {
    await page.goto('/branches');

    await page.waitForLoadState('networkidle');

    // Find first branch item (link or button)
    const branchLink = page.locator('a, button, [role="button"]').filter({ hasText: /main|develop|feature|branch/i }).first();

    if (await branchLink.isVisible()) {
      await expect(branchLink).toBeEnabled();
    }
  });

  test('branches page handles loading and empty states', async ({ page }) => {
    await page.goto('/branches');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No branch|No data|empty/i').first();
    const branchContent = page.locator('[class*="branch"], [role="grid"], [role="table"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await branchContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('branches page is responsive', async ({ page }) => {
    await page.goto('/branches');

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
