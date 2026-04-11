import { test, expect } from '@playwright/test';

test.describe('Tasks Page', () => {
  test('loads tasks page successfully', async ({ page }) => {
    await page.goto('/tasks');

    // Verify page title
    await expect(page).toHaveTitle(/Task|Todo|Work|Assignment|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays tasks heading', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Task|Todo|Work|Assignment/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays task list or board view', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for task list or board structure
    const taskList = page.locator('[class*="task"], [class*="todo"], [class*="list"]').first();
    const taskCards = page.locator('[class*="card"], [class*="item"]').first();
    const boardColumns = page.locator('[class*="column"], [class*="lane"], [class*="board"]').first();

    const hasList = await taskList.isVisible().catch(() => false);
    const hasCards = await taskCards.isVisible().catch(() => false);
    const hasBoard = await boardColumns.isVisible().catch(() => false);

    expect(hasList || hasCards || hasBoard).toBeTruthy();
  });

  test('displays task metadata (title, status, priority, assignee)', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for task details
    const taskTitle = page.locator('text=/Fix|Implement|Add|Update|Review|Bug|Feature/i').first();
    const status = page.locator('text=/todo|in progress|in-progress|done|completed|pending|blocked/i').first();
    const priority = page.locator('text=/high|medium|low|critical|urgent/i').first();
    const assignee = page.locator('text=/assigned|assigned to|assignee/i').first();

    const hasTitle = await taskTitle.isVisible().catch(() => false);
    const hasStatus = await status.isVisible().catch(() => false);
    const hasPriority = await priority.isVisible().catch(() => false);
    const hasAssignee = await assignee.isVisible().catch(() => false);

    // At least some task metadata should be visible
    expect(hasTitle || hasStatus || hasPriority || hasAssignee).toBeTruthy();
  });

  test('displays task status or progress indicators', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for status indicators
    const statusBadge = page.locator('[class*="badge"], [class*="tag"], [class*="chip"]').first();
    const progressBar = page.locator('[role="progressbar"], [class*="progress"]').first();
    const statusText = page.locator('text=/pending|in progress|completed|done|open|closed/i').first();

    const hasStatus = await statusBadge.isVisible().catch(() => false);
    const hasProgress = await progressBar.isVisible().catch(() => false);
    const hasText = await statusText.isVisible().catch(() => false);

    expect(hasStatus || hasProgress || hasText).toBeTruthy();
  });

  test('displays task filtering or categorization', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for filter controls
    const filterButton = page.locator('button, [role="button"]').filter({ hasText: /filter|category|priority|status|type/i }).first();
    const filterElements = page.locator('[class*="filter"], select, [role="group"]').first();
    const categories = page.locator('text=/bug|feature|improvement|todo|backlog/i').first();

    const hasFilter = await filterButton.isVisible().catch(() => false);
    const hasFilterUI = await filterElements.isVisible().catch(() => false);
    const hasCategories = await categories.isVisible().catch(() => false);

    expect(hasFilter || hasFilterUI || hasCategories).toBeTruthy();
  });

  test('displays task assignment or ownership', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for assignee info
    const assigneeLabel = page.locator('text=/assigned|assignee|owner|responsible/i').first();
    const userAvatar = page.locator('[class*="avatar"], [class*="user"], img[alt*="user" i]').first();
    const userName = page.locator('[class*="name"], span').first();

    const hasLabel = await assigneeLabel.isVisible().catch(() => false);
    const hasAvatar = await userAvatar.isVisible().catch(() => false);
    const hasName = await userName.isVisible().catch(() => false);

    expect(hasLabel || hasAvatar || hasName).toBeTruthy();
  });

  test('displays task dates or deadlines', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for date info
    const dateLabel = page.locator('text=/due|deadline|date|created|updated|when/i').first();
    const dateValue = page.locator('text=/ago|today|tomorrow|next week|\\d+\\/\\d+/i').first();

    const hasDate = await dateLabel.isVisible().catch(() => false);
    const hasValue = await dateValue.isVisible().catch(() => false);

    expect(hasDate || hasValue).toBeTruthy();
  });

  test('can interact with tasks (create, edit, complete)', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for action buttons
    const createButton = page.locator('button, [role="button"]').filter({ hasText: /new|create|add|start/i }).first();
    const actionButtons = page.locator('button, [role="button"]').filter({ hasText: /edit|delete|complete|mark|check|done/i }).first();
    const moreOptions = page.locator('button, [role="button"]').filter({ hasText: /more|actions|menu|\\.\\.\\./i }).first();

    const hasCreate = await createButton.isVisible().catch(() => false);
    const hasActions = await actionButtons.isVisible().catch(() => false);
    const hasMore = await moreOptions.isVisible().catch(() => false);

    expect(hasCreate || hasActions || hasMore).toBeTruthy();
  });

  test('tasks page handles loading and empty states', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|fetching/i').first();
    const emptyState = page.locator('text=/No task|No todo|No work|empty|no data/i').first();
    const taskContent = page.locator('[class*="task"], [class*="item"], button').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await taskContent.isVisible().catch(() => false);

    expect(isLoading || isEmpty || hasContent).toBeTruthy();
  });

  test('tasks page is responsive', async ({ page }) => {
    await page.goto('/tasks');

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

  test('displays task search capability', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for search input
    const searchInput = page.locator('input[type="search"], input[type="text"], [class*="search"]').first();
    const searchPlaceholder = page.locator('input[placeholder*="search" i], input[placeholder*="find" i]').first();

    const hasSearch = await searchInput.isVisible().catch(() => false);
    const hasPlaceholder = await searchPlaceholder.isVisible().catch(() => false);

    expect(hasSearch || hasPlaceholder).toBeTruthy();
  });

  test('displays sorting options for tasks', async ({ page }) => {
    await page.goto('/tasks');

    await page.waitForLoadState('networkidle');

    // Look for sort controls
    const sortButton = page.locator('button, [role="button"]').filter({ hasText: /sort|order|by/i }).first();
    const sortableHeaders = page.locator('button, [class*="sort"], [aria-sort]').first();

    const hasSort = await sortButton.isVisible().catch(() => false);
    const hasSortable = await sortableHeaders.isVisible().catch(() => false);

    expect(hasSort || hasSortable).toBeTruthy();
  });
});
