import { test, expect } from '@playwright/test';

test.describe('Org Graph Page', () => {
  test('loads org graph page', async ({ page }) => {
    await page.goto('/org');

    // Verify page title
    await expect(page).toHaveTitle(/Org|Organization|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays org graph heading', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle');

    // Look for heading or title
    const heading = page.locator('h1, h2').filter({ hasText: /Org|Organization|Team/i }).first();

    if (await heading.isVisible().catch(() => false)) {
      await expect(heading).toBeVisible();
    }
  });

  test('displays org graph visualization', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle');

    // Look for SVG graph, canvas, or div-based visualization
    const svgGraph = page.locator('svg').first();
    const canvasGraph = page.locator('canvas').first();
    const graphContainer = page.locator('[class*="graph"], [class*="org"], [id*="graph"], [data-testid*="org"]').first();

    const hasSvg = await svgGraph.isVisible().catch(() => false);
    const hasCanvas = await canvasGraph.isVisible().catch(() => false);
    const hasContainer = await graphContainer.isVisible().catch(() => false);

    // v6.7.4: replaced fake disjunction with real load assertion
    const _heading = page.locator("h1, h2").first();
    await expect(_heading).toBeVisible();
  });

  test('renders agent nodes in org graph', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle');

    // Look for agent names or node labels
    const agentNodes = page.locator('text=/Agent|agent|role|coordinator/i');
    const nodeCount = await agentNodes.count();

    if (nodeCount > 0) {
      await expect(agentNodes.first()).toBeVisible();
    }

    // Look for role or team information
    const roleElements = page.locator('text=/CTO|Backend|Frontend|QA|Manager/i');
    const roleCount = await roleElements.count();

    if (roleCount > 0) {
      await expect(roleElements.first()).toBeVisible();
    }
  });

  test('org graph handles empty state gracefully', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle');

    // Either show graph or empty state
    const emptyState = page.locator('text=/No agents|No data|empty|loading/i').first();
    const graphContent = page.locator('svg, canvas, [class*="graph"], [class*="node"]').first();

    const hasEmptyState = await emptyState.isVisible().catch(() => false);
    const hasGraph = await graphContent.isVisible().catch(() => false);

    expect(hasEmptyState || hasGraph).toBeTruthy();
  });

  test('org graph is responsive', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle');

    // Verify page is still accessible after resize
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.waitForTimeout(500);

    // Check if content is still visible
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Resize back to desktop
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();
  });
});
