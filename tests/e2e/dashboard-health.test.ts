import { test, expect, type Page, type Route } from '@playwright/test';

type HealthResponse = {
  status: 'ok' | 'error';
  version?: string;
  workspaceId?: string;
};

type ServiceHealth = {
  service: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  circuitOpen: boolean;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  circuitOpenedAt?: string;
  p99?: number;
  latencyHistory?: number[];
};

type ServicesResponse = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  healthyCount: number;
  degradedCount: number;
  services: ServiceHealth[];
  timestamp: string;
};

const BASE_HEALTH: HealthResponse = {
  status: 'ok',
  version: '10.5.1',
  workspaceId: 'ws-e2e',
};

const BASE_SERVICES: ServicesResponse = {
  status: 'healthy',
  healthyCount: 2,
  degradedCount: 0,
  timestamp: '2026-05-19T12:00:00.000Z',
  services: [
    {
      service: 'openai',
      totalCalls: 120,
      successCount: 120,
      failureCount: 0,
      successRate: 1,
      circuitOpen: false,
      lastSuccessAt: '2026-05-19T11:59:00.000Z',
      p99: 350,
      latencyHistory: [250, 260, 245, 255],
    },
    {
      service: 'github',
      totalCalls: 80,
      successCount: 79,
      failureCount: 1,
      successRate: 0.9875,
      circuitOpen: false,
      lastFailureAt: '2026-05-19T11:45:00.000Z',
      lastSuccessAt: '2026-05-19T11:59:30.000Z',
      p99: 480,
      latencyHistory: [310, 330, 360, 320],
    },
  ],
};

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockHealthApis(
  page: Page,
  opts: {
    healthStatus?: number;
    servicesStatus?: number;
    healthBody?: HealthResponse;
    servicesBody?: ServicesResponse;
  } = {},
) {
  const {
    healthStatus = 200,
    servicesStatus = 200,
    healthBody = BASE_HEALTH,
    servicesBody = BASE_SERVICES,
  } = opts;

  await page.route('**/api/v5/health/services', async (route) => {
    if (servicesStatus >= 400) {
      await fulfillJson(route, servicesStatus, { error: 'services unavailable' });
      return;
    }
    await fulfillJson(route, servicesStatus, servicesBody);
  });

  await page.route('**/api/v5/health', async (route) => {
    if (healthStatus >= 400) {
      await fulfillJson(route, healthStatus, { error: 'health unavailable' });
      return;
    }
    await fulfillJson(route, healthStatus, healthBody);
  });
}

async function gotoHealth(page: Page) {
  await page.goto('/health', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1.health-title')).toHaveText(/system health/i);
}

test.describe('Health Dashboard Page', () => {
  test('renders healthy banner, service cards, and dependency matrix', async ({ page }) => {
    await mockHealthApis(page);
    await gotoHealth(page);

    await expect(page.locator('.status-main')).toContainText(/system healthy/i);
    await expect(page.locator('.services-grid .svc-name')).toHaveCount(2);
    await expect(page.locator('.dep-table tbody tr')).toHaveCount(5);
  });

  test('renders recent incidents when a service is degraded or circuit-open', async ({ page }) => {
    const degraded = structuredClone(BASE_SERVICES);
    degraded.status = 'degraded';
    degraded.healthyCount = 1;
    degraded.degradedCount = 1;
    degraded.services[1] = {
      ...degraded.services[1],
      failureCount: 7,
      circuitOpen: true,
      circuitOpenedAt: '2026-05-19T11:40:00.000Z',
      successRate: 0.7,
    };

    await mockHealthApis(page, { servicesBody: degraded });
    await gotoHealth(page);

    await expect(page.locator('.inc-table tbody tr')).toHaveCount(1);
    await expect(page.locator('.inc-table tbody tr').first()).toContainText('github');
    await expect(page.locator('.inc-table tbody tr').first()).toContainText(/circuit open/i);
  });

  test('falls back to API server card when services endpoint fails', async ({ page }) => {
    await mockHealthApis(page, { servicesStatus: 503 });
    await gotoHealth(page);

    await expect(page.locator('text=API SERVER')).toBeVisible();
    await expect(page.locator('text=REST API')).toBeVisible();
    await expect(page.locator('text=Online')).toBeVisible();
  });

  test('falls back to API server card when services payload is malformed', async ({ page }) => {
    await mockHealthApis(page, {
      servicesBody: { status: 'healthy', healthyCount: 1 } as unknown as ServicesResponse,
    });
    await gotoHealth(page);

    await expect(page.locator('text=API SERVER')).toBeVisible();
    await expect(page.locator('text=REST API')).toBeVisible();
    await expect(page.locator('.services-grid .svc-name')).toHaveCount(0);
  });

  test('falls back to API server card when services payload is an array', async ({ page }) => {
    await mockHealthApis(page, {
      servicesBody: [] as unknown as ServicesResponse,
    });
    await gotoHealth(page);

    await expect(page.locator('text=API SERVER')).toBeVisible();
    await expect(page.locator('text=REST API')).toBeVisible();
    await expect(page.locator('.services-grid .svc-name')).toHaveCount(0);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  });

  test('keeps rendering service telemetry when health endpoint fails but services are available', async ({ page }) => {
    await mockHealthApis(page, { healthStatus: 503 });
    await gotoHealth(page);

    await expect(page.locator('.status-main')).toContainText(/system healthy/i);
    await expect(page.locator('.services-grid .svc-name')).toHaveCount(2);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  });

  test('shows connection banner when both health endpoints fail', async ({ page }) => {
    await mockHealthApis(page, { healthStatus: 503, servicesStatus: 503 });
    await page.goto('/health', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.error-banner')).toContainText(/unable to reach api server/i);
    await expect(page.locator('.error-banner')).toContainText(/http 503/i);
  });

  test('health page remains usable on mobile and desktop', async ({ page }) => {
    await mockHealthApis(page);
    await gotoHealth(page);

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('h1.health-title')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('h1.health-title')).toBeVisible();
  });
});
