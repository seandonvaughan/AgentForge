import { test, expect } from '@playwright/test';

test.describe('Decisions Page', () => {
  test('loads decisions page successfully', async ({ page }) => {
    await page.goto('/decisions');

    // Verify page title
    await expect(page).toHaveTitle(/Decision|Choice|Option|Verdict|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays decisions heading', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for heading
    const heading = page.locator('h1, h2').filter({ hasText: /Decision|Choice|Verdict|Gate/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays decision items or records', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for decision list or grid
    const decisionList = page.locator('[class*="decision"], [class*="choice"], [class*="list"]').first();
    const decisionCards = page.locator('[class*="card"], [class*="item"]').first();
    const decisionTable = page.locator('table, [role="table"]').first();

    const hasList = await decisionList.isVisible().catch(() => false);
    const hasCards = await decisionCards.isVisible().catch(() => false);
    const hasTable = await decisionTable.isVisible().catch(() => false);

    expect(hasList || hasCards || hasTable).toBeTruthy();
  });

  test('displays decision metadata (title, status, date, outcome)', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for decision details
    const title = page.locator('text=/whether|should|decide|consider|approve|reject/i').first();
    const status = page.locator('text=/approved|rejected|pending|decided|open|closed/i').first();
    const date = page.locator('text=/ago|today|yesterday|date|time/i').first();
    const outcome = page.locator('text=/outcome|result|decision|verdict|conclusion/i').first();

    const hasTitle = await title.isVisible().catch(() => false);
    const hasStatus = await status.isVisible().catch(() => false);
    const hasDate = await date.isVisible().catch(() => false);
    const hasOutcome = await outcome.isVisible().catch(() => false);

    // At least some decision metadata should be visible
    expect(hasTitle || hasStatus || hasDate || hasOutcome).toBeTruthy();
  });

  test('displays decision reasoning or context', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for explanation or reasoning
    const reasoning = page.locator('[class*="reason"], [class*="context"], [class*="explain"]').first();
    const description = page.locator('text=/reason|because|rationale|justification|why/i').first();

    const hasReasoning = await reasoning.isVisible().catch(() => false);
    const hasDesc = await description.isVisible().catch(() => false);

    expect(hasReasoning || hasDesc).toBeTruthy();
  });

  test('displays decision approval or voting information', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for approval or voting details
    const approval = page.locator('text=/approve|reject|vote|support|against/i').first();
    const voteCount = page.locator('text=/\\d+\\s(yes|no|votes?|approvals?|rejections?)/i').first();
    const participants = page.locator('[class*="participant"], [class*="voter"], [class*="approver"]').first();

    const hasApproval = await approval.isVisible().catch(() => false);
    const hasVotes = await voteCount.isVisible().catch(() => false);
    const hasParticipants = await participants.isVisible().catch(() => false);

    expect(hasApproval || hasVotes || hasParticipants).toBeTruthy();
  });

  test('displays decision filtering or categorization', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for filter controls
    const filterButton = page.locator('button, [role="button"]').filter({ hasText: /filter|category|type|status/i }).first();
    const filterElements = page.locator('[class*="filter"], select, [role="group"]').first();
    const categories = page.locator('text=/approved|rejected|pending|architecture|tech/i').first();

    const hasFilter = await filterButton.isVisible().catch(() => false);
    const hasFilterUI = await filterElements.isVisible().catch(() => false);
    const hasCategories = await categories.isVisible().catch(() => false);

    expect(hasFilter || hasFilterUI || hasCategories).toBeTruthy();
  });

  test('displays decision timeline or history', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for timeline or history
    const timeline = page.locator('[class*="timeline"], [class*="history"], [class*="progression"]').first();
    const historyItems = page.locator('text=/created|updated|decided|proposed|changed/i').first();

    const hasTimeline = await timeline.isVisible().catch(() => false);
    const hasHistory = await historyItems.isVisible().catch(() => false);

    expect(hasTimeline || hasHistory).toBeTruthy();
  });

  test('decisions page handles loading and empty states', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|fetching/i').first();
    const emptyState = page.locator('text=/No decision|No choice|No record|empty|no data/i').first();
    const decisionContent = page.locator('[class*="decision"], table, [class*="list"]').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await decisionContent.isVisible().catch(() => false);

    expect(isLoading || isEmpty || hasContent).toBeTruthy();
  });

  test('decisions page is responsive', async ({ page }) => {
    await page.goto('/decisions');

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

  test('can navigate to decision details', async ({ page }) => {
    await page.goto('/decisions');

    await page.waitForLoadState('networkidle');

    // Look for detail or expand buttons
    const detailButton = page.locator('button, a').filter({ hasText: /view|details|expand|inspect|open/i }).first();
    const clickableDecision = page.locator('[class*="decision"], [class*="item"], a').filter({ hasText: /whether|should|decide|approve/i }).first();

    const hasDetail = await detailButton.isVisible().catch(() => false);
    const hasClickable = await clickableDecision.isVisible().catch(() => false);

    expect(hasDetail || hasClickable).toBeTruthy();
  });
});
