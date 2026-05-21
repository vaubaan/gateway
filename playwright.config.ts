import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for E2E tests against the Next.js web app.
 *
 * Two projects live side-by-side :
 *
 *   - `smoke`            : the legacy stub spec
 *                          (packages/web/tests/e2e/smoke.spec.ts) that
 *                          checks Playwright is wired up. Always
 *                          runnable, no creds needed.
 *
 *   - `e2e-real-clouds`  : the real-providers scenarios under
 *                          packages/web/tests/e2e/real-clouds/.
 *                          Spec §12.3 mandates "no mock". Reads creds
 *                          from .env.test (gitignored) or from the
 *                          GH Actions secrets injected by the nightly
 *                          workflow.
 *
 * Auth state is materialised in tests/e2e/.auth/ (gitignored) — one
 * file per role, populated by the storage-state fixture if needed.
 *
 * `webServer` boots `npm run dev` automatically in local + CI. In CI
 * the timeout is generous because the first Next.js compile can take
 * up to a minute.
 */
export default defineConfig({
  testDir: './packages/web/tests/e2e',
  fullyParallel: false, // real-clouds : one shared web server, serial is safer in v1.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 1,
  timeout: 5 * 60 * 1000, // some flows (Supabase project provisioning) take minutes.
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
      testDir: './packages/web/tests/e2e',
      testMatch: 'smoke.spec.ts',
      testIgnore: ['**/real-clouds/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'e2e-real-clouds',
      testDir: './packages/web/tests/e2e/real-clouds',
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
