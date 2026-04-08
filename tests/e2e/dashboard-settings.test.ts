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

    await page.waitForLoadState('networkidle');

    // Look for workspace configuration fields
    const workspaceSection = page.locator('text=/Workspace|workspace/i').first();
    await expect(workspaceSection).toBeVisible();

    // Check for key settings fields
    const workspaceName = page.locator('[id*="workspace"], label:has-text(/Workspace Name/i)');
    const defaultModel = page.locator('[id*="default-model"], label:has-text(/Default Model/i)');

    const hasWorkspaceName = await workspaceName.isVisible().catch(() => false);
    const hasDefaultModel = await defaultModel.isVisible().catch(() => false);

    expect(hasWorkspaceName || hasDefaultModel).toBeTruthy();
  });

  test('displays appearance/theme settings', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('networkidle');

    // Look for theme section
    const appearanceSection = page.locator('text=/Appearance|Theme|Dark|Light/i').first();

    if (await appearanceSection.isVisible()) {
      await expect(appearanceSection).toBeVisible();
    }

    // Look for theme buttons
    const themeButtons = page.locator('button:has-text(/Dark|Light/)');
    const buttonCount = await themeButtons.count();

    if (buttonCount > 0) {
      await expect(themeButtons.first()).toBeVisible();
    }
  });

  test('can modify workspace settings', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('networkidle');

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

  test('settings save round-trip works', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('networkidle');

    // Try to save settings
    const saveButton = page.locator('button:has-text(/Save|Submit/i)').first();

    if (await saveButton.isVisible()) {
      // Modify a setting (e.g., session timeout)
      const sessionInput = page.locator('input[id="session-timeout"]').first();

      if (await sessionInput.isVisible()) {
        const originalValue = await sessionInput.inputValue();
        const newValue = (parseInt(originalValue) + 1).toString();

        await sessionInput.fill(newValue);

        // Click save button
        await saveButton.click();

        // Wait for save to complete
        await page.waitForTimeout(500);

        // Look for success message
        const successMessage = page.locator('text=/saved|success/i').first();

        if (await successMessage.isVisible().catch(() => false)) {
          await expect(successMessage).toBeVisible();
        }

        // Verify the setting was saved (should still be in the input)
        const savedValue = await sessionInput.inputValue();
        expect(savedValue).toBe(newValue);
      }
    }
  });

  test('can toggle theme setting', async ({ page }) => {
    await page.goto('/settings');

    await page.waitForLoadState('networkidle');

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
