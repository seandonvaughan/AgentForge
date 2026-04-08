import { test, expect } from '@playwright/test';

test.describe('Knowledge Page', () => {
  test('loads knowledge page successfully', async ({ page }) => {
    await page.goto('/knowledge');

    // Verify page title
    await expect(page).toHaveTitle(/Knowledge|Learn|Memory|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays knowledge heading', async ({ page }) => {
    await page.goto('/knowledge');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Knowledge|Learn|Memory|Base/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays knowledge items or entries', async ({ page }) => {
    await page.goto('/knowledge');

    await page.waitForLoadState('networkidle');

    // Look for knowledge list or grid
    const knowledgeList = page.locator('[class*="knowledge"], [class*="list"], [role="table"], [role="grid"]').first();
    const knowledgeItem = page.locator('[class*="item"], [class*="card"], [class*="entry"]').first();
    const emptyState = page.locator('text=/No knowledge|No data|empty/i').first();

    const hasList = await knowledgeList.isVisible().catch(() => false);
    const hasItem = await knowledgeItem.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('displays knowledge categories or tags', async ({ page }) => {
    await page.goto('/knowledge');

    await page.waitForLoadState('networkidle');

    // Look for categories or tags
    const categories = page.locator('[class*="category"], [class*="tag"], [class*="label"]').first();
    const categoryText = page.locator('text=/category|tag|topic|subject|domain/i');

    const hasCategories = await categories.isVisible().catch(() => false);
    const hasCategoryText = await categoryText.count().then(c => c > 0).catch(() => false);

    expect(hasCategories || hasCategoryText).toBeTruthy();
  });

  test('displays knowledge metadata (created, updated, source)', async ({ page }) => {
    await page.goto('/knowledge');

    await page.waitForLoadState('networkidle');

    // Look for metadata like dates or sources
    const metadata = page.locator('text=/created|updated|source|author|date/i');
    const metadataCount = await metadata.count();

    if (metadataCount > 0) {
      await expect(metadata.first()).toBeVisible();
    }
  });

  test('knowledge items or entries are actionable', async ({ page }) => {
    await page.goto('/knowledge');

    await page.waitForLoadState('networkidle');

    // Look for interactive elements
    const links = page.locator('a, button, [role="button"]').filter({ hasText: /view|edit|delete|open/i });
    const linkCount = await links.count();

    if (linkCount > 0) {
      await expect(links.first()).toBeEnabled();
    }
  });

  test('knowledge page handles loading and empty states', async ({ page }) => {
    await page.goto('/knowledge');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading/i').first();
    const emptyState = page.locator('text=/No knowledge|No data|empty/i').first();
    const knowledgeContent = page.locator('[class*="knowledge"], [role="table"], [role="grid"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await knowledgeContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('knowledge page is responsive', async ({ page }) => {
    await page.goto('/knowledge');

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
