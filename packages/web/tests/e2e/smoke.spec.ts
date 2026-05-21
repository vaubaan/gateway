import { test, expect } from '@playwright/test';

/**
 * E2E smoke test — placeholder. Real E2E scenarios (spec §12.3) land
 * in later phases and require .env.test populated with provider creds.
 *
 * Run with: `npm run dev` in one shell, `npm run test:e2e` in another.
 */
test.skip('home page renders the init confirmation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /CRM init OK/i })).toBeVisible();
});
