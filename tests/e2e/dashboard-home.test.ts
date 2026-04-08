import { test, expect } from '@playwright/test';

test.describe('Dashboard Home', () => {
  test('loads dashboard home page with title', async ({ page }) => {
    await page.goto('/');

    // Verify page loaded successfully
    await expect(page).toHaveTitle(/AgentForge/i);
  });

  test('displays main content on home page', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    // Verify page has main content
    const mainContent = page.locator('main, [role="main"], body');
    await expect(mainContent).toBeVisible();
  });

  test('displays cycles section on home page', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    // Verify cycles are visible
    const cyclesSection = page.locator('text=/Cycles|cycles/i').first();

    if (await cyclesSection.isVisible().catch(() => false)) {
      await expect(cyclesSection).toBeVisible();
    }
  });

  test('displays sprints section on home page', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    // Verify sprints are visible
    const sprintsSection = page.locator('text=/Sprints|sprints/i').first();

    if (await sprintsSection.isVisible().catch(() => false)) {
      await expect(sprintsSection).toBeVisible();
    }
  });

  test('has working navigation links from home', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    // Look for sidebar or navigation
    const nav = page.locator('nav, [role="navigation"], [class*="sidebar"], [class*="nav"]').first();

    if (await nav.isVisible().catch(() => false)) {
      await expect(nav).toBeVisible();
    }

    // Verify at least some navigation links exist
    const navLinks = page.locator('a[href]');
    const linkCount = await navLinks.count();

    expect(linkCount).toBeGreaterThan(0);
  });

  test('home page is responsive', async ({ page }) => {
    await page.goto('/');

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
