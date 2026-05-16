import { test, expect } from '@playwright/test';

test.describe('Inbox Page (/inbox)', () => {
  test('loads inbox page with title', async ({ page }) => {
    await page.goto('/inbox');

    // Verify page loaded successfully
    await expect(page).toHaveTitle(/Inbox|AgentForge/i);

    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays inbox heading', async ({ page }) => {
    await page.goto('/inbox');

    await page.waitForLoadState('load').catch(() => {});

    // Verify main heading is visible
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 8000 });

    const headingText = await heading.textContent();
    expect(headingText).toBeTruthy();
  });

  test('displays inbox messages or empty state', async ({ page }) => {
    await page.goto('/inbox');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Should have either messages or an empty state
    const messages = page.locator('[data-testid="inbox-message"], .inbox-item, .message-row').first();
    const emptyState = page.locator('[data-testid="empty-state"], .empty-state').first();

    const hasMessages = await messages.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    expect(hasMessages || hasEmptyState).toBeTruthy();
  });

  test('inbox page has no critical errors', async ({ page }) => {
    await page.goto('/inbox');

    await page.waitForLoadState('load').catch(() => {});

    // Check for error messages that indicate page failure
    const errorMessages = page.locator('text=/Error|500|Failed to load|Connection refused/i');
    const errorCount = await errorMessages.count();

    expect(errorCount).toBe(0);
  });

  test('inbox page displays inbox count or status', async ({ page }) => {
    await page.goto('/inbox');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Look for message count, status badge, or inbox indicator
    const badge = page.locator('[data-testid="inbox-count"], .badge, .pill, .count-indicator');
    const heading = page.locator('h1, h2, .page-title').first();

    const hasBadge = await badge.count().catch(() => 0);
    const headingText = await heading.textContent().catch(() => '');

    // Either a badge exists or the heading mentions inbox
    expect(hasBadge > 0 || /inbox|message/i.test(headingText)).toBeTruthy();
  });

  test('inbox page is responsive', async ({ page }) => {
    await page.goto('/inbox');

    await page.waitForLoadState('load').catch(() => {});

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('inbox messages are readable if present', async ({ page }) => {
    await page.goto('/inbox');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Look for message content (either in DOM or rendered)
    const messageContent = page.locator('[data-testid="inbox-message-content"], .message-content, .message-body').first();

    const hasContent = await messageContent.isVisible().catch(() => false);

    if (hasContent) {
      const text = await messageContent.textContent().catch(() => '');
      // If message is visible, it should have some text content
      expect(text).toBeTruthy();
    }
    // Otherwise, just having messages/empty state is fine
  });
});
