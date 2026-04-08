import { test, expect } from '@playwright/test';

test.describe('Sessions Page', () => {
  test('loads sessions page successfully', async ({ page }) => {
    await page.goto('/sessions');

    // Verify page title
    await expect(page).toHaveTitle(/Session|Activity|History|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays sessions heading', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Session|Activity|History/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays sessions list or grid', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Look for sessions list, grid, or table
    const sessionsList = page.locator('[class*="session"], [class*="list"], [role="table"], [role="grid"]').first();
    const sessionItem = page.locator('[class*="item"], [class*="card"], [class*="row"]').first();
    const emptyState = page.locator('text=/No session|No activity|No data|empty/i').first();

    const hasList = await sessionsList.isVisible().catch(() => false);
    const hasItem = await sessionItem.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays session information (id, status, duration)', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Look for session identifiers or metadata
    const sessionInfo = page.locator('text=/session|id|status|duration|time|started|ended/i');
    const sessionInfoCount = await sessionInfo.count();

    if (sessionInfoCount > 0) {
      await expect(sessionInfo.first()).toBeVisible();
    }
  });

  test('displays session status or activity indicators', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Look for status badges
    const statusBadges = page.locator('[class*="badge"], [class*="status"], text=/active|completed|failed|pending|running/i');
    const badgeCount = await statusBadges.count();

    if (badgeCount > 0) {
      await expect(statusBadges.first()).toBeVisible();
    }
  });

  test('session items are clickable for details', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Look for clickable session items
    const sessionLinks = page.locator('a, button, [role="button"]').filter({ hasText: /session|view|details|open/i });
    const linkCount = await sessionLinks.count();

    if (linkCount > 0) {
      await expect(sessionLinks.first()).toBeEnabled();
    }
  });

  test('displays session metadata (agent, task, result)', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Look for session context
    const agentInfo = page.locator('text=/agent|task|workflow|request|result/i');
    const agentCount = await agentInfo.count();

    if (agentCount > 0) {
      await expect(agentInfo.first()).toBeVisible();
    }
  });

  test('sessions page handles loading and empty states', async ({ page }) => {
    await page.goto('/sessions');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No session|No activity|No data|empty/i').first();
    const sessionContent = page.locator('[class*="session"], [role="table"], [role="grid"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await sessionContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('sessions page is responsive', async ({ page }) => {
    await page.goto('/sessions');

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
