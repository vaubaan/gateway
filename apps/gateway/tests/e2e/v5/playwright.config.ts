import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { instancePort, localOrigin, PUBLIC_URL } from './instance';

/**
 * Browser tests of the v5 human surface against an ephemeral instance:
 * `ephemeral-instance.ts` serves the built app on a root with the `:memory:`
 * store and the simulated IdP. No credential, no network: run with
 * `npm run test:e2e:v5` (which builds first).
 *
 * Kept apart from the root `playwright.config.ts`, whose projects target a
 * deployed v4 instance.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');

export default defineConfig({
  testDir: HERE,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  outputDir: resolve(REPO_ROOT, 'test-results/v5'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: PUBLIC_URL,
    // The size the one-page requirement is checked at: a common laptop screen.
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx apps/gateway/tests/e2e/v5/ephemeral-instance.ts',
    cwd: REPO_ROOT,
    url: `${localOrigin()}/healthz`,
    env: { E2E_V5_PORT: String(instancePort()), NODE_ENV: 'production' },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
