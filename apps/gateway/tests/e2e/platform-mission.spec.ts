/**
 * "Have an agent prepare a mission" in a browser, against an ephemeral instance
 * with a simulated IdP (spec §4.1 bis, §4.2, §7.10; ADR
 * platform-management-is-a-plugin-on-the-execution-door).
 *
 * The person connects their Vaubaan account in one click — no field, nothing to
 * paste — reads on its page that it is theirs alone, creates the platform
 * management mission the page offers (the creation form prefilled, every
 * macro-action at Careful) and hands its key to an agent: the official MCP
 * client on `/mcp`, which reads the person's accounts with
 * `vaubaan__list_my_accounts` and is asked to wait for a yes before it
 * issues anything. Settings no longer has Connected apps.
 */
import { expect, test } from '@playwright/test';

import { connectAgent } from './agent';
import { routeToInstance, signInAs } from './browser';
import { createMission } from './mission-pages';

/** A person of her own: what she connects changes no other spec's accounts. */
const GRACE = { sub: 'idp|grace', email: 'grace@example.com', name: 'Grace' } as const;

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, GRACE);
});

test('connect Vaubaan in one click, create the platform mission, and its key reads the accounts', async ({
  page,
}) => {
  await page.goto('/auth/login?return_to=/accounts/new/vaubaan');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Connect a Vaubaan account$/);
  // One click: no name, no field, nothing to paste.
  await expect(page.getByLabel('Name')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  // The account page: hers alone, no "Give access", the platform mission offered.
  await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Vaubaan$/);
  await expect(page.getByTestId('account-personal')).toContainText('yours alone');
  await expect(page.getByRole('link', { name: 'Give access' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create the platform management mission' }).click();

  // The creation form, prefilled: the person sees it and may change it.
  await expect(page).toHaveURL(/\/missions\/new\?platform=/);
  await expect(page.getByTestId('platform-mission')).toContainText('Careful');
  await expect(page.getByLabel('Mission name')).toHaveValue('Platform management');
  const key = await createMission(page);

  // The agent holds the key and nothing else: the Vaubaan tools are its tools on /mcp.
  const agent = await connectAgent(key, 'planner');
  try {
    const tools = await agent.listTools();
    expect(tools).toContain('vaubaan__list_my_accounts');
    expect(tools).toContain('vaubaan__issue_mission');
    const listed = await agent.call('vaubaan__list_my_accounts', {});
    expect(listed.outcome).toBe('allowed');
    if (listed.outcome === 'allowed') expect(listed.text).toContain('"service": "vaubaan"');
    // At Careful, issuing asks the person first.
    const asked = await agent.call('vaubaan__issue_mission', {
      name: 'Nothing yet',
      accounts: [{ service: 'github', trust_levels: { read: 'careful' } }],
      period: { kind: 'one-off' },
      expires_at: null,
    });
    expect(asked.outcome).toBe('refused');
    if (asked.outcome === 'refused') expect(asked.refusal.code).toBe('approval-required');
  } finally {
    await agent.close();
  }
});

test('Settings has no Connected apps any more', async ({ page }) => {
  await page.goto('/auth/login?return_to=/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  const local = page.getByRole('navigation', { name: 'Settings' });
  await expect(local.getByRole('link', { name: 'Connected apps' })).toHaveCount(0);
});
