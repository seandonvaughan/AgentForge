const CYCLE_ID = 'objective-flow-cycle';

if (process.env['VITEST']) {
  const { describe, expect, it } = await import('vitest');
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = dirname(fileURLToPath(import.meta.url));
  const launchPage = readFileSync(resolve(here, '../../src/routes/cycles/new/+page.svelte'), 'utf8');
  const detailPage = readFileSync(resolve(here, '../../src/routes/cycles/[id]/+page.svelte'), 'utf8');

  describe('objective launch flow contract', () => {
    it('keeps the launch form wired to the created cycle detail route', () => {
      expect(launchPage).toContain("fetch(withWorkspace('/api/v5/cycles')");
      expect(launchPage).toContain('const newId = json.cycleId ?? json.id;');
      expect(launchPage).toContain('await goto(`/cycles/${newId}`);');
      expect(detailPage).toContain('const res = await fetch(withWorkspace(`/api/v5/cycles/${id}`));');
    });
  });
} else {
  const { expect, test } = await import('@playwright/test');

  test.describe('Objective launch flow', () => {
    test('fills the operator launch form and opens the created cycle detail page', async ({ page }) => {
      let postedBody: Record<string, unknown> | undefined;

      await page.addInitScript(() => {
        class MockEventSource {
          onopen: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          readyState = 0;

          constructor(public url: string) {
            setTimeout(() => {
              this.readyState = 1;
              this.onopen?.(new Event('open'));
            }, 10);
          }

          close() {
            this.readyState = 2;
          }
        }

        Object.assign(window, { EventSource: MockEventSource });
      });

      await page.route(/\/api\/v5\/cycles(?:\?.*)?$/, async (route) => {
        const request = route.request();

        if (request.method() === 'POST') {
          postedBody = request.postDataJSON() as Record<string, unknown>;
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({ cycleId: CYCLE_ID }),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ cycles: [] }),
        });
      });

      await page.route(new RegExp(`/api/v5/cycles/${CYCLE_ID}(?:/[^?]*)?(?:\\?.*)?$`), async (route) => {
        const path = new URL(route.request().url()).pathname;

        if (path.endsWith('/sprint')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ sprint: { version: '22.13.0', title: 'Objective flow', items: [] } }),
          });
          return;
        }

        if (path.endsWith('/agents')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ runs: [], byAgent: {}, totalCostUsd: 0, totalRuns: 0 }),
          });
          return;
        }

        if (path.endsWith('/events')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ events: [], total: 0 }),
          });
          return;
        }

        if (path.endsWith('/scoring') || path.includes('/files/') || path.includes('/cost-breakdown')) {
          await route.fulfill({ status: 204 });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            cycleId: CYCLE_ID,
            lastHeartbeatAt: new Date().toISOString(),
            stage: 'run',
            runtimeMode: 'codex-cli',
            branchPrefix: 'codex/',
            baseBranch: 'codex/codex-version',
            dryRun: true,
            maxAgents: 2,
            modelCap: 'sonnet',
            effortCap: 'high',
            fallbackEnabled: true,
            startedAt: new Date().toISOString(),
            sprintVersion: '22.13.0',
            cost: { totalUsd: 0, budgetUsd: 25 },
            tests: { passed: 0, failed: 0, skipped: 0, total: 0, newFailures: [] },
            git: { branch: '', commitSha: null, filesChanged: [] },
            pr: { url: null, number: null, draft: false },
          }),
        });
      });

      await page.goto('/cycles/new');
      await expect(page.locator('h1')).toHaveText('Launch autonomous cycle');

      await page.getByLabel('Budget in USD').fill('25');
      await page.getByLabel('Max items per sprint').fill('3');
      await page.locator('input[aria-label="Max agents"]').fill('2');
      await page.locator('#tagsInput').fill('objective launch');
      await page.locator('#comment').fill('Verify objective launch to cycle detail');
      await page.locator('.toggle').filter({ hasText: 'Dry run' }).click();

      await page.getByRole('button', { name: /Run Cycle/ }).click();

      await expect.poll(() => postedBody).toMatchObject({
        budgetUsd: 25,
        maxItems: 3,
        maxAgents: 2,
        dryRun: true,
        comment: 'Verify objective launch to cycle detail',
        tags: ['objective', 'launch'],
      });
      await expect(page).toHaveURL(new RegExp(`/cycles/${CYCLE_ID}$`), { timeout: 15_000 });
      await expect(page.locator('h1')).toContainText('Cycle');
    });
  });
}
