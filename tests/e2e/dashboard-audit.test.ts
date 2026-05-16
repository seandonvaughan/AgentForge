import { test, expect } from '@playwright/test';

test.describe('Audit Page (/audit)', () => {
  test('loads audit page', async ({ page }) => {
    await page.goto('/audit');

    // Verify page loaded successfully
    await expect(page).toHaveTitle(/Audit|AgentForge/i);

    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays audit heading', async ({ page }) => {
    await page.goto('/audit');

    await page.waitForLoadState('load').catch(() => {});

    // Verify main heading is visible
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 8000 });

    const headingText = await heading.textContent();
    expect(headingText).toBeTruthy();
    expect(/[A-Za-z]/.test(headingText ?? '')).toBeTruthy();
  });

  test('displays audit entries or empty state', async ({ page }) => {
    await page.goto('/audit');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Look for audit entries (table rows, list items, or audit-specific elements)
    const auditEntries = page.locator('[data-testid="audit-entry"], [data-testid="audit-log"], .audit-row, [role="row"]');
    const emptyState = page.locator('[data-testid="empty-state"], .empty-state, text=/no entries|empty/i').first();

    const hasEntries = await auditEntries.count().catch(() => 0);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    // Should have entries or an empty state
    expect(hasEntries > 0 || hasEmptyState).toBeTruthy();
  });

  test('audit page has no critical errors', async ({ page }) => {
    await page.goto('/audit');

    await page.waitForLoadState('load').catch(() => {});

    // Check for error messages
    const errorMessages = page.locator('text=/Error|500|Failed to load|Connection refused/i');
    const errorCount = await errorMessages.count();

    expect(errorCount).toBe(0);
  });

  test('audit entries display timestamps and actions', async ({ page }) => {
    await page.goto('/audit');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Look for timestamp or action columns
    const timeElements = page.locator('[data-testid="audit-timestamp"], .timestamp, time');
    const actionElements = page.locator('[data-testid="audit-action"], .action, [data-testid="action"]');

    // If there are audit entries, they should have timestamps or actions
    const entryCount = await page.locator('[data-testid="audit-entry"], .audit-row').count().catch(() => 0);
    if (entryCount > 0) {
      const timeCount = await timeElements.count().catch(() => 0);
      const actionCount = await actionElements.count().catch(() => 0);
      expect(timeCount > 0 || actionCount > 0).toBeTruthy();
    }
  });

  test('audit page supports filtering or searching', async ({ page }) => {
    await page.goto('/audit');

    await page.waitForLoadState('load').catch(() => {});

    // Look for search, filter, or query inputs
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]');
    const filterButton = page.locator('button:has-text(/filter|search/i)');

    const hasSearch = await searchInput.count().catch(() => 0);
    const hasFilter = await filterButton.count().catch(() => 0);

    // Audit pages typically have search or filter capability
    expect(hasSearch > 0 || hasFilter > 0).toBeTruthy();
  });

  test('audit page is responsive', async ({ page }) => {
    await page.goto('/audit');

    await page.waitForLoadState('load').catch(() => {});

    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Test desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('audit page loads without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/audit');
    await page.waitForLoadState('networkidle').catch(() => {});

    // Allow for some minor console warnings, but no critical errors
    const criticalErrors = errors.filter((e) => !/warning|deprecat/i.test(e));
    expect(criticalErrors.length).toBe(0);
  });
});
