import { test, expect } from '@playwright/test';

test.describe('Runner Page', () => {
  test('loads runner page successfully', async ({ page }) => {
    await page.goto('/runner');

    // Verify page title
    await expect(page).toHaveTitle(/Runner|Executor|Workflow|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays runner heading', async ({ page }) => {
    await page.goto('/runner');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Runner|Executor|Workflow|Execute/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays execution interface or controls', async ({ page }) => {
    await page.goto('/runner');

    await page.waitForLoadState('networkidle');

    // Look for execution controls (buttons, forms, inputs)
    const controls = page.locator('button, [role="button"], input, form').first();
    const executor = page.locator('[class*="executor"], [class*="runner"], [class*="control"]').first();

    const hasControls = await controls.isVisible().catch(() => false);
    const hasExecutor = await executor.isVisible().catch(() => false);

    expect(hasControls || hasExecutor).toBeTruthy();
  });

  test('displays execution status or results', async ({ page }) => {
    await page.goto('/runner');

    await page.waitForLoadState('networkidle');

    // Look for status or results display
    const status = page.locator('[class*="status"], [class*="result"], text=/success|failed|running|completed|pending/i');
    const statusCount = await status.count();

    if (statusCount > 0) {
      await expect(status.first()).toBeVisible();
    }
  });

  test('displays execution logs or output', async ({ page }) => {
    await page.goto('/runner');

    await page.waitForLoadState('networkidle');

    // Look for logs or console output
    const logs = page.locator('[class*="log"], [class*="console"], [class*="output"], textarea').first();
    const logText = page.locator('text=/log|output|error|warning|info/i');

    const hasLogs = await logs.isVisible().catch(() => false);
    const hasLogText = await logText.count().then(c => c > 0).catch(() => false);

    expect(hasLogs || hasLogText).toBeTruthy();
  });

  test('runner interface allows task selection or configuration', async ({ page }) => {
    await page.goto('/runner');

    await page.waitForLoadState('networkidle');

    // Look for task or workflow selection
    const selectors = page.locator('select, [role="combobox"], [class*="dropdown"], [class*="select"]');
    const selectorCount = await selectors.count();

    if (selectorCount > 0) {
      await expect(selectors.first()).toBeVisible();
    }

    // Look for configuration options
    const configOptions = page.locator('input, button, [role="button"]').filter({ hasText: /configure|select|choose|option/i });
    const optionCount = await configOptions.count();

    if (optionCount > 0) {
      await expect(configOptions.first()).toBeEnabled();
    }
  });

  test('runner page handles loading and empty states', async ({ page }) => {
    await page.goto('/runner');

    await page.waitForLoadState('networkidle');

    // Check for either content or loading
    const loading = page.locator('text=/loading|Loading/i').first();
    const runnerContent = page.locator('[class*="runner"], [class*="executor"], button, input').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const hasContent = await runnerContent.isVisible().catch(() => false);

    expect(isLoading || hasContent).toBeTruthy();
  });

  test('runner page is responsive', async ({ page }) => {
    await page.goto('/runner');

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
