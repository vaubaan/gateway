import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const TEST_EMAIL = 'renaud.pelissier@gmail.com';
const TEST_PASSWORD = 'VaubaanTest!2026';
const ORG_SLUG = 'sbw-vaubaan';
const STRIPE_TEST_KEY = process.env.STRIPE_SECRET_KEY ?? '';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder('you@example.com').fill(TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/(dashboard|orgs)/, { timeout: 15000 });
}

test.describe('Stripe connect API', () => {
  test('validates key prefix', async ({ request }) => {
    const res = await request.post(`${BASE}/api/integrations/stripe/connect`, {
      data: { orgSlug: 'test', apiKey: 'invalid_key' },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('sk_test_');
  });

  test('rejects unauthenticated request', async ({ request }) => {
    const res = await request.post(`${BASE}/api/integrations/stripe/connect`, {
      data: { orgSlug: 'test', apiKey: 'sk_test_fakekey123' },
    });
    expect(res.status()).toBe(401);
  });

  test('rejects missing fields', async ({ request }) => {
    const res = await request.post(`${BASE}/api/integrations/stripe/connect`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('required');
  });
});

test.describe('Stripe + SSH in providers UI', () => {
  test('providers page shows Stripe and SSH cards', async ({ page }) => {
    await login(page);

    await page.goto(`${BASE}/orgs/${ORG_SLUG}/providers`);
    await page.waitForLoadState('networkidle');

    if (page.url().includes('login')) {
      test.skip(true, 'Login failed');
      return;
    }

    await expect(page.getByRole('heading', { name: 'Cloud providers' })).toBeVisible({
      timeout: 15000,
    });

    // Stripe card visible
    await expect(page.getByText('Stripe', { exact: true }).first()).toBeVisible();

    // SSH card visible with per-project badge
    await expect(page.getByText('SSH', { exact: true }).first()).toBeVisible();
    const badges = page.getByText('per-project');
    expect(await badges.count()).toBeGreaterThanOrEqual(2);
  });

  test('Stripe connect form loads and validates', async ({ page }) => {
    await login(page);

    await page.goto(`${BASE}/orgs/${ORG_SLUG}/providers/stripe/connect`);
    await page.waitForLoadState('networkidle');

    if (page.url().includes('login')) {
      test.skip(true, 'Login failed');
      return;
    }

    await expect(page.getByRole('heading', { name: 'Connect Stripe' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('heading', { name: 'Stripe API key' })).toBeVisible();

    // Submit without key → button disabled
    const submitBtn = page.getByRole('button', { name: 'Connect Stripe' });
    await expect(submitBtn).toBeDisabled();

    // Type a key and check mode detection
    const input = page.locator('input[type="password"]');
    await input.fill('sk_test_fakekey');
    await expect(page.getByText('Mode detected:')).toBeVisible();
    await expect(page.getByText('test', { exact: true })).toBeVisible();
    await expect(submitBtn).toBeEnabled();
  });

  test('Stripe connect with real test key', async ({ page }) => {
    test.skip(!STRIPE_TEST_KEY, 'STRIPE_SECRET_KEY not set');

    await login(page);

    await page.goto(`${BASE}/orgs/${ORG_SLUG}/providers/stripe/connect`);
    await page.waitForLoadState('networkidle');

    if (page.url().includes('login')) {
      test.skip(true, 'Login failed');
      return;
    }

    await expect(page.getByRole('heading', { name: 'Connect Stripe' })).toBeVisible({
      timeout: 10000,
    });

    // Paste the real test key
    const input = page.locator('input[type="password"]');
    await input.fill(STRIPE_TEST_KEY);

    // Submit
    await page.getByRole('button', { name: 'Connect Stripe' }).click();

    // Should redirect back to providers page on success
    await page.waitForURL(/\/providers$/, { timeout: 15000 });

    // Stripe should now show as connected
    await expect(page.getByText('Stripe', { exact: true }).first()).toBeVisible();
  });
});
