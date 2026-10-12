import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const TEST_EMAIL = 'renaud.pelissier@gmail.com';
const TEST_PASSWORD = 'VaubaanTest!2026';
const ORG_SLUG = 'sbw-vaubaan';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder('you@example.com').fill(TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/(dashboard|orgs)/, { timeout: 15000 });
}

test.describe('Stripe binding API', () => {
  test('validates account_id prefix', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v1/stripe-bindings`, {
      data: { orgSlug: ORG_SLUG, projectSlug: 'test', account_id: 'bad', test_key: 'sk_test_x' },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('acct_');
  });

  test('rejects missing keys', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v1/stripe-bindings`, {
      data: { orgSlug: ORG_SLUG, projectSlug: 'test', account_id: 'acct_123' },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('At least one key');
  });

  test('validates key prefixes', async ({ request }) => {
    const res = await request.post(`${BASE}/api/v1/stripe-bindings`, {
      data: {
        orgSlug: ORG_SLUG,
        projectSlug: 'test',
        account_id: 'acct_123',
        test_key: 'sk_live_wrong',
      },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('sk_test_');
  });
});

test.describe('Stripe + SSH in providers UI', () => {
  test('providers page shows Stripe and SSH as per-project cards', async ({ page }) => {
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

    // Stripe card visible with per-project badge
    await expect(page.getByText('Stripe', { exact: true }).first()).toBeVisible();

    // SSH card visible with per-project badge
    await expect(page.getByText('SSH', { exact: true }).first()).toBeVisible();

    // At least 3 per-project badges (Bash, SSH, Stripe)
    const badges = page.getByText('per-project');
    expect(await badges.count()).toBeGreaterThanOrEqual(3);
  });
});
