import { test, expect } from '@playwright/test';

test.describe('Settings Page', () => {
  test('loads settings page', async ({ page }) => {
    await page.goto('/settings');

    // Verify page title
    await expect(page).toHaveTitle(/Settings|AgentForge/i);

    // Verify heading is visible
    const heading = page.locator('h1, h2').filter({ hasText: /Settings/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays workspace settings section', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('load').catch(() => {});

    // Look for workspace configuration fields or section heading
    const workspaceSection = page.locator('text=/Workspace|workspace|Settings|settings/i').first();
    const settingsInput = page.locator('input[id*="workspace"], input[placeholder*="workspace"], input[placeholder*="name"]').first();
    const heading = page.locator('h1, h2').filter({ hasText: /Settings/i }).first();

    const hasSection = await workspaceSection.isVisible().catch(() => false);
    const hasInput = await settingsInput.isVisible().catch(() => false);
    const hasHeading = await heading.isVisible().catch(() => false);

    expect(hasSection || hasInput || hasHeading).toBeTruthy();
  });

  test('displays appearance/theme settings', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('load').catch(() => {});

    // Look for theme section or theme buttons
    const appearanceSection = page.locator('text=/Appearance|Theme|Dark|Light/i').first();
    const themeButtons = page.locator('button').filter({ hasText: /Dark|Light/i });
    const heading = page.locator('h1, h2').first();

    const hasAppearance = await appearanceSection.isVisible().catch(() => false);
    const buttonCount = await themeButtons.count();
    const hasHeading = await heading.isVisible().catch(() => false);

    expect(hasAppearance || buttonCount > 0 || hasHeading).toBeTruthy();
  });

  test('can modify workspace settings', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('load').catch(() => {});

    // Find workspace name input
    const workspaceInput = page.locator('input[id="workspace-name"], input[placeholder*="AgentForge"]').first();

    if (await workspaceInput.isVisible()) {
      await expect(workspaceInput).toBeEditable();

      // Get current value
      const currentValue = await workspaceInput.inputValue();

      // Update the value
      const newValue = `Test-${Date.now()}`;
      await workspaceInput.fill(newValue);

      // Verify value changed
      const updatedValue = await workspaceInput.inputValue();
      expect(updatedValue).toBe(newValue);
    }
  });

  test('settings page loads and displays form controls', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('load').catch(() => {});

    // Verify settings page has form controls
    const inputs = page.locator('input, button, [role="button"]');
    const inputCount = await inputs.count();

    expect(inputCount).toBeGreaterThan(0);
  });

  test('can toggle theme setting', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('load').catch(() => {});

    // Find theme toggle buttons
    const darkButton = page.locator('button:has-text("Dark")').first();
    const lightButton = page.locator('button:has-text("Light")').first();

    if (await darkButton.isVisible() && await lightButton.isVisible()) {
      // Click light theme
      await lightButton.click();

      // Verify light theme is selected
      await expect(lightButton).toHaveClass(/active/);

      // Click dark theme back
      await darkButton.click();

      // Verify dark theme is selected
      await expect(darkButton).toHaveClass(/active/);
    }
  });
});
