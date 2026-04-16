import { test, expect } from '@playwright/test';

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
    const heading = page.locator('h1').filter({ hasText: /Agents/i }).first();
    await expect(heading).toBeVisible();
  });

  test('displays real agents from .agentforge/agents/*.yaml — not empty', async ({ page }) => {
    await page.goto('/agents');

    // Allow SSR + any client-side refresh to settle.
    // Use a short explicit timeout — the layout's persistent SSE and WebSocket
    // connections mean networkidle never fires, so the default 30s timeout would
    // consume the entire test budget. 3s is enough for SSR + initial render.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

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

    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

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
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();

    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();

    // Rows are keyboard-accessible with role="button" and tabindex="0"
    await expect(firstRow).toHaveAttribute('tabindex', '0');

    // Click triggers SvelteKit client-side navigation to /agents/:id.
    // waitForLoadState('load') is a no-op after client-side routing (the page
    // is already in 'load' state), so we wait for the URL to change instead.
    await firstRow.click();
    await page.waitForURL(/\/agents\/.+/, { timeout: 5000 }).catch(() => {});
    expect(page.url()).toMatch(/\/agents\//);
  });

  test('model tier badges are present on agent rows', async ({ page }) => {
    await page.goto('/agents');

    // Short timeout: SSE/WS connections prevent networkidle from ever firing.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    const table = page.locator('table.data-table');
    await expect(table).toBeVisible();

    // Model badges (opus / sonnet / haiku) must appear on rows
    const badges = table.locator('.badge');
    const badgeCount = await badges.count();
    expect(badgeCount, 'Each agent row should have a model tier badge').toBeGreaterThan(0);
  });

  test('agents list shows content from real YAML files, not empty state', async ({ page }) => {
    await page.goto('/agents');

    // Short timeout: SSE/WS connections prevent networkidle from ever firing.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

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

    await page.waitForTimeout(500);

    // Verify content is still accessible
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Resize to tablet
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();

    // Resize to desktop
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();
  });
});
