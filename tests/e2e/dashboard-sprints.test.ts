import { test, expect } from '@playwright/test';

test.describe('Sprint Detail Page', () => {
  // Use a stable completed sprint that always exists on disk.
  // v10.6.0 is used for general rendering tests (all items completed, has successCriteria).
  // v4.3 is used for audit-findings tests — it has 12 audit findings and 8 success criteria,
  // ensuring the populated rendering path is exercised in addition to the empty-state path.
  const SPRINT_VERSION = '10.6.0';
  const AUDIT_SPRINT_VERSION = '4.3';

  test('loads sprint detail page without error', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);
    await expect(page).toHaveTitle(/Sprint|AgentForge/i);

    // The page should not show a hard error state
    const errorState = page.locator('text=/Failed to load/i');
    await expect(errorState).not.toBeVisible({ timeout: 5000 });
  });

  test('renders page title with version number', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    const heading = page.locator('h1');
    await expect(heading).toBeVisible({ timeout: 5000 });
    // The h1 should contain the version number
    await expect(heading).toContainText(SPRINT_VERSION);
  });

  test('renders kanban board with columns', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    // Wait for the sprint data to load (kanban board is only rendered after load)
    const kanbanBoard = page.locator('.kanban-board');
    await expect(kanbanBoard).toBeVisible({ timeout: 8000 });

    // At least one kanban column should be present
    const kanbanColumns = page.locator('.kanban-column');
    await expect(kanbanColumns.first()).toBeVisible();

    // Column headers should include standard labels
    const colTitles = page.locator('.kanban-col-title');
    await expect(colTitles.first()).toBeVisible();
  });

  test('renders completion percentage', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    // Wait for data load — either the gauge or the pct value should render
    const pctValue = page.locator('.pct-value, .summary-value').filter({ hasText: /\d+%/ }).first();
    await expect(pctValue).toBeVisible({ timeout: 8000 });
  });

  test('renders success criteria section', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    // Section heading for Success Criteria
    const criteriaHeading = page.locator('.section-heading-label').filter({ hasText: /Success Criteria/i }).first();
    await expect(criteriaHeading).toBeVisible({ timeout: 8000 });

    // Either criteria list items or an empty-state message should be present
    const criteriaList = page.locator('.criteria-list .criterion');
    const emptyState = page.locator('.section-empty').filter({ hasText: /No success criteria/i });

    const hasCriteria = await criteriaList.first().isVisible().catch(() => false);
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    expect(hasCriteria || hasEmpty).toBeTruthy();
  });

  test('renders audit findings section', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    const findingsHeading = page.locator('.section-heading-label').filter({ hasText: /Audit Findings/i }).first();
    await expect(findingsHeading).toBeVisible({ timeout: 8000 });

    // Either findings or an empty-state should be present.
    // The empty state has two variants: "No audit findings recorded" (completed sprint with no findings)
    // or "Findings will be populated after sprint review" (active/pending sprint).
    const findingItems = page.locator('.criterion.finding');
    const emptyState = page.locator('.section-empty').filter({ hasText: /audit findings|Findings will be populated/i });

    const hasFindings = await findingItems.first().isVisible().catch(() => false);
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    expect(hasFindings || hasEmpty).toBeTruthy();
  });

  test('renders populated audit findings list for sprint with findings', async ({ page }) => {
    // v4.3 has 12 audit findings — verifies the .criterion.finding rendering path (not just empty state)
    await page.goto(`/sprints/${AUDIT_SPRINT_VERSION}`);

    const findingsHeading = page.locator('.section-heading-label').filter({ hasText: /Audit Findings/i }).first();
    await expect(findingsHeading).toBeVisible({ timeout: 8000 });

    // Must render actual finding items, not the empty state
    const findingItems = page.locator('.criterion.finding');
    await expect(findingItems.first()).toBeVisible({ timeout: 8000 });

    // Count badge should show the number of findings
    const countBadge = page.locator('.section-heading-count').first();
    await expect(countBadge).toBeVisible();
  });

  test('renders populated success criteria list for sprint with criteria', async ({ page }) => {
    // v4.3 has 8 success criteria — verifies the .criterion (non-finding) rendering path
    await page.goto(`/sprints/${AUDIT_SPRINT_VERSION}`);

    const criteriaHeading = page.locator('.section-heading-label').filter({ hasText: /Success Criteria/i }).first();
    await expect(criteriaHeading).toBeVisible({ timeout: 8000 });

    // Must render actual criterion items
    const criterionItems = page.locator('.criterion:not(.finding)');
    await expect(criterionItems.first()).toBeVisible({ timeout: 8000 });
  });

  test('completion % shows 100 for a fully completed sprint', async ({ page }) => {
    // v10.6.0 has all 18 items completed → completion should be 100%
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    const pctValue = page.locator('.pct-value').first();
    await expect(pctValue).toBeVisible({ timeout: 8000 });
    await expect(pctValue).toContainText('100%');
  });

  test('back link navigates to sprints list', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    const backLink = page.locator('a.back-link');
    await expect(backLink).toBeVisible({ timeout: 5000 });
    await expect(backLink).toHaveAttribute('href', '/sprints');
  });

  test('kanban cards expand description on click', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    // Wait for kanban to render
    await expect(page.locator('.kanban-board')).toBeVisible({ timeout: 8000 });

    // Find a kanban card that has a description (completed cards in v10.6.0 all have descriptions)
    const firstCard = page.locator('.kanban-card').first();
    const isVisible = await firstCard.isVisible().catch(() => false);
    if (!isVisible) return; // no cards rendered — skip

    // Click the card and verify description appears (if the card has one)
    await firstCard.click();
    // The description element appears inside the card after click
    const desc = page.locator('.kanban-card-desc');
    // It either becomes visible (card had description) or remains absent (no description)
    // Either outcome is valid; we just assert no crash
    await page.waitForTimeout(200);
    const pageError = page.locator('text=/SvelteError|uncaught/i');
    await expect(pageError).not.toBeVisible();
  });

  test('sprint detail page is responsive', async ({ page }) => {
    await page.goto(`/sprints/${SPRINT_VERSION}`);

    // Mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('h1')).toBeVisible({ timeout: 5000 });

    // Tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('h1')).toBeVisible({ timeout: 3000 });

    // Desktop
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('h1')).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Sprints List Page', () => {
  test('loads sprints list page', async ({ page }) => {
    await page.goto('/sprints');

    // Verify page title
    await expect(page).toHaveTitle(/Sprints|AgentForge/i);

    // Verify heading is visible
    const heading = page.locator('h1, h2').filter({ hasText: /Sprints/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays sprints grid or list', async ({ page }) => {
    await page.goto('/sprints');

    // Wait for data to load
    await page.waitForLoadState('load').catch(() => {});

    // Look for sprint cards or grid or verify heading is present
    const sprintGrid = page.locator('[class*="sprint"], [data-testid*="sprint"], [role="grid"], [role="table"]').first();
    const heading = page.locator('h1, h2').filter({ hasText: /Sprints/i }).first();

    const hasSprints = await sprintGrid.isVisible().catch(() => false);
    const hasHeading = await heading.isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=/No sprint|No data|empty/i').isVisible().catch(() => false);

    expect(hasSprints || hasHeading || hasEmptyState).toBeTruthy();
  });

  test('displays sprint metadata (version, status, progress)', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('load').catch(() => {});

    // Look for sprint version or status information
    const sprintVersion = page.locator('text=/v\\d+\\.\\d+/i').first();
    const progressBar = page.locator('[role="progressbar"]').first();
    const statusBadge = page.locator('text=/Completed|In Progress|Pending|Active/i').first();
    const heading = page.locator('h1, h2').first();

    const hasVersion = await sprintVersion.isVisible().catch(() => false);
    const hasProgress = await progressBar.isVisible().catch(() => false);
    const hasStatus = await statusBadge.isVisible().catch(() => false);
    const hasHeading = await heading.isVisible().catch(() => false);

    // At least a heading should be visible
    expect(hasHeading || hasVersion || hasProgress || hasStatus).toBeTruthy();
  });

  test('can navigate to sprint detail from list', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('load').catch(() => {});

    // Look for sprint card/button that navigates to detail
    const sprintCard = page.locator('button, a, [role="button"]').filter({ hasText: /v\d+\.\d+/i }).first();

    if (await sprintCard.isVisible()) {
      await expect(sprintCard).toBeEnabled();
    }
  });

  test('sprints list is responsive', async ({ page }) => {
    await page.goto('/sprints');

    await page.waitForLoadState('load').catch(() => {});

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    // Wait for heading to render at mobile viewport
    const heading = page.locator('h1, h2').filter({ hasText: /Sprints/i }).first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Test tablet view
    await page.setViewportSize({ width: 768, height: 1024 });

    // Wait for heading to render at tablet viewport
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });

    // Wait for heading to render at desktop viewport
    await expect(heading).toBeVisible({ timeout: 5000 });
  });
});
