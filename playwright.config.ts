import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for E2E tests against the Next.js web app.
 * Real provider/cloud tests live under packages/web/tests/e2e/.
 * Spec §12.3 mandates "no mock" — these run against real cloud accounts
 * dedicated to vauban-e2e (cf. .env.test).
 */
export default defineConfig({
  testDir: './packages/web/tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
