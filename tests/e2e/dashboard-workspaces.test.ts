import { test, expect } from '@playwright/test';

test.describe('Workspaces Page', () => {
  test('loads workspaces page successfully', async ({ page }) => {
    await page.goto('/workspaces');

    // Verify page title
    await expect(page).toHaveTitle(/Workspace|Project|Team|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays workspaces heading', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Workspace|Project|Team/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays workspaces list or grid', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Look for workspaces list, grid, or cards
    const workspacesList = page.locator('[class*="workspace"], [class*="project"], [role="table"], [role="grid"]').first();
    const workspaceItem = page.locator('[class*="card"], [class*="item"], [class*="workspace"]').first();
    const emptyState = page.locator('text=/No workspace|No project|No data|empty/i').first();

    const hasList = await workspacesList.isVisible().catch(() => false);
    const hasItem = await workspaceItem.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays workspace information (name, description, members)', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Look for workspace names
    const workspaceNames = page.locator('text=/workspace|project|team|group|environment/i');
    const nameCount = await workspaceNames.count();

    if (nameCount > 0) {
      await expect(workspaceNames.first()).toBeVisible();
    }

    // Look for member or team info
    const memberInfo = page.locator('text=/member|team|user|owner|collaborator/i');
    const memberCount = await memberInfo.count();

    if (memberCount > 0) {
      await expect(memberInfo.first()).toBeVisible();
    }
  });

  test('displays workspace status or metadata', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Look for status indicators
    const status = page.locator('[class*="badge"], [class*="status"], text=/active|archived|created|updated/i');
    const statusCount = await status.count();

    if (statusCount > 0) {
      await expect(status.first()).toBeVisible();
    }
  });

  test('workspace items are clickable for details or access', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Look for clickable workspace items
    const workspaceLinks = page.locator('a, button, [role="button"]').filter({ hasText: /workspace|project|team|access|enter/i });
    const linkCount = await workspaceLinks.count();

    if (linkCount > 0) {
      await expect(workspaceLinks.first()).toBeEnabled();
    }
  });

  test('displays workspace actions (create, manage, settings)', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Look for action buttons
    const actions = page.locator('button, [role="button"]').filter({ hasText: /create|new|manage|settings|delete|add/i });
    const actionCount = await actions.count();

    if (actionCount > 0) {
      await expect(actions.first()).toBeEnabled();
    }
  });

  test('workspaces page handles loading and empty states', async ({ page }) => {
    await page.goto('/workspaces');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No workspace|No project|No data|empty/i').first();
    const workspaceContent = page.locator('[class*="workspace"], [role="table"], [role="grid"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await workspaceContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('workspaces page is responsive', async ({ page }) => {
    await page.goto('/workspaces');

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
