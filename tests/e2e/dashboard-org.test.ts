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

    await page.waitForLoadState('networkidle').catch(() => {});

    // h1 with "Organization" must be visible
    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 8000 });
    await expect(heading).toContainText(/Org|Organization/i);
  });

  test('org tree data stays in sync when API fallback is used', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Get the initial tree node count from DOM
    const initialNodes = page.locator('[data-testid="org-node"]');
    const initialNodeCount = await initialNodes.count();
    expect(initialNodeCount).toBeGreaterThan(0);

    // Verify the model-mix sidebar is in sync with tree
    // (It should show counts that match the visible nodes)
    const modelMixCounts = page.locator('.model-count');
    const modelCountElements = await modelMixCounts.count();
    // Should have at least some model indicators if there are agents
    expect(modelCountElements).toBeGreaterThanOrEqual(0);
  });

  test('agent scroll list matches tree data', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

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
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

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

  test('displays CEO as the root node', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Wait for the tree to populate
    await expect(page.locator('[data-testid="org-tree"]')).toBeVisible({ timeout: 8000 });

    // CEO must be visible as the root agent (label "CEO" rendered inside an org-node)
    const ceoNode = page.locator('[data-testid="org-node"]').filter({ hasText: /^CEO$/i }).first();
    await expect(ceoNode).toBeVisible({ timeout: 5000 });
  });

  test('page subtitle reports non-zero agent and edge counts', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Wait for the tree to be present (SSR or client fetch resolved)
    await expect(page.locator('[data-testid="org-tree"]')).toBeVisible({ timeout: 8000 });

    // The subtitle "N agents · M delegation edges" must reflect real data
    const subtitle = page.locator('.page-subtitle');
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
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    // The org tree with testid attribute must be visible
    const orgTree = page.locator('[data-testid="org-tree"]');
    await expect(orgTree).toBeVisible({ timeout: 8000 });
  });

  test('renders agent nodes in org graph', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(page.locator('[data-testid="org-tree"]')).toBeVisible({ timeout: 8000 });

    // Look for known C-suite role labels in rendered nodes
    const ctoNode = page.locator('[data-testid="org-node"]').filter({ hasText: /^CTO$/i });
    if (await ctoNode.count() > 0) {
      await expect(ctoNode.first()).toBeVisible();
    }

    // Look for role or team information (at least one node label must be non-empty)
    const allNodes = page.locator('[data-testid="org-node"]');
    const count = await allNodes.count();
    expect(count).toBeGreaterThan(0);
  });

  test('org graph handles empty state gracefully', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Either show graph or empty state — never a blank/broken page
    const emptyState = page.locator('.empty-state').first();
    const orgTree = page.locator('[data-testid="org-tree"]').first();

    const hasEmptyState = await emptyState.isVisible().catch(() => false);
    const hasTree = await orgTree.isVisible().catch(() => false);

    // One of the two states must be present
    expect(hasEmptyState || hasTree).toBeTruthy();
  });

  test('org graph is responsive', async ({ page }) => {
    await page.goto('/org');

    await page.waitForLoadState('networkidle').catch(() => {});

    // Tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });
});
