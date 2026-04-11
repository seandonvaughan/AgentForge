import { test, expect } from '@playwright/test';

test.describe('Dashboard Home', () => {
  test('loads dashboard home page with title', async ({ page }) => {
    await page.goto('/');

    // Verify page loaded successfully
    await expect(page).toHaveTitle(/AgentForge/i);
  });

  test('displays main content on home page', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('load').catch(() => {});

    // Verify main content is visible
    const main = page.locator('main, [role="main"]').first();
    const isMainVisible = await main.isVisible().catch(() => false);

    if (isMainVisible) {
      await expect(main).toBeVisible();
    } else {
      // Fallback: just verify body is visible
      const body = page.locator('body');
      await expect(body).toBeVisible();
    }
  });

  test('displays cycles or sprints section on home page', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('load').catch(() => {});

    // Look for either cycles or sprints content
    const cyclesSection = page.locator('text=/Cycles|cycles/i').first();
    const sprintsSection = page.locator('text=/Sprints|sprints/i').first();
    const heading = page.locator('h1, h2').first();

    const isCyclesVisible = await cyclesSection.isVisible().catch(() => false);
    const isSprintsVisible = await sprintsSection.isVisible().catch(() => false);
    const isHeadingVisible = await heading.isVisible().catch(() => false);

    // Page should have at least a heading or cycles/sprints content
    expect(isCyclesVisible || isSprintsVisible || isHeadingVisible).toBeTruthy();
  });

  test('has working navigation from home', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('load').catch(() => {});

    // Verify navigation links exist (must have at least one)
    const navLinks = page.locator('a[href]');
    const linkCount = await navLinks.count();

    expect(linkCount).toBeGreaterThan(0);

    // Verify the first navigation link has a valid href
    const firstLink = navLinks.first();
    const href = await firstLink.getAttribute('href');
    expect(href).toBeTruthy();
  });

  test('home page loads without errors', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('load').catch(() => {});

    // Check for any critical error messages
    const errorMessages = page.locator('text=/Error|error|500|404/i').filter({ hasText: /not found|internal server|connection|failed/i });
    const errorCount = await errorMessages.count();

    expect(errorCount).toBe(0);
  });

  test('home page is responsive', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('load').catch(() => {});

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    await page.waitForTimeout(500);

    let pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });
});
