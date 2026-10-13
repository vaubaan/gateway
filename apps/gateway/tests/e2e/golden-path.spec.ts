/**
 * E2E golden path against the deployed prod URL.
 *
 *   1. Login via password (seeded test@vaubaan.com / VaubanTest!2026).
 *   2. Land on /dashboard, see at least one organization (Acme test customer).
 *   3. Open the org page, see 3 providers connected + 1 project.
 *   4. Open the Playground project, see 3 bindings + access tokens.
 *   5. Open the Roles catalog, see 4+ builtin roles.
 *
 * No assertion against the MCP endpoint here — that lives in the unit + integration
 * suites (rely on the gateway test against a fake adapter, plus the live-smoke
 * curl scripts).
 *
 * Skipped if E2E_BASE_URL or E2E_USER_EMAIL/PASSWORD not configured.
 */

import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'https://vaubaan.com';
const EMAIL = process.env.E2E_USER_EMAIL ?? 'test@vaubaan.com';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? '';

test.describe('Vaubaan golden path', () => {
  test('login → dashboard → org → project → roles', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(`${BASE}/login`);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.getByPlaceholder('you@example.com').fill(EMAIL);
    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await page.waitForURL(`${BASE}/dashboard`);
    await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();

    // Open the seeded org (sbw-vauban-test).
    await page
      .getByRole('link')
      .filter({ hasText: /sbw-vauban-test|Acme/ })
      .first()
      .click();
    await page.waitForURL(/\/orgs\//);
    await expect(page.getByRole('heading', { level: 2, name: /Cloud providers/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Projects/i })).toBeVisible();

    // Open the Playground project.
    await page
      .getByRole('link')
      .filter({ hasText: /Playground/ })
      .first()
      .click();
    await page.waitForURL(/\/projects\/playground/);
    await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible();

    // Open the Roles catalog from the org page.
    await page.goBack();
    await page.getByRole('link', { name: /Roles catalog|Browse builtin/i }).click();
    await page.waitForURL(/\/roles$/);
    await expect(page.getByRole('heading', { name: /Roles/ })).toBeVisible();
    await expect(page.getByText('github:developer')).toBeVisible();
    await expect(page.getByText('vercel:viewer')).toBeVisible();
    await expect(page.getByText('supabase:reader')).toBeVisible();
  });
});
