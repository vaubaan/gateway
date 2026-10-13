/**
 * "Share, then orphan" in a browser, against an ephemeral instance with a
 * simulated IdP (spec §7.3, §7.8, §4.2 "Connections" / "Shares received" /
 * "Administration", §2.3 "orphaned" / "unowned").
 *
 * Hedy owns a GitHub connection. She shares two risks of it with Joan through
 * the Share dialog; Joan finds the share under "Shares received", issues a
 * mission on it — her creation screen offers nothing beyond the restriction —
 * and an MCP client holding that mission's token reads a file through the
 * door. Hedy revokes the share: the same client is refused
 * `mission-inactive` (orphaned), and Joan sees why her mission stopped. Hedy
 * shares again: the state was derived, never stored, so the same client with
 * the same token is served again and Joan's mission reads active.
 *
 * The second test is the ownership loop: transfer to a group, the group
 * empties, the connection has no owner, the operator reassigns one.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { routeToInstance, seedShareScenario, signInAs } from './browser';
import { E2E_OPERATOR, E2E_SHARE_OWNER, E2E_SHARE_TARGET } from './instance';

const TOKEN = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;
const READ_CODE = 'github.read-code';
const READ_META = 'github.read-meta';
type User = typeof E2E_SHARE_OWNER | typeof E2E_SHARE_TARGET | typeof E2E_OPERATOR;

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

let agent: Agent | null = null;
const opened: Page[] = [];

test.afterEach(async () => {
  await agent?.close();
  agent = null;
  for (const page of opened.splice(0)) await page.context().close();
});

/** A browser of their own for `user`, signed in through the simulated IdP. */
async function browserOf(
  browser: Browser,
  request: Parameters<typeof signInAs>[0],
  user: User,
  landing: string,
): Promise<Page> {
  const context = await browser.newContext();
  await routeToInstance(context);
  const page = await context.newPage();
  opened.push(page);
  await signInAs(request, user);
  await page.goto(`/auth/login?return_to=${encodeURIComponent(landing)}`);
  await expect(page.getByRole('banner').getByText(user.email)).toBeVisible();
  return page;
}

test('share two risks, issue within them, revoke the share: the mission is orphaned; share again: it is restored', async ({
  browser,
  request,
}) => {
  const connectionName = 'hedy-org';
  const { connection_id: connectionId } = await seedShareScenario(request, connectionName);

  // ── The owner shares ────────────────────────────────────────────────────
  const hedy = await browserOf(browser, request, E2E_SHARE_OWNER, `/connections/${connectionId}`);
  await expect(hedy.getByRole('heading', { name: connectionName, level: 1 })).toBeVisible();
  await expect(hedy.getByText('Not shared.')).toBeVisible();
  await hedy.getByRole('link', { name: 'Share', exact: true }).click();
  await expect(hedy.getByRole('heading', { name: `Share ${connectionName}` })).toBeVisible();

  // The dialog is a target and one folded checklist behind a one-line summary.
  const summary = hedy.getByTestId('restriction-summary');
  const submit = hedy.getByRole('button', { name: 'Share', exact: true });
  await expect(summary).toHaveText('No risk selected: the share would authorize nothing.');
  await expect(submit).toBeDisabled();
  await expect(hedy.locator('details[open]')).toHaveCount(0);
  await expect(hedy.getByLabel(`Share risk ${READ_CODE}`)).toBeHidden();
  await snap(hedy, 'share-dialog-folded');

  await hedy.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  await hedy.getByText(/^Risks \(\d+\)$/).click();
  // "Select all" ticks the boxes one by one: every risk but the fallback.
  await hedy.getByRole('button', { name: 'Select all' }).click();
  await expect(summary).toContainText('14 of 15 risks');
  await expect(hedy.getByLabel('Share risk github.uncategorized-write')).not.toBeChecked();
  await expect(hedy.getByLabel('Share risk github.merge-protected')).toBeChecked();
  await snap(hedy, 'share-dialog-select-all');
  // This share is narrower: two reads.
  await hedy.getByRole('button', { name: 'Clear' }).click();
  await hedy.getByLabel(`Share risk ${READ_CODE}`).check();
  await hedy.getByLabel(`Share risk ${READ_META}`).check();
  await expect(summary).toContainText('2 of 15 risks');
  await submit.click();

  await expect(hedy).toHaveURL(new RegExp(`/connections/${connectionId}\\?notice=`));
  await expect(hedy.getByText('Shared', { exact: true })).toBeVisible();
  await expect(
    hedy.getByText(`${E2E_SHARE_TARGET.email} may now accept 2 risks of this connection`),
  ).toBeVisible();
  const shareRow = hedy.getByRole('row').filter({ hasText: E2E_SHARE_TARGET.email });
  await expect(shareRow).toContainText('2 risks');
  await shareRow.getByText('2 risks').click();
  await expect(shareRow).toContainText(READ_CODE);
  await expect(shareRow).toContainText(READ_META);
  await expect(shareRow).not.toContainText('github.merge-protected');
  await snap(hedy, 'connection-shares');

  // ── The beneficiary reads what she received ─────────────────────────────
  const joan = await browserOf(browser, request, E2E_SHARE_TARGET, '/shares');
  await expect(joan.getByRole('heading', { name: 'Shares received' })).toBeVisible();
  const received = joan.getByRole('row').filter({ hasText: connectionName });
  await expect(received).toContainText(E2E_SHARE_OWNER.email);
  await expect(received).toContainText('you');
  // The exact restriction, on demand.
  await expect(received.getByText(READ_CODE)).toBeHidden();
  await received.getByText('2 risks').click();
  await expect(received.getByText(READ_CODE)).toBeVisible();
  await expect(received.getByText(READ_META)).toBeVisible();
  await snap(joan, 'shares-received');
  // The connection is not hers: it is not under her Connections.
  await joan.goto('/connections');
  await expect(joan.getByText(connectionName)).toHaveCount(0);
  const foreign = await joan.goto(`/connections/${connectionId}/share`);
  expect(foreign?.status()).toBe(404);

  // ── …and issues a mission within it ─────────────────────────────────────
  await joan.goto('/missions/new');
  await joan.getByLabel('Mission name').fill('Read hedy-org');
  await joan.getByTestId('risks-github').locator(':scope > summary').click();
  // The detail offers what she holds; the rest of the catalog cannot be ticked.
  await expect(joan.getByLabel('Accept risk github.merge-protected')).toHaveCount(0);
  await joan.getByLabel(`Accept risk ${READ_CODE}`).check();
  await joan.getByRole('button', { name: 'Issue mission' }).click();
  const dialog = joan.getByRole('dialog');
  await expect(dialog).toContainText('Mission “Read hedy-org” issued');
  const token = TOKEN.exec(await dialog.getByTestId('kit-env').innerText())?.[0];
  if (!token) throw new Error('no token in the bootstrap kit');

  const executor = (agent = await connectAgent(token));
  const read = () =>
    executor.call('github__get_file_contents', { owner: 'acme', repo: 'app', path: 'README.md' });
  expect(await read()).toMatchObject({ outcome: 'allowed' });

  // ── The owner revokes the share ─────────────────────────────────────────
  await hedy.goto(`/connections/${connectionId}`);
  await hedy.getByRole('button', { name: `Revoke the share to ${E2E_SHARE_TARGET.email}` }).click();
  await expect(hedy.getByText('Share revoked', { exact: true })).toBeVisible();
  await expect(
    hedy.getByText(
      '1 mission that depended on it is now orphaned and refuses every call, until a share covers it again.',
    ),
  ).toBeVisible();
  await expect(hedy.getByText('Not shared.')).toBeVisible();

  // ── The executor is refused, with the reason ────────────────────────────
  const after = await read();
  if (after.outcome !== 'refused') throw new Error('the orphaned mission still answered');
  expect(after.refusal).toMatchObject({ code: 'mission-inactive', status: 'orphaned' });
  expect(after.refusal.hint).toContain('orphaned');

  // ── The beneficiary sees it ─────────────────────────────────────────────
  await joan.goto('/missions');
  await expect(joan.getByRole('row').filter({ hasText: 'Read hedy-org' })).toContainText(
    'orphaned',
  );
  await joan.goto('/shares');
  await expect(joan.getByText('Nobody has shared a connection with you yet.')).toBeVisible();
  // Her mission page says why, that it can come back, and still lets her close it.
  await joan.goto('/missions');
  await joan.getByRole('link', { name: 'Read hedy-org' }).click();
  await expect(
    joan.getByText('Orphaned: you no longer hold the authority this mission was issued under'),
  ).toBeVisible();
  await expect(
    joan.getByText(/you no longer cover this accepted risk: github\.read-code/),
  ).toBeVisible();
  await expect(
    joan.getByText(/serves calls again as soon as that authority is back/),
  ).toBeVisible();
  await expect(joan.getByRole('button', { name: 'Revoke mission' })).toBeVisible();
  await expect(joan.getByRole('button', { name: 'Rotate token' })).toHaveCount(0);
  await snap(joan, 'mission-orphaned');
  const missionUrl = joan.url();

  // ── The owner shares again: the mission is restored ─────────────────────
  await hedy.getByRole('link', { name: 'Share', exact: true }).click();
  await hedy.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  await hedy.getByText(/^Risks \(\d+\)$/).click();
  await hedy.getByLabel(`Share risk ${READ_CODE}`).check();
  await hedy.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(hedy.getByText('Shared', { exact: true })).toBeVisible();
  await expect(
    hedy.getByText(
      '1 orphaned mission is covered again and serves calls from now on, with its session and counters as they were.',
    ),
  ).toBeVisible();

  // The same client, the same token: no new mission, no new kit.
  expect(await read()).toMatchObject({ outcome: 'allowed' });

  await joan.goto('/missions');
  const restored = joan.getByRole('row').filter({ hasText: 'Read hedy-org' });
  await expect(restored).toContainText('active');
  await expect(restored).not.toContainText('orphaned');
  await joan.goto(missionUrl);
  await expect(joan.getByText(/^Orphaned:/)).toHaveCount(0);
  await expect(joan.getByRole('button', { name: 'Rotate token' })).toBeVisible();
  // The session kept its history across the gap: two calls served, one refused.
  await joan.getByRole('link', { name: 'Session', exact: true }).click();
  await expect(joan.getByRole('heading', { name: /Session/ })).toContainText('active');
  await snap(joan, 'mission-restored-session');
  // Both acts of the owner are in the creator's audit.
  await joan.getByRole('link', { name: 'Audit of this mission' }).click();
  await expect(joan.getByText('mission-orphaned').first()).toBeVisible();
  await expect(joan.getByText('mission-restored').first()).toBeVisible();
});

test('transfer to a group; the group empties; the operator reassigns the connection', async ({
  browser,
  request,
}) => {
  const connectionName = 'hedy-team-org';
  const group = 'hedy-team';
  const { connection_id: connectionId } = await seedShareScenario(request, connectionName);

  // ── The operator keeps a local group ────────────────────────────────────
  const ops = await browserOf(browser, request, E2E_OPERATOR, '/admin/groups');
  await expect(ops.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible();
  await ops.getByLabel('Name of the new group').fill(group);
  await ops.getByRole('button', { name: 'Create' }).click();
  await expect(ops.getByText(`Group "${group}" created`)).toBeVisible();
  await ops.getByLabel(`Email to add to ${group}`).fill(E2E_SHARE_OWNER.email);
  await ops.getByRole('button', { name: 'Add member' }).click();
  await expect(ops.getByText(`${E2E_SHARE_OWNER.email} added to "${group}"`)).toBeVisible();
  await snap(ops, 'admin-groups');

  // ── The owner transfers her connection to it ────────────────────────────
  const hedy = await browserOf(browser, request, E2E_SHARE_OWNER, `/connections/${connectionId}`);
  await hedy.getByLabel('Group to transfer to').selectOption({ label: group });
  await hedy.getByRole('button', { name: 'Transfer' }).click();
  await expect(hedy.getByText(`Transferred to group ${group}`)).toBeVisible();
  await expect(hedy.getByText(`group ${group}`, { exact: true })).toBeVisible();

  // ── The group loses its only member ─────────────────────────────────────
  await ops.goto('/admin/groups');
  await ops.getByRole('button', { name: `Remove ${E2E_SHARE_OWNER.email} from ${group}` }).click();
  await expect(ops.getByText('1 connection has no owner left', { exact: false })).toBeVisible();

  // Nobody owns it: it left the former owner's list.
  await hedy.goto('/connections');
  await expect(hedy.getByText(connectionName)).toHaveCount(0);

  // ── The operator names a new owner ──────────────────────────────────────
  await ops.goto('/admin/connections');
  await expect(ops.getByRole('heading', { name: 'Connections without owner' })).toBeVisible();
  await expect(ops.getByText(connectionName)).toBeVisible();
  await expect(ops.getByText(`was owned by group ${group}`)).toBeVisible();
  await snap(ops, 'admin-connections-without-owner');
  await ops.getByLabel('User email').fill(E2E_SHARE_OWNER.email);
  await ops.getByRole('button', { name: 'Reassign' }).click();
  await expect(ops.getByText(`${connectionName}: owner reassigned`)).toBeVisible();
  await expect(ops.getByText('Every connection has an owner.')).toBeVisible();

  await hedy.goto(`/connections/${connectionId}`);
  await expect(hedy.getByRole('heading', { name: connectionName, level: 1 })).toBeVisible();
  await expect(hedy.getByText(E2E_SHARE_OWNER.email, { exact: true }).first()).toBeVisible();
  await expect(hedy.getByRole('link', { name: 'Share', exact: true })).toBeVisible();
});
