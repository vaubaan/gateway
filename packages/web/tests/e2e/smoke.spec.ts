/**
 * Smoke spec — verifies Playwright is wired up and the prod URL serves
 * a coherent landing page. No auth, no API calls.
 */
import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'https://vaubaan.com';

test('landing renders with Sign in CTA', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByText('Vaubaan').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Sign in|Start free/ })).toBeVisible();
});
