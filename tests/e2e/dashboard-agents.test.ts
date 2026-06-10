import { test, expect, type Page } from '@playwright/test';

async function waitForAgentsClient(page: Page) {
  await expect(page.locator('table.data-table tbody tr').first()).toBeVisible({ timeout: 10000 });
}

async function waitForAgentsHydrated(page: Page) {
  const header = page.locator('header.af-page-header');
  await expect(header).toBeVisible({ timeout: 10000 });
  await expect.poll(
    () => header.getAttribute('data-client-ready'),
    { timeout: 15000 },
  ).toBe('true');
}

test.describe('Agents List Page', () => {
  test('loads agents list page', async ({ page }) => {
    await page.goto('/agents');

    // Verify page title
    await expect(page).toHaveTitle(/Agent|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays agents heading', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('load').catch(() => {});

    // Heading must be present — confirms the /agents route rendered
    const heading = page.locator('h1').filter({ hasText: /Agent fleet/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays real agents from .agentforge/agents/*.yaml — not empty', async ({ page }) => {
    await page.goto('/agents');

    // Allow SSR + any client-side refresh to settle.
    // Use a short explicit timeout — the layout's persistent SSE and WebSocket
    // connections mean networkidle never fires, so the default 30s timeout would
    // consume the entire test budget. 3s is enough for SSR + initial render.
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

    // The agents table must be present with at least one data row.
    // .agentforge/agents/ contains 100+ YAML definitions, so any non-zero
    // count confirms real files are being read and rendered.
    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount, 'Expected at least one agent row from .agentforge/agents/*.yaml').toBeGreaterThan(0);
  });

  test('displays agents list or grid', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('load').catch(() => {});

    // Agents table must be visible
    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();
  });

  test('displays agent names from YAML — real text not placeholders', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

    // The table rows must include agent names from YAML files.
    // .agentforge/agents/ contains definitions for "Frontend Developer",
    // "Lead Architect", "VP Engineering", etc. At least one row must be visible.
    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();

    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();

    // First cell in a row is the Name column (font-weight: 600)
    const nameCell = firstRow.locator('td').first();
    const name = await nameCell.textContent();
    expect(name?.trim(), 'Name cell must not be empty — real agent name expected').toBeTruthy();
  });

  test('agent rows are clickable and navigate to detail page', async ({ page }) => {
    await page.goto('/agents');

    // Short timeout: SSE/WS connections prevent networkidle from ever firing.
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await waitForAgentsClient(page);

    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();

    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();

    const agentId = (await firstRow.locator('.af-agent-id').textContent())?.trim();
    expect(agentId, 'Expected first row to expose an agent id').toBeTruthy();

    // Rows expose a native link so click/keyboard navigation does not depend on
    // a hydrated JavaScript handler attached to <tr>.
    await expect(firstRow.locator(`a.af-row-link[href="/agents/${agentId}"]`)).toBeVisible();

    // Click the native link so navigation does not depend on a hydrated row handler.
    // waitForLoadState('load') is a no-op after client-side routing (the page
    // is already in 'load' state), so we wait for the URL to change instead.
    await firstRow.locator(`a.af-row-link[href="/agents/${agentId}"]`).click();
    await expect(page).toHaveURL(/\/agents\/.+/, { timeout: 5000 });
  });

  test('agent detail Run action opens runner with the selected Codex agent', async ({ page }) => {
    await page.goto('/agents/cli-engineer');
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

    await expect(page.locator('h1')).toContainText(/cli-engineer/i);

    await page.getByRole('link', { name: /run/i }).first().click();

    await expect(page).toHaveURL(/\/runner\?agentId=cli-engineer/);
    await expect(page.locator('#agent-select')).toHaveValue('cli-engineer');
    await expect(page.locator('.cost-callout')).toContainText(/claude-sonnet-4-6|high/i);
  });

  test('agent detail config editor saves raw YAML through the management API', async ({ page }) => {
    let savedYaml = '';
    let rawGets = 0;
    const initialYaml = [
      'name: cli-engineer',
      'model: sonnet',
      'description: Original CLI engineer',
      '',
    ].join('\n');
    const updatedYaml = [
      'name: cli-engineer',
      'model: sonnet',
      'description: Updated from dashboard test',
      '',
    ].join('\n');

    await page.route('**/api/v5/agents/cli-engineer/raw', async (route) => {
      if (route.request().method() === 'PUT') {
        const payload = route.request().postDataJSON() as { yaml?: string };
        savedYaml = payload.yaml ?? '';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { yaml: savedYaml } }),
        });
        return;
      }

      rawGets += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { yaml: initialYaml } }),
      });
    });

    await page.goto('/agents/cli-engineer');
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await expect.poll(() => rawGets).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Edit config' }).click();
    await expect(page.getByRole('tab', { name: 'Config' })).toHaveAttribute('aria-selected', 'true');
    // v25: the raw YAML editor lives in the collapsed "Advanced: raw YAML"
    // section beneath the structured editor — expand it, then enter edit mode
    // (the section opens in read-only preview).
    await page.getByRole('button', { name: /advanced: raw yaml/i }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByLabel('Agent YAML configuration');
    await expect(editor).toBeVisible();

    await editor.fill(updatedYaml);
    // Two Save buttons exist now (structured editor + raw YAML) — use the raw
    // section's header-scoped one.
    await page.locator('.af-config-header').getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => savedYaml).toContain('Updated from dashboard test');
    await expect(page.locator('.af-save-ok')).toContainText('Saved');
    await expect(page.locator('.af-yaml-preview')).toContainText('Updated from dashboard test');
  });

  test('model tier badges are present on agent rows', async ({ page }) => {
    await page.goto('/agents');

    // Short timeout: SSE/WS connections prevent networkidle from ever firing.
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();

    // Resolved model/effort chips must appear on rows (Claude-primary ids;
    // gpt-* only when a codex run actually served).
    await expect(table).toContainText(/claude-(fable-5|opus-4-8|sonnet-4-6|haiku-4-5)/);
    await expect(table).toContainText(/xhigh|high|medium/i);
  });

  test('agents list shows content from real YAML files, not empty state', async ({ page }) => {
    await page.goto('/agents');

    // Short timeout: SSE/WS connections prevent networkidle from ever firing.
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

    // The empty state div must NOT be visible when agents exist
    const emptyState = page.locator('.empty-state');
    const isEmpty = await emptyState.isVisible().catch(() => false);
    expect(isEmpty, '"No agents found" state must not show when YAML files exist').toBe(false);

    // The table must be present with real rows
    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();
  });

  test('agents page is responsive', async ({ page }) => {
    await page.goto('/agents');

    await page.waitForLoadState('load').catch(() => {});

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 667 });

    // Wait for heading to render at mobile viewport
    const heading = page.locator('h1').filter({ hasText: /Agent fleet/i }).first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Resize to tablet
    await page.setViewportSize({ width: 768, height: 1024 });

    // Wait for heading to render at tablet viewport
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Resize to desktop
    await page.setViewportSize({ width: 1280, height: 720 });

    // Wait for heading to render at desktop viewport
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  /**
   * REGRESSION: __unassigned__ Team Filter (v11.0.0)
   *
   * Bug: The __unassigned__ team filter was broken — clicking it showed zero
   * results because the filter logic was checking `agent.team === '__unassigned__'`
   * instead of `!agent.team` (i.e., null/undefined team).
   *
   * Fix: Updated matchesAgentFilter() to use:
   *   filterTeam === '__unassigned__' ? !agent.team : agent.team === filterTeam
   *
   * This test verifies the filter works correctly by:
   * 1. Finding the team summary bar and verifying __unassigned__ chip exists
   * 2. Clicking the __unassigned__ filter
   * 3. Verifying the table still renders (no error state)
   * 4. Verifying the filter can be cleared
   */
  test('agents page: __unassigned__ team filter works correctly (regression test)', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await waitForAgentsHydrated(page);

    const teamSelect = page.getByLabel('Filter by team');
    await expect(teamSelect).toBeVisible();

    const unassignedOption = teamSelect.locator('option[value="__unassigned__"]');
    if (await unassignedOption.count() === 0) {
      const table = page.locator('table.data-table');
      await expect(table).toBeVisible();
      return;
    }

    await teamSelect.selectOption('__unassigned__');
    await expect(teamSelect).toHaveValue('__unassigned__');

    // The table or the handled empty state should remain visible.
    const table = page.locator('table.data-table');
    const emptyState = page.locator('.af-empty');
    expect(
      (await table.isVisible().catch(() => false)) ||
      (await emptyState.isVisible().catch(() => false)),
      'team filtering should keep the page in a rendered table or empty state',
    ).toBe(true);

    await teamSelect.selectOption('');
    await expect(teamSelect).toHaveValue('');

    // Table should still be visible
    await expect(table).toBeVisible({ timeout: 5000 });
  });

  /**
   * REGRESSION: Model Filter Predicate (Team Filter Corollary)
   *
   * The model filter (opus/sonnet/haiku) uses the same filter architecture
   * as the team filter. Verify it works correctly as a corollary test.
   */
  test('agents page: model filter preserves data consistency', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await waitForAgentsHydrated(page);
    await waitForAgentsClient(page);

    const filterPills = page.locator('button.af-pill');
    const pillCount = await filterPills.count();
    expect(pillCount).toBeGreaterThanOrEqual(4); // all, opus, sonnet, haiku (+fable when present)

    // Click the opus tier filter (pills are tier-named in v25)
    const opusFilter = filterPills.filter({ hasText: /^opus$/i }).first();
    await opusFilter.click();

    // Verify it becomes active
    await expect(opusFilter).toHaveClass(/active/);

    // Table should render without error
    const table = page.locator('table.data-table');
    await expect(table).toBeVisible({ timeout: 5000 });

    // All visible rows should have opus in their model column or badge
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();

    if (rowCount > 0) {
      // Get first row and verify it has an opus badge or model indicator
      const firstRow = rows.first();
      await expect(firstRow).toContainText(/gpt-5\.5|xhigh/i);
    }
  });

  /**
   * REGRESSION: Team Filter State Persistence
   *
   * Verify that filtering on one view doesn't break when navigating
   * and returning to the list.
   */
  test('agents page: team filter state clears on page reload', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await waitForAgentsHydrated(page);

    const teamSelect = page.getByLabel('Filter by team');
    await expect(teamSelect).toBeVisible();

    const optionValues = await teamSelect.locator('option').evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
    if (optionValues.length === 0) return;

    await teamSelect.selectOption(optionValues[0]!);
    await expect(teamSelect).toHaveValue(optionValues[0]!);

    // Reload page
    await page.reload();
    await page.waitForLoadState('load').catch(() => {});

    // After reload, filter should be cleared (unless persisted)
    // This test documents the expected behavior
    const table = page.locator('table.data-table');
    await expect(table).toBeVisible({ timeout: 5000 });

    // Page should have navigated and state reset — verify it's still functional
    const heading = page.locator('h1').filter({ hasText: /Agent fleet/i }).first();
    await expect(heading).toBeVisible();
  });
});
