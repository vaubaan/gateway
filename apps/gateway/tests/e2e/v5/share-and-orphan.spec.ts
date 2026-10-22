/**
 * "Give access, then remove it" in a browser, against an ephemeral instance
 * with a simulated IdP (spec §7.3, §7.8, §4.2 "Connections" / "Shares
 * received" / "Administration", §2.3 "orphaned" / "unowned").
 *
 * Ines owns a GitHub account (a connection). She gives Joan access to two of
 * its permissions through the "Give access" dialog; Joan finds it under
 * "Shared with you" on her Accounts page, issues a mission on it — her
 * creation screen offers nothing beyond what she was given — and an MCP
 * client holding that mission's token reads a file through the door. Ines
 * removes the access, which is asked first: the same client is refused
 * `mission-inactive` (orphaned), and Joan sees why her mission stopped. Ines
 * gives access again: the dialog names the mission it brings back; the state
 * was derived, never stored, so the same client with the same token is served
 * again and Joan's mission reads active.
 *
 * The second test is the ownership loop: transfer to a team, the team
 * empties, the account has no owner, the administrator names one.
 *
 * The third is a disconnection under a two-account mission: the mission
 * loses that account only (ADR orphaned-missions-and-ownerless-connections,
 * amendment 2026-10-21) — refused `connection-revoked` there, served on the
 * other, and its page says which account is gone.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { passSecondFactor, routeToInstance, seedShareScenario, signInAs } from './browser';
import { controlUrl, E2E_OPERATOR, E2E_SHARE_OWNER, E2E_SHARE_TARGET } from './instance';
import { createMission, permissionRow, pickPreset } from './mission-pages';

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

/** "Remove" on the one access of the account, confirmed in the dialog that says what stops. */
async function removeAccess(page: Page, missionsStopped: number): Promise<void> {
  await page.getByRole('button', { name: `Remove the access of ${E2E_SHARE_TARGET.name}` }).click();
  const confirm = page.getByTestId('remove-access-dialog');
  await expect(confirm).toContainText(
    missionsStopped === 1
      ? 'the 1 mission that uses it stops at once'
      : 'none of their missions uses it today',
  );
  await confirm.getByRole('button', { name: 'Remove access' }).click();
}

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
  // An administrator gives the gateway's own second factor; the others' directory waives it.
  await passSecondFactor(page, request, user.email);
  await expect(page.getByTestId('user-menu')).toContainText(user.email);
  return page;
}

test('share two risks, issue within them, revoke the share: the mission is orphaned; share again: it is restored', async ({
  browser,
  request,
}) => {
  const connectionName = 'ines-org';
  const { connection_id: connectionId } = await seedShareScenario(request, connectionName);

  // ── The owner shares ────────────────────────────────────────────────────
  const ines = await browserOf(browser, request, E2E_SHARE_OWNER, `/accounts/${connectionId}`);
  await expect(ines.getByRole('heading', { name: connectionName, level: 1 })).toBeVisible();
  // Nobody but its owner holds it yet: one line, "all 19".
  const access = ines.getByTestId('who-has-access');
  await expect(access.getByRole('row')).toHaveCount(2);
  await expect(access).toContainText('all 19');
  await ines.getByRole('link', { name: 'Give access', exact: true }).click();
  const dialog = ines.getByTestId('give-access-dialog');
  await expect(
    dialog.getByRole('heading', { name: `Give access to ${connectionName}` }),
  ).toBeVisible();
  // The page of the account stays under the dialog.
  await expect(ines.getByRole('heading', { name: connectionName, level: 1 })).toBeAttached();

  // The dialog is who, starting points, the checklist with a "why?" per line, and a one-line summary.
  const summary = dialog.getByTestId('restriction-summary');
  const submit = dialog.getByRole('button', { name: /^Give access · / });
  await expect(summary).toHaveText('Nothing ticked: this access would allow nothing.');
  await expect(submit).toHaveText('Give access · 0 permissions');
  await expect(submit).toBeDisabled();
  await expect(dialog.getByLabel(`Give ${READ_CODE}`)).toBeVisible();
  // What it allows in words, its id, its severity; the reason and the six words behind "why?".
  const readCode = dialog.locator(`tr[data-permission="${READ_CODE}"]`);
  await expect(readCode).toContainText('Read code, branches, commits, files');
  await expect(readCode).toContainText(READ_CODE);
  await expect(readCode).toContainText('low');
  await expect(dialog.getByText('Reads may leak secrets')).toBeHidden();
  await readCode.getByRole('button', { name: 'why?' }).click();
  await expect(dialog.getByText('Reads may leak secrets')).toBeVisible();
  await expect(dialog.getByText('Blast radius').first()).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Full entry in the reference' })).toHaveAttribute(
    'href',
    `/reference/github#risk-${READ_CODE}`,
  );
  // What "select all" leaves out is said in the dialog, with no click.
  await expect(
    dialog.getByText('a permission added to the catalog later is not included until you tick it'),
  ).toBeVisible();
  await snap(ines, 'share-dialog');

  await dialog.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  // "Select all" ticks the boxes one by one: every permission but "anything not named".
  await dialog.getByRole('button', { name: 'Select all 16' }).click();
  await expect(summary).toContainText('16 of 19 permissions');
  await expect(dialog.getByLabel('Give github.uncategorized-write')).not.toBeChecked();
  await expect(dialog.getByLabel('Give github.merge-protected')).toBeChecked();
  await snap(ines, 'share-dialog-select-all');
  // A preset is a starting point: it ticks its own explicit list. Read-only is two reads.
  await dialog.getByRole('button', { name: 'Read-only', exact: true }).click();
  await expect(dialog.getByLabel(`Give ${READ_CODE}`)).toBeChecked();
  await expect(dialog.getByLabel(`Give ${READ_META}`)).toBeChecked();
  await expect(dialog.getByLabel('Give github.merge-protected')).not.toBeChecked();
  await expect(summary).toContainText('2 of 19 permissions');
  await expect(submit).toHaveText('Give access · 2 permissions');
  // "Clear", then the same two by hand: the list posted is the one ticked.
  await dialog.getByRole('button', { name: 'Clear' }).click();
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(`Give ${READ_CODE}`).check();
  await dialog.getByLabel(`Give ${READ_META}`).check();
  await submit.click();

  await expect(ines).toHaveURL(new RegExp(`/accounts/${connectionId}\\?notice=`));
  await expect(ines.getByText('Access given', { exact: true })).toBeVisible();
  await expect(
    ines.getByText(`${E2E_SHARE_TARGET.email} may now allow 2 permissions of this account`),
  ).toBeVisible();
  // "Who has access" lists her; the count unfolds the explicit list.
  const shareRow = access.getByRole('row').filter({ hasText: E2E_SHARE_TARGET.name });
  await expect(shareRow).toContainText('2 of 19');
  await expect(shareRow).toContainText('read only');
  await shareRow.getByRole('link', { name: '2 of 19' }).click();
  const held = ines.getByTestId('access-permissions');
  await expect(held).toContainText(READ_CODE);
  await expect(held).toContainText(READ_META);
  await expect(held).not.toContainText('github.merge-protected');
  await snap(ines, 'connection-shares');

  // ── The beneficiary reads what she received ─────────────────────────────
  // The page that listed what was received is a region of Accounts: its old path leads there.
  const joan = await browserOf(browser, request, E2E_SHARE_TARGET, '/shares');
  await expect(joan).toHaveURL(/\/accounts$/);
  await expect(joan.getByRole('heading', { name: /^Shared with you/ })).toBeVisible();
  const shared = joan.getByTestId('shared-with-you');
  const received = shared.getByRole('row').filter({ hasText: connectionName });
  await expect(received).toContainText(E2E_SHARE_OWNER.email);
  await expect(received).toContainText('2 of 19');
  // The exact list, on demand.
  await expect(joan.getByTestId('allowed-permissions')).toHaveCount(0);
  await received.getByRole('link', { name: '2 of 19' }).click();
  await expect(joan.getByTestId('allowed-permissions')).toContainText(READ_CODE);
  await expect(joan.getByTestId('allowed-permissions')).toContainText(READ_META);
  await snap(joan, 'shares-received');
  // The account is not hers: she owns none, and its own page does not exist for her.
  await expect(joan.getByTestId('accounts-yours')).toHaveCount(0);
  for (const path of [`/accounts/${connectionId}`, `/accounts/${connectionId}/share`]) {
    const foreign = await joan.goto(path);
    expect(foreign?.status(), path).toBe(404);
  }

  // ── …and issues a mission within it ─────────────────────────────────────
  await joan.goto('/missions/new');
  await joan.getByLabel('Mission name').fill('Read ines-org');
  // The account says on what ground she may use it, and how much of it she may allow.
  await expect(joan.getByTestId('connection-github')).toContainText(
    /access given to you · may allow \d+ of \d+/,
  );
  await pickPreset(joan, `GitHub ${connectionName}`, 'Custom');
  // The editor shows what she may allow; what she may not is one filter away, listed with
  // the reason and without a usable tick.
  const editor = joan.getByTestId('risks-github');
  await expect(permissionRow(editor, 'github.merge-protected')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Not available', exact: true }).click();
  await expect(joan.getByLabel('Allow github.merge-protected')).toBeDisabled();
  await expect(permissionRow(editor, 'github.merge-protected')).toContainText(
    'Not available: outside what you may allow',
  );
  await editor.getByRole('button', { name: 'Available to you', exact: true }).click();
  await joan.getByLabel(`Allow ${READ_CODE}`).check();
  const token = await createMission(joan);

  const executor = (agent = await connectAgent(token));
  const read = () =>
    executor.call('github__get_file_contents', { owner: 'acme', repo: 'app', path: 'README.md' });
  expect(await read()).toMatchObject({ outcome: 'allowed' });

  // ── The owner revokes the share ─────────────────────────────────────────
  // The page names the mission that runs on her account, though it is not hers to open.
  await ines.goto(`/accounts/${connectionId}`);
  const missions = ines.getByTestId('account-missions');
  await expect(missions).toContainText('Read ines-org');
  await expect(missions).toContainText(E2E_SHARE_TARGET.email);
  await expect(missions.getByRole('link', { name: 'Read ines-org' })).toHaveCount(0);
  // Removing is asked first, and says what stops.
  await removeAccess(ines, 1);
  await expect(ines.getByText('Access removed', { exact: true })).toBeVisible();
  await expect(
    ines.getByText(
      '1 mission that depended on it is stopped and refuses every call, until an access covers it again.',
    ),
  ).toBeVisible();
  await expect(access.getByRole('row')).toHaveCount(2);

  // ── The executor is refused, with the reason ────────────────────────────
  const after = await read();
  if (after.outcome !== 'refused') throw new Error('the orphaned mission still answered');
  expect(after.refusal).toMatchObject({ code: 'mission-inactive', status: 'orphaned' });
  expect(after.refusal.hint).toContain('orphaned');

  // ── The beneficiary sees it ─────────────────────────────────────────────
  await joan.goto('/missions');
  await expect(joan.getByRole('row').filter({ hasText: 'Read ines-org' })).toContainText(
    'Needs an owner',
  );
  await joan.goto('/accounts');
  await expect(joan.getByTestId('shared-with-you')).toHaveCount(0);
  await expect(joan.getByTestId('accounts-empty')).toBeVisible();
  // Her mission page says why, that it can come back, and still lets her close it.
  await joan.goto('/missions');
  await joan.getByRole('link', { name: 'Read ines-org' }).click();
  await expect(joan.getByTestId('mission-state')).toHaveText('Needs an owner');
  const orphaned = joan.getByTestId('orphan-callout');
  await expect(orphaned).toContainText(
    'Needs an owner: you may no longer allow what this mission allows',
  );
  await expect(orphaned).toContainText(
    /you may no longer allow this permission: github\.read-code/,
  );
  await expect(orphaned).toContainText(/serves calls again as soon as you may allow them again/);
  // She can still stop it; nothing that would be refused is offered (no key can be made now).
  await joan.getByTestId('mission-menu').click();
  await expect(joan.getByRole('menuitem', { name: 'Stop the mission' })).toBeVisible();
  await expect(joan.getByRole('menuitem', { name: 'Replace my key' })).toHaveCount(0);
  await expect(joan.getByRole('menuitem', { name: 'New machine key' })).toHaveCount(0);
  await joan.keyboard.press('Escape');
  await snap(joan, 'mission-orphaned');
  const missionUrl = joan.url();

  // ── The owner shares again: the mission is restored ─────────────────────
  // The stopped mission is on the page of the account, with why.
  await expect(missions).toContainText('Needs an owner');
  await ines.getByRole('link', { name: 'Give access', exact: true }).click();
  await dialog.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  await dialog.getByLabel(`Give ${READ_CODE}`).check();
  await dialog.getByRole('button', { name: 'Give access · 1 permission' }).click();
  // Nothing is given yet: the dialog names the mission the access would bring back.
  const confirm = ines.getByTestId('give-access-confirm');
  await expect(
    confirm.getByRole('heading', { name: 'Give access and bring a stopped mission back?' }),
  ).toBeVisible();
  await expect(ines.getByTestId('share-restores')).toContainText('Read ines-org');
  await expect(ines.getByTestId('share-restores')).toContainText(E2E_SHARE_TARGET.email);
  expect(await read()).toMatchObject({ outcome: 'refused' });
  await snap(ines, 'share-dialog-restores');
  // She may still change what she gives: the checklist is as she posted it.
  await confirm.getByRole('button', { name: 'Change the permissions' }).click();
  await expect(dialog.getByLabel(`Give ${READ_CODE}`)).toBeChecked();
  await expect(dialog.getByLabel(`Give ${READ_META}`)).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Give access · 1 permission' }).click();
  await confirm.getByRole('button', { name: 'Give access and bring it back' }).click();
  await expect(ines.getByText('Access given', { exact: true })).toBeVisible();
  await expect(
    ines.getByText(
      '1 mission is covered again on this account and serves calls through it from now on, with its limits as they were.',
    ),
  ).toBeVisible();

  // The same client, the same token: no new mission, no new kit.
  expect(await read()).toMatchObject({ outcome: 'allowed' });

  await joan.goto('/missions');
  const restored = joan.getByRole('row').filter({ hasText: 'Read ines-org' });
  await expect(restored).toContainText('running');
  await expect(restored).not.toContainText('Needs an owner');
  await joan.goto(missionUrl);
  await expect(joan.getByTestId('orphan-callout')).toHaveCount(0);
  await expect(joan.getByTestId('mission-state')).toHaveCount(0);
  await joan.getByTestId('mission-menu').click();
  await expect(joan.getByRole('menuitem', { name: 'Replace my key' })).toBeVisible();
  await joan.keyboard.press('Escape');
  // The activity kept its history across the gap: the two calls served are still there.
  await joan.getByRole('link', { name: 'Everything this mission did' }).click();
  await expect(joan.getByRole('heading', { name: /^Activity of /, level: 1 })).toBeVisible();
  const timeline = joan.getByTestId('timeline');
  await expect(timeline.locator('tbody tr').filter({ hasText: 'allowed' })).toHaveCount(2);
  await snap(joan, 'mission-restored-activity');
  // Both acts of the owner are in the creator's record.
  await joan.getByRole('link', { name: 'Full record of this mission' }).click();
  await expect(joan.getByText('left a mission without an owner').first()).toBeVisible();
  await expect(joan.getByText('brought a mission back').first()).toBeVisible();

  // ── The owner revokes the share again, then closes the orphaned mission ──
  await ines.goto(`/accounts/${connectionId}`);
  await expect(missions).toContainText('Read ines-org');
  await expect(missions).not.toContainText('Needs an owner');
  await removeAccess(ines, 1);
  await expect(ines.getByText('Access removed', { exact: true })).toBeVisible();
  await expect(missions).toContainText('Needs an owner');
  await expect(missions).toContainText(E2E_SHARE_TARGET.email);
  await expect(missions).toContainText('its creator no longer holds the permissions it uses');
  await snap(ines, 'connection-orphaned-missions');
  await missions.getByRole('button', { name: 'Close mission Read ines-org' }).click();
  const closing = ines.getByRole('dialog').filter({ hasText: 'Close Read ines-org?' });
  await closing.getByRole('textbox').fill('Read ines-org');
  await snap(ines, 'connection-close-orphaned-confirm');
  await closing.getByRole('button', { name: 'Close mission', exact: true }).click();
  // Closed for good: it is no longer among the missions that run or wait, only among the ended ones.
  await expect(missions).not.toContainText('Needs an owner');
  await missions.getByRole('button', { name: 'Show the 1 that ended' }).click();
  await expect(missions).toContainText('stopped');
  // Revoked for good: the client is refused, and sharing again brings nothing back.
  expect(await read()).toMatchObject({ outcome: 'refused' });
  await joan.goto(missionUrl);
  await expect(joan.getByTestId('mission-state')).toHaveText('stopped');
  await ines.getByRole('link', { name: 'Give access', exact: true }).click();
  await dialog.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  await dialog.getByLabel(`Give ${READ_CODE}`).check();
  await dialog.getByRole('button', { name: 'Give access · 1 permission' }).click();
  await expect(ines.getByText('Access given', { exact: true })).toBeVisible();
  await expect(ines.getByTestId('give-access-confirm')).toHaveCount(0);
  expect(await read()).toMatchObject({ outcome: 'refused' });

  // ── Disconnecting the account says what becomes of the access at the service ──
  await ines.goto(`/accounts/${connectionId}`);
  await ines.getByTestId('disconnect-account').click();
  const disconnecting = ines
    .getByRole('dialog')
    .filter({ hasText: `Disconnect ${connectionName}?` });
  // A pasted token is not deleted at GitHub by the gateway: the owner is told so first.
  await expect(disconnecting).toContainText('The gateway cannot withdraw the access at GitHub');
  await expect(disconnecting).toContainText('This cannot be undone');
  await snap(ines, 'connection-revoke-dialog');
  // The button answers only once the name is typed.
  const disconnect = disconnecting.getByRole('button', { name: 'Disconnect', exact: true });
  await expect(disconnect).toBeDisabled();
  await disconnecting.getByRole('textbox').fill(connectionName);
  await disconnect.click();
  await expect(ines.getByText('Account disconnected', { exact: true })).toBeVisible();
  // What is left to do at the service is said once: by the note of the act…
  const byHand = ines.getByText(/Still granted at GitHub\./);
  await expect(byHand).toHaveCount(1);
  await expect(ines.getByText(/Delete the token at GitHub/)).toHaveCount(1);
  await expect(ines.getByRole('main')).not.toContainText('by hand');
  // …which also says the credential is erased: the page does not say it a second time.
  await expect(ines.getByTestId('account-disconnected')).toHaveCount(0);
  await snap(ines, 'connection-revoked-provider-grant');
  // …and, on every later visit, by the page itself.
  await ines.goto(`/accounts/${connectionId}`);
  await expect(ines.getByText('Account disconnected', { exact: true })).toHaveCount(0);
  await expect(ines.getByTestId('account-disconnected')).toBeVisible();
  await expect(ines.getByTestId('provider-grant')).toContainText(/Delete the token at GitHub/);
  await expect(byHand).toHaveCount(1);
  // A disconnected account takes no owner act any more.
  await expect(ines.getByRole('link', { name: 'Give access', exact: true })).toHaveCount(0);
  await expect(ines.getByRole('link', { name: 'Reconnect' })).toHaveCount(0);
});

test('transfer to a group; the group empties; the operator reassigns the connection', async ({
  browser,
  request,
}) => {
  const connectionName = 'ines-team-org';
  const group = 'ines-team';
  const { connection_id: connectionId } = await seedShareScenario(request, connectionName);

  // ── The administrator keeps a local team ────────────────────────────────
  const ops = await browserOf(browser, request, E2E_OPERATOR, '/admin/groups');
  await expect(ops.getByRole('heading', { name: 'Teams', level: 1 })).toBeVisible();
  await ops.getByRole('button', { name: 'Add a local team' }).click();
  await ops.getByLabel('Name of the new team').fill(group);
  await ops.getByRole('button', { name: 'Create' }).click();
  await expect(ops.getByText(`Team “${group}” created`)).toBeVisible();
  // A local team is open: its members, and the field that adds one.
  const team = ops.locator(`[data-team="${group}"]`);
  await expect(team).toContainText('Nobody is in this team.');
  await team.getByLabel(/^Add someone/).fill(E2E_SHARE_OWNER.email);
  await team.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(ops.getByText(`${E2E_SHARE_OWNER.email} added to “${group}”`)).toBeVisible();
  await snap(ops, 'admin-groups');

  // ── The owner transfers her account to it ───────────────────────────────
  const ines = await browserOf(browser, request, E2E_SHARE_OWNER, `/accounts/${connectionId}`);
  await ines.getByRole('button', { name: 'Transfer ownership' }).click();
  // The transfer is asked first, with what it gives the team.
  const transfer = ines.getByTestId('transfer-dialog');
  await transfer.getByLabel('Team').selectOption({ label: group });
  await expect(transfer).toContainText(`Every member of the ${group} team, now and later`);
  await transfer.getByRole('button', { name: 'Transfer ownership' }).click();
  await expect(ines.getByText(`Transferred to the ${group} team`)).toBeVisible();
  await expect(ines.getByText(`owned by the ${group} team (you)`)).toBeVisible();

  // ── The team loses its only member ──────────────────────────────────────
  await ops.goto('/admin/groups');
  await ops.getByRole('button', { name: `Remove ${E2E_SHARE_OWNER.email} from ${group}` }).click();
  // Asked first: the dialog says what the person loses.
  const removing = ops.getByRole('dialog').filter({ hasText: `from ${group}?` });
  await expect(removing).toContainText('the accounts the team owns have no owner left');
  await removing.getByRole('button', { name: 'Remove from the team' }).click();
  await expect(ops.getByText('1 account has no owner left', { exact: false })).toBeVisible();
  // The team that owns an account and has nobody left is the exception of its row.
  await expect(ops.getByRole('row').filter({ hasText: group }).first()).toContainText(
    'Nobody left',
  );

  // Nobody owns it: it left the former owner's list.
  await ines.goto('/accounts');
  await expect(ines.getByText(connectionName)).toHaveCount(0);

  // ── The administrator names a new owner ─────────────────────────────────
  // Setup says so, and leads there.
  await ops.goto('/admin');
  await ops.getByTestId('setup-ownerless').getByRole('link', { name: 'Name an owner' }).click();
  await expect(ops).toHaveURL(/\/admin\/connections$/);
  await expect(ops.getByRole('heading', { name: 'Accounts without owner' })).toBeVisible();
  const ownerless = ops.getByRole('row').filter({ hasText: connectionName });
  await expect(ownerless).toContainText(`the ${group} team`);
  await expect(ownerless).toContainText('Needs an owner');
  await snap(ops, 'admin-connections-without-owner');
  await ops.getByLabel(/^Email/).fill(E2E_SHARE_OWNER.email);
  await ops.getByRole('button', { name: 'Name an owner' }).click();
  await expect(ops.getByText(`${connectionName} has a new owner`)).toBeVisible();
  await expect(ops.getByText('Every account has an owner.')).toBeVisible();

  await ines.goto(`/accounts/${connectionId}`);
  await expect(ines.getByRole('heading', { name: connectionName, level: 1 })).toBeVisible();
  await expect(ines.getByText('you own it').first()).toBeVisible();
  await expect(ines.getByRole('link', { name: 'Give access', exact: true })).toBeVisible();
});

test('disconnecting one account of a two-account mission takes that account only: the mission keeps running on the other', async ({
  browser,
  request,
}) => {
  const connectionName = 'ines-two-accounts';
  const seeded = await request.post(controlUrl('/partial-loss-scenario'), {
    data: { name: connectionName },
  });
  expect(seeded.ok()).toBe(true);
  const scenario = (await seeded.json()) as {
    connection_id: string;
    mission_id: string;
    mission_name: string;
    token: string;
  };
  const executor = (agent = await connectAgent(scenario.token));
  const tools = await executor.listTools();
  expect(tools.some((name) => name.startsWith('github__'))).toBe(true);
  expect(tools.some((name) => name.startsWith('supabase__'))).toBe(true);

  // ── The owner disconnects the GitHub account ────────────────────────────
  const ines = await browserOf(
    browser,
    request,
    E2E_SHARE_OWNER,
    `/accounts/${scenario.connection_id}`,
  );
  await ines.getByTestId('disconnect-account').click();
  const disconnecting = ines
    .getByRole('dialog')
    .filter({ hasText: `Disconnect ${connectionName}?` });
  await expect(disconnecting).toContainText(
    'one that uses only this account stops, one that uses others keeps running on them',
  );
  await disconnecting.getByRole('textbox').fill(connectionName);
  await disconnecting.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(ines.getByText('Account disconnected', { exact: true })).toBeVisible();
  // The page of the disconnected account says the mission no longer uses it.
  const missions = ines.getByTestId('account-missions');
  await expect(missions).toContainText(scenario.mission_name);
  await expect(missions).toContainText('Lost an account');
  await expect(missions).not.toContainText('Needs an owner');

  // ── The executor: refused on GitHub with the reason, still served elsewhere ──
  const refused = await executor.call('github__get_file_contents', {
    owner: 'acme',
    repo: 'app',
    path: 'README.md',
  });
  if (refused.outcome !== 'refused') throw new Error('a call through a lost account passed');
  expect(refused.refusal).toMatchObject({
    code: 'connection-revoked',
    cause: 'connection-revoked',
    final: true,
  });
  expect(refused.refusal.hint).toContain('other accounts');
  const after = await executor.listTools();
  expect(after.some((name) => name.startsWith('github__'))).toBe(false);
  expect(after.some((name) => name.startsWith('supabase__'))).toBe(true);

  // ── The mission page says which account is gone, and that it never comes back ──
  await ines.goto('/missions');
  await expect(ines.getByRole('row').filter({ hasText: scenario.mission_name })).toContainText(
    'Lost an account',
  );
  await ines.goto(`/missions/${scenario.mission_id}`);
  await expect(ines.getByTestId('orphan-callout')).toHaveCount(0);
  const lost = ines.getByTestId('lost-accounts-callout');
  await expect(lost).toContainText('An account no longer serves this mission');
  await expect(lost).toContainText(`“${connectionName}” was disconnected by its owner`);
  await expect(lost).toContainText('keeps running on its other accounts');
  await expect(ines.getByTestId(`account-lost-${scenario.connection_id}`)).toBeVisible();
  await snap(ines, 'mission-lost-an-account');
});
