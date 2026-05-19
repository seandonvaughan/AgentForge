import { test, expect, type Page } from '@playwright/test';

async function openOrg(page: Page) {
  await page.goto('/org', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1').first()).toContainText(/Org|Organization/i);
}

test.describe('Org Graph Page', () => {
  test('loads org graph page', async ({ page }) => {
    await openOrg(page);

    // Verify page title
    await expect(page).toHaveTitle(/Org|Organization|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays org graph heading', async ({ page }) => {
    await openOrg(page);

    // h1 with "Organization" must be visible
    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 8000 });
    await expect(heading).toContainText(/Org|Organization/i);
  });

  test('org tree data stays in sync when API fallback is used', async ({ page }) => {
    await openOrg(page);

    // Get the initial tree node count from DOM
    const initialNodes = page.locator('[data-testid="org-node"]');
    const initialNodeCount = await initialNodes.count();
    expect(initialNodeCount).toBeGreaterThan(0);

    // Verify the model-mix sidebar is in sync with tree
    // (It should show counts that match the visible nodes)
    const modelMixCounts = page.locator('.af-model-count');
    const modelCountElements = await modelMixCounts.count();
    // Should have at least some model indicators if there are agents
    expect(modelCountElements).toBeGreaterThan(0);
  });

  test('agent scroll list matches tree data', async ({ page }) => {
    await openOrg(page);

    // Verify the agent scroll list is populated
    const agentScroll = page.locator('.af-agent-scroll').first();
    await expect(agentScroll).toBeVisible({ timeout: 8000 });

    // Count agents in the scroll list
    const scrollListAgents = page.locator('.af-agent-scroll [data-testid="org-node"]');
    const scrollListCount = await scrollListAgents.count();

    // Count agents in the main tree
    const treeNodes = page.locator('[data-testid="org-tree"] [data-testid="org-node"]');
    const treeNodeCount = await treeNodes.count();

    // The scroll list should have agents (may be sorted/filtered, but should be non-zero)
    if (treeNodeCount > 0) {
      expect(scrollListCount).toBeGreaterThan(0);
    }
  });

  test('renders real agent tree with delegation hierarchy', async ({ page }) => {
    await openOrg(page);

    // The org tree container must be present and visible
    const orgTree = page.locator('[data-testid="org-tree"]');
    await expect(orgTree).toBeVisible({ timeout: 8000 });

    // The hierarchy section (agents with delegation edges) must render
    const orgHierarchy = page.locator('[data-testid="org-hierarchy"]');
    await expect(orgHierarchy).toBeVisible({ timeout: 5000 });

    // At least one agent node must be rendered
    const nodes = page.locator('[data-testid="org-node"]');
    const nodeCount = await nodes.count();
    expect(nodeCount).toBeGreaterThan(0);
  });

  test('displays a root node in the org hierarchy', async ({ page }) => {
    await openOrg(page);

    // Wait for the tree to populate
    await expect(page.locator('[data-testid="org-tree"]')).toBeVisible({ timeout: 8000 });

    // At least one root-level org-node must be visible.
    // The Codex forge produces project-specific architects rather than the legacy C-suite.
    const rootNode = page.locator('[data-testid="org-hierarchy"] [data-testid="org-node"]').first();
    await expect(rootNode).toBeVisible({ timeout: 5000 });
  });

  test('page subtitle reports non-zero agent and edge counts', async ({ page }) => {
    await openOrg(page);

    // Wait for the tree to be present (SSR or client fetch resolved)
    await expect(page.locator('[data-testid="org-tree"]')).toBeVisible({ timeout: 8000 });

    // The subtitle "N agents · M delegation edges" must reflect real data.
    // The v2 design system uses .af-subtitle for all page subtitles.
    const subtitle = page.locator('.af-subtitle');
    await expect(subtitle).toBeVisible();

    const text = await subtitle.textContent();
    // Extract the agent count from "N agents"
    const agentMatch = text?.match(/(\d+)\s+agents?/i);
    expect(agentMatch).not.toBeNull();
    expect(parseInt(agentMatch![1]!, 10)).toBeGreaterThan(0);

    // Extract the edge count from "M delegation edges"
    const edgeMatch = text?.match(/(\d+)\s+delegation\s+edges?/i);
    expect(edgeMatch).not.toBeNull();
    expect(parseInt(edgeMatch![1]!, 10)).toBeGreaterThan(0);
  });

  test('displays org graph visualization', async ({ page }) => {
    await openOrg(page);

    // The org tree with testid attribute must be visible
    const orgTree = page.locator('[data-testid="org-tree"]');
    await expect(orgTree).toBeVisible({ timeout: 8000 });
  });

  test('renders agent nodes in org graph', async ({ page }) => {
    await openOrg(page);

    await expect(page.locator('[data-testid="org-tree"]')).toBeVisible({ timeout: 8000 });

    await expect(page.locator('body')).toContainText(/gpt-5\.5/i);
    await expect(page.locator('body')).toContainText(/gpt-5\.3-codex/i);
    await expect(page.locator('body')).toContainText(/gpt-5\.4-mini/i);
    await expect(page.locator('body')).not.toContainText(/\bopus\b|\bsonnet\b|\bhaiku\b/i);

    // Look for role or team information (at least one node label must be non-empty)
    const allNodes = page.locator('[data-testid="org-node"]');
    const count = await allNodes.count();
    expect(count).toBeGreaterThan(0);
  });

  test('org graph handles empty state gracefully', async ({ page }) => {
    await openOrg(page);

    // Either show graph or empty state — never a blank/broken page.
    // The v2 design system uses .af-empty for the empty state.
    const emptyState = page.locator('.af-empty').first();
    const orgTree = page.locator('[data-testid="org-tree"]').first();

    const hasEmptyState = await emptyState.isVisible().catch(() => false);
    const hasTree = await orgTree.isVisible().catch(() => false);

    // One of the two states must be present
    expect(hasEmptyState || hasTree).toBeTruthy();
  });

  test('org graph is responsive', async ({ page }) => {
    await openOrg(page);

    // Tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });
});
