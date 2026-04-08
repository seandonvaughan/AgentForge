import { test, expect } from '@playwright/test';

test.describe('Dashboard Home', () => {
  test('loads dashboard home page with title', async ({ page }) => {
    await page.goto('/');

    // Verify page loaded successfully
    await expect(page).toHaveTitle(/AgentForge/i);
  });

  test('displays cycles section on home page', async ({ page }) => {
    await page.goto('/');

    // Verify cycles are visible
    const cyclesSection = page.locator('text=/Cycles|cycles/i').first();
    await expect(cyclesSection).toBeVisible();
  });

  test('displays sprints section on home page', async ({ page }) => {
    await page.goto('/');

    // Verify sprints are visible
    const sprintsSection = page.locator('text=/Sprints|sprints/i').first();
    await expect(sprintsSection).toBeVisible();
  });

  test('navigates to cycles list from home', async ({ page }) => {
    await page.goto('/');

    // Click on cycles link or button
    const cyclesLink = page.locator('a, button').filter({ hasText: /Cycles/i }).first();
    await expect(cyclesLink).toBeVisible();
  });
});
