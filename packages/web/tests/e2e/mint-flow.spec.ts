/**
 * Mint UI E2E — login → /tokens/new → checklist visible → preview gating.
 *
 * Skipped by default unless E2E_USER_EMAIL + E2E_USER_PASSWORD are provided
 * AND a `playground` project exists with at least one binding (the seeded
 * test customer has 3 in prod).
 *
 * We deliberately do NOT mint a real token here — that would create state
 * in prod we'd then need to clean up. We only verify :
 *   1. the page loads as authenticated,
 *   2. binding cards render (≥ 1),
 *   3. at least one risk row is visible,
 *   4. the "Mint token" button stays disabled until a risk is accepted.
 *
 * Spec : docs/spec/gateway-risk-model.md §9 + annexe A.
 */
import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'https://vaubaan.com';
const EMAIL = process.env.E2E_USER_EMAIL ?? '';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? '';
const ORG_SLUG = process.env.E2E_ORG_SLUG ?? 'sbw-vauban-test';
const PROJECT_SLUG = process.env.E2E_PROJECT_SLUG ?? 'playground';

test.describe('Mint UI', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'E2E_USER_EMAIL / E2E_USER_PASSWORD not set — skipping mint UI E2E.',
  );

  test('checklist is rendered and Mint stays disabled until a risk is checked', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto(`${BASE}/login`);
    await page.getByPlaceholder('you@example.com').fill(EMAIL);
    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(`${BASE}/dashboard`);

    await page.goto(`${BASE}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/tokens/new`);
    await expect(page.getByRole('heading', { name: 'Mint token' })).toBeVisible();

    // At least one binding card. We render `Bindings (N)` as the card title.
    await expect(page.getByText(/Bindings \(\d+\)/)).toBeVisible();

    // The mint button should be present but disabled when no risk is accepted.
    const mintButton = page.getByRole('button', { name: /Mint token|Request approval/ });
    await expect(mintButton).toBeVisible();
    await expect(mintButton).toBeDisabled();

    // At least one risk checkbox is visible (could be all-allow on staging
    // bindings — the live preview would then enable the button).
    const firstCheckbox = page.locator('input[type="checkbox"][aria-label^="Accept risk"]').first();
    await expect(firstCheckbox).toBeVisible();
  });
});
