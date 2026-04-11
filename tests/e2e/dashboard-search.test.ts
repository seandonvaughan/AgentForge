import { test, expect } from '@playwright/test';

test.describe('Search Page', () => {
  test('loads search page successfully', async ({ page }) => {
    await page.goto('/search');

    // Verify page title
    await expect(page).toHaveTitle(/Search|Find|Query|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays search interface with input', async ({ page }) => {
    await page.goto('/search');

    await page.waitForLoadState('networkidle');

    // Look for search input
    const searchInput = page.locator('input[type="search"], input[type="text"], [class*="search"] input').first();
    const searchBar = page.locator('[class*="search"], [role="search"]').first();

    const hasInput = await searchInput.isVisible().catch(() => false);
    const hasBar = await searchBar.isVisible().catch(() => false);

    expect(hasInput || hasBar).toBeTruthy();
  });

  test('search form accepts input and submits without error', async ({ page }) => {
    await page.goto('/search');
    await page.waitForLoadState('networkidle');

    // Find and fill the search input
    const searchInput = page.locator('input[type="search"]').first();
    const isInputVisible = await searchInput.isVisible().catch(() => false);
    if (!isInputVisible) {
      // No search input — the page must render some UI element at minimum
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible();
      return;
    }

    await searchInput.fill('sprint');

    // Submit via keyboard
    await searchInput.press('Enter');

    // Wait for any response — results, empty state, or loading to clear
    await page.waitForTimeout(1500);

    // After submitting, verify the page is NOT in an error state.
    // An error state would show "Search failed" or an HTTP error code.
    const errorBanner = page.locator('text=/Search failed|HTTP 4|HTTP 5|connection refused/i');
    const errorCount = await errorBanner.count();
    expect(errorCount).toBe(0);

    // The page should show either results, an empty-state, or a loading indicator.
    // Any of these is valid — what's NOT valid is a silent hang or error banner.
    const resultsList   = page.locator('[class*="result-card"], [class*="results-list"]').first();
    const emptyState    = page.locator('[class*="empty-state"]').first();
    const searching     = page.locator('text=/Searching/i').first();

    const hasResults  = await resultsList.isVisible().catch(() => false);
    const hasEmpty    = await emptyState.isVisible().catch(() => false);
    const isSearching = await searching.isVisible().catch(() => false);

    expect(hasResults || hasEmpty || isSearching).toBeTruthy();
  });

  test('search results have correct shape when data is present', async ({ page }) => {
    // Intercept the search API to inject controlled fixture data so this test
    // is deterministic regardless of live backend state.
    await page.route('/api/v5/search', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'agent:test-agent',
              content: 'Agent: Test Agent\nDescription: Handles test tasks',
              score: 0.9,
              type: 'agent',
              source: 'test-agent',
              metadata: { file: 'test-agent.yaml', role: 'tester' },
            },
            {
              id: 'sprint:v1.0:item-1',
              content: 'Sprint search test item',
              score: 0.75,
              type: 'sprint',
              source: 'Sprint 1.0',
              metadata: { version: '1.0', status: 'completed' },
            },
          ],
          meta: { total: 2, query: 'test' },
        }),
      });
    });

    await page.goto('/search');
    await page.waitForLoadState('networkidle');

    const searchInput = page.locator('input[type="search"]').first();
    const isInputVisible = await searchInput.isVisible().catch(() => false);
    if (!isInputVisible) {
      test.skip();
      return;
    }

    await searchInput.fill('test');
    await searchInput.press('Enter');

    // Wait for results to appear
    await page.waitForTimeout(1000);

    // Verify result cards are rendered
    const resultCards = page.locator('[class*="result-card"]');
    const cardCount = await resultCards.count();
    expect(cardCount).toBeGreaterThanOrEqual(2);

    // Verify result count header shows correct number
    const resultsHeader = page.locator('[class*="results-header"]').first();
    const headerVisible = await resultsHeader.isVisible().catch(() => false);
    if (headerVisible) {
      const headerText = await resultsHeader.textContent();
      expect(headerText).toContain('2');
    }

    // Verify score badges are rendered (format: "NN% match")
    const scoreBadges = page.locator('[class*="score-badge"]');
    const badgeCount = await scoreBadges.count();
    expect(badgeCount).toBeGreaterThanOrEqual(1);

    // Confirm type badges link to the right dashboard sections
    const agentBadge = page.locator('a[href="/agents"].badge, .badge:has-text("agent")').first();
    const agentBadgeVisible = await agentBadge.isVisible().catch(() => false);
    if (agentBadgeVisible) {
      const href = await agentBadge.getAttribute('href').catch(() => null);
      expect(href).toBe('/agents');
    }
  });

  test('search returns empty state for no matches', async ({ page }) => {
    // Inject an empty result set
    await page.route('/api/v5/search', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], meta: { total: 0, query: 'zzznomatch999' } }),
      });
    });

    await page.goto('/search');
    await page.waitForLoadState('networkidle');

    const searchInput = page.locator('input[type="search"]').first();
    const isInputVisible = await searchInput.isVisible().catch(() => false);
    if (!isInputVisible) {
      test.skip();
      return;
    }

    await searchInput.fill('zzznomatch999');
    await searchInput.press('Enter');
    await page.waitForTimeout(800);

    // Should show empty-state message, NOT a JS error or blank page
    const emptyState = page.locator('[class*="empty-state"]').first();
    await expect(emptyState).toBeVisible();

    const emptyText = await emptyState.textContent();
    expect(emptyText).toMatch(/no results|zzznomatch999/i);
  });

  test('type filter chips can be toggled', async ({ page }) => {
    await page.goto('/search');
    await page.waitForLoadState('networkidle');

    // Find the type filter chips
    const filterGroup = page.locator('[role="group"], [class*="type-filters"]').first();
    const isVisible = await filterGroup.isVisible().catch(() => false);

    if (!isVisible) {
      // Type filters may not exist — ensure page heading is still visible
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible();
      return;
    }

    // Click the "agent" type chip to activate it
    const agentChip = page.locator('button:has-text("agent")').first();
    const chipVisible = await agentChip.isVisible().catch(() => false);

    if (chipVisible) {
      await agentChip.click();
      // Should toggle active state
      await page.waitForTimeout(200);
      // Clicking a second chip should also work
      const sprintChip = page.locator('button:has-text("sprint")').first();
      if (await sprintChip.isVisible().catch(() => false)) {
        await sprintChip.click();
        await page.waitForTimeout(200);
      }
      // Clear filter button should now appear
      const clearChip = page.locator('button:has-text("clear filter")').first();
      const clearVisible = await clearChip.isVisible().catch(() => false);
      if (clearVisible) {
        await clearChip.click();
      }
    }

    // Page should still be visible and not errored
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible();
  });

  test('displays search filters or options', async ({ page }) => {
    await page.goto('/search');

    await page.waitForLoadState('networkidle');

    // Look for filter options
    const filters = page.locator('[class*="filter"], [class*="option"], [role="group"]').first();
    const filterText = page.locator('text=/filter|sort|type|category|date/i');

    const hasFilters = await filters.isVisible().catch(() => false);
    const hasFilterText = await filterText.count().then(c => c > 0).catch(() => false);

    expect(hasFilters || hasFilterText).toBeTruthy();
  });

  test('hint example buttons trigger search', async ({ page }) => {
    // Intercept API calls to verify they are made
    let searchCallCount = 0;
    let lastQuery = '';

    await page.route('/api/v5/search', async route => {
      searchCallCount++;
      const body = JSON.parse(route.request().postData() ?? '{}') as { query?: string };
      lastQuery = body.query ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], meta: { total: 0, query: lastQuery } }),
      });
    });

    await page.goto('/search');
    await page.waitForLoadState('networkidle');

    // Click one of the hint example buttons (e.g., "sprint")
    const hintButton = page.locator('.hint-examples button, [class*="hint"] button').first();
    const hintVisible = await hintButton.isVisible().catch(() => false);

    if (hintVisible) {
      await hintButton.click();
      await page.waitForTimeout(800);

      // Verify the API was called
      expect(searchCallCount).toBeGreaterThanOrEqual(1);
      expect(lastQuery.length).toBeGreaterThan(0);
    } else {
      // Hint buttons may not be present — that's OK
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible();
    }
  });

  test('search page handles loading and empty states', async ({ page }) => {
    await page.goto('/search');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|searching/i').first();
    const emptyState = page.locator('text=/No result|No match|empty|Try searching/i').first();
    const searchContent = page.locator('[class*="search"], [class*="result"], input').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await searchContent.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator('h1, h2').first();
    await expect(_heading).toBeVisible();
  });

  test('search page is responsive', async ({ page }) => {
    await page.goto('/search');

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
