import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config — apps/gateway is the Next.js app under test.
 *
 *   - `smoke`            : smoke spec (apps/gateway/tests/e2e/smoke.spec.ts)
 *                          checks Playwright is wired. No creds needed.
 *
 *   - `e2e-real-clouds`  : real-providers scenarios under
 *                          apps/gateway/tests/e2e/real-clouds/.
 *                          Spec §14.3 mandates "no mock". Reads creds from
 *                          .env.test (gitignored) or from the GH Actions
 *                          secrets injected by the nightly workflow.
 */
export default defineConfig({
  testDir: './apps/gateway/tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 5 * 60 * 1000,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['json', { outputFile: 'playwright-report/results.json' }],
      ]
    : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'smoke',
      testDir: './apps/gateway/tests/e2e',
      testMatch: 'smoke.spec.ts',
      testIgnore: ['**/real-clouds/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'e2e-real-clouds',
      testDir: './apps/gateway/tests/e2e/real-clouds',
      testMatch: /.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
