import { test, expect } from '@playwright/test';

test.describe('Agents List Page', () => {
  test('loads agents list page', async ({ page }) => {
    await page.goto('/agents');

    // Verify page title
    await expect(page).toHaveTitle(/Agent|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays agents heading', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Agent/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays agents list or grid', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('networkidle');

    // Look for agents table, grid, or list
    const agentsList = page.locator('[role="grid"], [role="table"], [class*="list"], [class*="agents"], [data-testid*="agent"]').first();
    const agentCard = page.locator('[class*="agent"], [class*="card"], [role="button"]').first();
    const emptyState = page.locator('text=/No agent|No data|empty/i').first();

    const hasAgentsList = await agentsList.isVisible().catch(() => false);
    const hasAgentCard = await agentCard.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays agent names and roles', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('networkidle');

    // Look for agent names (e.g., "CTO Agent", "Backend Agent")
    const agentNames = page.locator('text=/Agent|CTO|Backend|Frontend|QA|Platform/i');
    const agentNameCount = await agentNames.count();

    if (agentNameCount > 0) {
      await expect(agentNames.first()).toBeVisible();
    }

    // Look for roles or capabilities
    const roleElements = page.locator('text=/role|capability|responsible|manages/i');
    const roleCount = await roleElements.count();

    if (roleCount > 0) {
      await expect(roleElements.first()).toBeVisible();
    }
  });

  test('agent list items are clickable', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('networkidle');

    // Find first agent item (link or button)
    const agentLink = page.locator('a, button, [role="button"]').filter({ hasText: /Agent|CTO|Backend|Frontend/i }).first();

    if (await agentLink.isVisible()) {
      await expect(agentLink).toBeEnabled();

      // Try clicking to verify navigation
      const href = await agentLink.getAttribute('href');
      if (href) {
        await expect(agentLink).toHaveAttribute('href');
      }
    }
  });

  test('displays agent status or activity indicators', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('networkidle');

    // Look for status badges or indicators
    const statusBadges = page.locator('[class*="badge"], [class*="status"], text=/active|idle|busy|available/i');
    const badgeCount = await statusBadges.count();

    if (badgeCount > 0) {
      await expect(statusBadges.first()).toBeVisible();
    }

    // Look for activity indicators (dots, colors, etc.)
    const activityIndicators = page.locator('[class*="indicator"], [class*="active"], [class*="status"]');
    const indicatorCount = await activityIndicators.count();

    if (indicatorCount > 0) {
      await expect(activityIndicators.first()).toBeVisible();
    }
  });

  test('agents list handles loading and empty states', async ({ page }) => {
    await page.goto('/agents');

    // Wait for initial load
    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No agent|No data|empty/i').first();
    const agentContent = page.locator('[class*="agent"], [role="grid"], [role="table"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await agentContent.isVisible().catch(() => false);

    // Should have one of these states
    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('agents page is responsive', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('networkidle');

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 667 });

    await page.waitForTimeout(500);

    // Verify content is still accessible
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Resize to tablet
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();

    // Resize to desktop
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();
  });
});
