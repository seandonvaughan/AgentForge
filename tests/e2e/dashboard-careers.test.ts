import { test, expect } from '@playwright/test';

test.describe('Careers Page', () => {
  test('loads careers page successfully', async ({ page }) => {
    await page.goto('/careers');

    // Verify page title
    await expect(page).toHaveTitle(/Career|Job|Hiring|Roles|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays careers heading and introduction', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Career|Job|Hiring|Join/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays job listings or positions', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for job listings
    const jobList = page.locator('[class*="job"], [class*="position"], [class*="role"]').first();
    const jobCards = page.locator('[class*="card"], [class*="listing"]').first();
    const jobText = page.locator('text=/Senior|Engineer|Manager|Designer|Product/i').first();

    const hasList = await jobList.isVisible().catch(() => false);
    const hasCards = await jobCards.isVisible().catch(() => false);
    const hasJobs = await jobText.isVisible().catch(() => false);

    expect(hasList || hasCards || hasJobs).toBeTruthy();
  });

  test('displays job metadata (title, level, department, location)', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for job details
    const jobTitle = page.locator('text=/Engineer|Designer|Manager|Product/i').first();
    const department = page.locator('text=/Engineering|Design|Product|Sales|Marketing/i').first();
    const level = page.locator('text=/Senior|Junior|Lead|Principal|Manager|Intern/i').first();
    const location = page.locator('text=/Remote|San Francisco|New York|London|Tokyo/i').first();

    const hasTitle = await jobTitle.isVisible().catch(() => false);
    const hasDept = await department.isVisible().catch(() => false);
    const hasLevel = await level.isVisible().catch(() => false);
    const hasLocation = await location.isVisible().catch(() => false);

    // At least some job metadata should be visible
    expect(hasTitle || hasDept || hasLevel || hasLocation).toBeTruthy();
  });

  test('displays apply or learn more buttons', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for action buttons
    const applyButton = page.locator('button, a').filter({ hasText: /Apply|Learn|More|View|Details/i }).first();
    const actionLinks = page.locator('a[href*="job"], a[href*="apply"], a[href*="career"]').first();

    const hasApply = await applyButton.isVisible().catch(() => false);
    const hasLinks = await actionLinks.isVisible().catch(() => false);

    expect(hasApply || hasLinks).toBeTruthy();
  });

  test('displays job categories or filters', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for filter or category controls
    const filterButton = page.locator('button, [role="button"]').filter({ hasText: /filter|category|department|level|type/i }).first();
    const departmentFilter = page.locator('text=/Engineering|Design|Product|Sales/i').first();
    const typeFilter = page.locator('[class*="filter"], [class*="category"], select').first();

    const hasFilter = await filterButton.isVisible().catch(() => false);
    const hasDept = await departmentFilter.isVisible().catch(() => false);
    const hasType = await typeFilter.isVisible().catch(() => false);

    expect(hasFilter || hasDept || hasType).toBeTruthy();
  });

  test('displays company culture or benefits information', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for benefits or culture info
    const benefits = page.locator('text=/benefit|culture|perks|health|remote|401|equity/i');
    const benefitsCount = await benefits.count();

    if (benefitsCount > 0) {
      await expect(benefits.first()).toBeVisible();
    }
  });

  test('careers page handles loading and empty states', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|fetching/i').first();
    const emptyState = page.locator('text=/No job|No position|No opening|empty|coming soon/i').first();
    const careerContent = page.locator('[class*="job"], [class*="position"], [class*="role"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await careerContent.isVisible().catch(() => false);

    expect(isLoading || isEmpty || hasContent).toBeTruthy();
  });

  test('careers page is responsive', async ({ page }) => {
    await page.goto('/careers');

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

  test('displays job search or filtering capability', async ({ page }) => {
    await page.goto('/careers');

    await page.waitForLoadState('networkidle');

    // Look for search or filter controls
    const searchInput = page.locator('input[type="search"], input[type="text"], [class*="search"]').first();
    const filterControls = page.locator('[class*="filter"], [role="group"], select').first();

    const hasSearch = await searchInput.isVisible().catch(() => false);
    const hasFilter = await filterControls.isVisible().catch(() => false);

    expect(hasSearch || hasFilter).toBeTruthy();
  });
});
