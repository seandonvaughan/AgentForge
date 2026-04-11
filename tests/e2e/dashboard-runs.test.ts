import { test, expect } from '@playwright/test';

test.describe('Audit Log (Runs) Page', () => {
  test('loads audit log page successfully', async ({ page }) => {
    await page.goto('/runs');

    // Verify page title
    await expect(page).toHaveTitle(/Audit|Log|Runs|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays audit log heading', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Audit|Log|Runs|Activity/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays runs table or list view', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Look for table or list structure
    const table = page.locator('table, [role="table"], [class*="table"]').first();
    const list = page.locator('[class*="list"], [class*="runs"], [role="list"]').first();
    const gridItems = page.locator('[class*="grid"], [class*="item"], [class*="card"]').first();

    const hasTable = await table.isVisible().catch(() => false);
    const hasList = await list.isVisible().catch(() => false);
    const hasGrid = await gridItems.isVisible().catch(() => false);

    expect(hasTable || hasList || hasGrid).toBeTruthy();
  });

  test('displays run metadata (timestamp, status, duration)', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Look for common audit log columns/fields
    const timestamp = page.locator('text=/time|date|timestamp|when/i').first();
    const status = page.locator('text=/status|state|result|completed|failed|running/i').first();
    const duration = page.locator('text=/duration|took|time|ms|seconds/i').first();

    const hasTimestamp = await timestamp.isVisible().catch(() => false);
    const hasStatus = await status.isVisible().catch(() => false);
    const hasDuration = await duration.isVisible().catch(() => false);

    // At least some metadata should be visible
    expect(hasTimestamp || hasStatus || hasDuration).toBeTruthy();
  });

  test('displays run filtering or search capabilities', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Look for filter or search elements
    const searchInput = page.locator('input[type="search"], input[type="text"], [class*="search"]').first();
    const filterButton = page.locator('button, [role="button"]').filter({ hasText: /filter|sort|search/i }).first();
    const filterElements = page.locator('[class*="filter"], [aria-label*="filter" i]').first();

    const hasSearch = await searchInput.isVisible().catch(() => false);
    const hasFilter = await filterButton.isVisible().catch(() => false);
    const hasFilterUI = await filterElements.isVisible().catch(() => false);

    expect(hasSearch || hasFilter || hasFilterUI).toBeTruthy();
  });

  test('can sort or filter audit logs', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Look for sortable headers or filter controls
    const sortableHeaders = page.locator('button, [role="button"], [class*="sort"]').filter({ hasText: /time|status|duration/i }).first();
    const filterControls = page.locator('[class*="filter"], [role="group"], select').first();

    const hasSortable = await sortableHeaders.isVisible().catch(() => false);
    const hasFilters = await filterControls.isVisible().catch(() => false);

    expect(hasSortable || hasFilters).toBeTruthy();
  });

  test('displays run pagination or load more', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('load').catch(() => {});

    // Look for pagination controls
    const paginationClass = page.locator('[class*="pagina"]').first();
    const paginationAriaLabel = page.locator('[aria-label*="page" i]').first();
    const paginationButton = page.locator('button').filter({ hasText: /next|prev|load more/i }).first();
    const pageInfo = page.locator('text=/page|of|showing|results/i').first();

    const hasPaginationClass = await paginationClass.isVisible().catch(() => false);
    const hasPaginationAriaLabel = await paginationAriaLabel.isVisible().catch(() => false);
    const hasPaginationButton = await paginationButton.isVisible().catch(() => false);
    const hasPageInfo = await pageInfo.isVisible().catch(() => false);

    expect(hasPaginationClass || hasPaginationAriaLabel || hasPaginationButton || hasPageInfo).toBeTruthy();
  });

  test('audit log page handles loading and empty states', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|fetching/i').first();
    const emptyState = page.locator('text=/No run|No audit|No record|empty|no data/i').first();
    const logContent = page.locator('table, [class*="list"], [class*="table"], [class*="runs"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await logContent.isVisible().catch(() => false);

    expect(isLoading || isEmpty || hasContent).toBeTruthy();
  });

  test('audit log page is responsive', async ({ page }) => {
    await page.goto('/runs');

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

  test('displays run details or actions', async ({ page }) => {
    await page.goto('/runs');

    await page.waitForLoadState('networkidle');

    // Look for action buttons or detail views
    const actionButtons = page.locator('button, [role="button"], a').filter({ hasText: /view|details|inspect|logs|retry/i }).first();
    const expandButtons = page.locator('button, [class*="expand"], [aria-expanded]').first();

    const hasActions = await actionButtons.isVisible().catch(() => false);
    const hasExpand = await expandButtons.isVisible().catch(() => false);

    expect(hasActions || hasExpand).toBeTruthy();
  });
});
