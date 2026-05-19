import { test, expect } from '@playwright/test';

const STATUS = {
  teamName: 'AgentForge Codex team',
  forgedAt: '2026-05-19T12:00:00.000Z',
  agentCount: 33,
  modelCounts: { opus: 6, sonnet: 21, haiku: 6 },
  hasTeamYaml: true,
  modifiedAt: '2026-05-19T12:05:00.000Z',
};

test.describe('Settings Team Forge Page', () => {
  test('shows Codex team status and runs forge controls', async ({ page }) => {
    const forgePayloads: Record<string, unknown>[] = [];
    const rebuildPayloads: Record<string, unknown>[] = [];

    await page.route('/api/v5/team/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: STATUS }),
      });
    });

    await page.route('/api/v5/team/forge', async (route) => {
      forgePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { exitCode: 0, status: STATUS } }),
      });
    });

    await page.route('/api/v5/team/rebuild', async (route) => {
      rebuildPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { exitCode: 0, status: STATUS } }),
      });
    });

    await page.goto('/settings/forge');

    await expect(page.locator('h2')).toContainText('AgentForge Codex team');
    await expect(page.locator('body')).toContainText('gpt-5.5');
    await expect(page.locator('body')).toContainText('gpt-5.3-codex');
    await expect(page.locator('body')).toContainText('gpt-5.4-mini');
    await expect(page.locator('body')).toContainText('33');

    await page.getByLabel('Domains').fill('runtime,quality');
    await page.getByRole('switch', { name: 'Verbose preview' }).click();
    await page.getByRole('button', { name: 'Preview' }).click();

    await expect.poll(() => forgePayloads.length).toBe(1);
    expect(forgePayloads[0]).toMatchObject({
      dryRun: true,
      verbose: true,
      domains: 'runtime,quality',
    });
    await expect(page.locator('body')).toContainText('Preview completed.');

    await page.getByRole('button', { name: 'Forge Team' }).click();
    await expect.poll(() => forgePayloads.length).toBe(2);
    expect(forgePayloads[1]).toMatchObject({
      dryRun: false,
      verbose: true,
      domains: 'runtime,quality',
    });

    await page.getByRole('switch', { name: 'Auto-apply rebuild' }).click();
    await page.getByRole('button', { name: 'Rebuild' }).click();
    await expect.poll(() => rebuildPayloads.length).toBe(1);
    expect(rebuildPayloads[0]).toMatchObject({ autoApply: true });
  });
});
