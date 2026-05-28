import { defineConfig, devices } from '@playwright/test';

function parseBooleanEnv(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? '');
}

function parseDisableBooleanEnv(value: string | undefined): boolean {
  return /^(0|false|no)$/i.test(value ?? '');
}

export function shouldReuseExistingServer(env: NodeJS.ProcessEnv): boolean {
  if (env.CI) {
    return false;
  }

  if (parseDisableBooleanEnv(env.PLAYWRIGHT_REUSE_SERVER)) {
    return false;
  }

  if (parseBooleanEnv(env.PLAYWRIGHT_REUSE_SERVER)) {
    return true;
  }

  return true;
}

const reuseExistingServer = shouldReuseExistingServer(process.env);

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.test.ts',
  testIgnore: '**/cli.test.ts',
  globalSetup: './tests/e2e/global-setup.mjs',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:4751',
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // Uncomment for full cross-browser testing
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  /* Run local product services before starting the tests. */
  webServer: [
    {
      command: 'node scripts/run-pnpm.mjs -- start',
      url: 'http://localhost:4750/api/v5/health',
      reuseExistingServer,
      timeout: 120 * 1000,
    },
    {
      command: 'node scripts/run-pnpm.mjs -- --dir packages/dashboard dev',
      url: 'http://localhost:4751',
      reuseExistingServer,
      timeout: 120 * 1000,
    },
  ],
});
