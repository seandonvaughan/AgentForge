import { test, expect } from '@playwright/test';

/**
 * Sprint Detail Page — E2E coverage for /sprints/[version]
 *
 * Key sections that MUST render:
 *   1. Kanban board  (Sprint Board section)
 *   2. Success Criteria section (even when empty — shows empty-state copy)
 *   3. Audit Findings section   (even when empty — shows empty-state copy)
 *
 * Tests navigate directly to a known sprint URL so that the assertions are
 * not silently skipped when the sprint list is empty or navigation fails.
 * Using v6.7.1 because it is a completed sprint with successCriteria and no
 * auditFindings — it exercises both the populated and empty-state branches.
 */
test.describe('Sprint Detail Page', () => {
  // v6.7.1 is a stable, completed sprint that exists in .agentforge/sprints/
  const SPRINT_URL = '/sprints/6.7.1';

  test('loads the sprint detail page at a direct URL', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    // Page title must include a version number (h1 element)
    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(/v[\d.]+/i);
  });

  test('renders the Kanban Sprint Board section', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    // The kanban section heading must be present
    const boardHeading = page.getByText('Sprint Board', { exact: false });
    await expect(boardHeading).toBeVisible();

    // At least one column header must be rendered — even empty sprints show columns
    const kanbanColumn = page.locator('.kanban-column').first();
    await expect(kanbanColumn).toBeVisible();
  });

  test('renders the Success Criteria section (populated or empty state)', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    // Section heading is always rendered (never hidden)
    const criteriaHeading = page.getByText('Success Criteria', { exact: false });
    await expect(criteriaHeading).toBeVisible();

    // Either a populated list or the empty-state message must be present
    const criteriaList = page.locator('.criteria-list').first();
    const criteriaEmpty = page.locator('.criteria-card .section-empty').first();
    const hasList = await criteriaList.isVisible();
    const hasEmpty = await criteriaEmpty.isVisible();
    expect(hasList || hasEmpty).toBeTruthy();
  });

  test('renders the Audit Findings section (populated or empty state)', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    // Section heading is always rendered (never hidden)
    const findingsHeading = page.getByText('Audit Findings', { exact: false });
    await expect(findingsHeading).toBeVisible();

    // Either a populated list or the empty-state message must be present
    const findingsCard = page.locator('.findings-card').first();
    await expect(findingsCard).toBeVisible();
    const findingsList = findingsCard.locator('.criteria-list');
    const findingsEmpty = findingsCard.locator('.section-empty');
    const hasList = await findingsList.isVisible();
    const hasEmpty = await findingsEmpty.isVisible();
    expect(hasList || hasEmpty).toBeTruthy();
  });

  test('displays progress summary cards', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    // Summary row with completion stats
    const summaryRow = page.locator('.summary-row').first();
    await expect(summaryRow).toBeVisible();

    // At least one summary card (e.g. the % complete card)
    const summaryCards = summaryRow.locator('.summary-card');
    const cardCount = await summaryCards.count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test('displays priority badge labels (P0 / P1 / P2) in items list', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    // Priority badges are present when the sprint has items
    const priorityBadges = page.locator('.priority-badge');
    const badgeCount = await priorityBadges.count();
    if (badgeCount > 0) {
      // Verify at least one badge is one of the expected values
      const firstText = await priorityBadges.first().textContent();
      expect(['P0', 'P1', 'P2'].some(p => firstText?.includes(p))).toBeTruthy();
    }
  });

  test('navigates back to sprints list via back link', async ({ page }) => {
    await page.goto(SPRINT_URL);
    await page.waitForLoadState('networkidle');

    const backLink = page.locator('.back-link');
    await expect(backLink).toBeVisible();
    await backLink.click();
    await page.waitForURL('**/sprints');
    await expect(page).toHaveURL(/\/sprints\s*$/);
  });

  test('shows 404-style empty state for a non-existent sprint version', async ({ page }) => {
    await page.goto('/sprints/99.99.99-nonexistent');
    await page.waitForLoadState('networkidle');

    // Must show the "not found" empty state, not a blank page
    const emptyState = page.locator('.empty-state');
    await expect(emptyState).toBeVisible();
  });
});
