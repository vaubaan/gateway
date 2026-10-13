/**
 * "Share, then orphan" in a browser, against an ephemeral instance with a
 * simulated IdP (spec §7.3, §7.8, §4.2 "Connections" / "Shares received" /
 * "Administration", §2.3 "orphaned" / "unowned").
 *
 * Ines owns a GitHub connection. She shares two risks of it with Joan through
 * the Share dialog; Joan finds the share under "Shares received", issues a
 * mission on it — her creation screen offers nothing beyond the restriction —
 * and an MCP client holding that mission's token reads a file through the
 * door. Ines revokes the share: the same client is refused
 * `mission-inactive` (orphaned), and Joan sees why her mission stopped. Ines
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
  await expect(ines.getByText('Not shared.')).toBeVisible();
  await ines.getByRole('link', { name: 'Share', exact: true }).click();
  await expect(ines.getByRole('heading', { name: `Share ${connectionName}` })).toBeVisible();

  // The dialog is a target, a one-line summary, and the checklist with each risk explained.
  const summary = ines.getByTestId('restriction-summary');
  const submit = ines.getByRole('button', { name: 'Share', exact: true });
  await expect(summary).toHaveText('No risk selected: the share would authorize nothing.');
  await expect(submit).toBeDisabled();
  await expect(ines.getByLabel(`Share risk ${READ_CODE}`)).toBeVisible();
  // Label, reason, vector and a link to the entry in the provider reference.
  const readCode = ines.locator('li', { has: ines.getByLabel(`Share risk ${READ_CODE}`) });
  await expect(readCode).toContainText('Read code, branches, commits, files');
  await expect(readCode).toContainText('Reads may leak secrets');
  await expect(readCode.locator('[aria-label="Reversibility: reversible"]')).toBeVisible();
  // The helper text is one line; the rest is on demand.
  await expect(ines.getByText('A risk added to the catalog later is not shared.')).toBeHidden();
  await ines.getByTestId('help-share-risks').getByRole('button', { name: 'More' }).click();
  await expect(ines.getByText('A risk added to the catalog later is not shared.')).toBeVisible();
  await expect(readCode.getByRole('link', { name: READ_CODE })).toHaveAttribute(
    'href',
    `/reference/github#risk-${READ_CODE}`,
  );
  await snap(ines, 'share-dialog');

  await ines.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  // "Select all" ticks the boxes one by one: every risk but the fallback.
  await ines.getByRole('button', { name: 'Select all' }).click();
  await expect(summary).toContainText('14 of 15 risks');
  await expect(ines.getByLabel('Share risk github.uncategorized-write')).not.toBeChecked();
  await expect(ines.getByLabel('Share risk github.merge-protected')).toBeChecked();
  await snap(ines, 'share-dialog-select-all');
  // This share is narrower: two reads.
  await ines.getByRole('button', { name: 'Clear' }).click();
  await ines.getByLabel(`Share risk ${READ_CODE}`).check();
  await ines.getByLabel(`Share risk ${READ_META}`).check();
  await expect(summary).toContainText('2 of 15 risks');
  await submit.click();

  await expect(ines).toHaveURL(new RegExp(`/accounts/${connectionId}\\?notice=`));
  await expect(ines.getByText('Shared', { exact: true })).toBeVisible();
  await expect(
    ines.getByText(`${E2E_SHARE_TARGET.email} may now accept 2 risks of this connection`),
  ).toBeVisible();
  const shareRow = ines.getByRole('row').filter({ hasText: E2E_SHARE_TARGET.email });
  await expect(shareRow).toContainText('2 risks');
  await shareRow.getByText('2 risks').click();
  await expect(shareRow).toContainText(READ_CODE);
  await expect(shareRow).toContainText(READ_META);
  await expect(shareRow).not.toContainText('github.merge-protected');
  await snap(ines, 'connection-shares');

  // ── The beneficiary reads what she received ─────────────────────────────
  const joan = await browserOf(browser, request, E2E_SHARE_TARGET, '/shares');
  await expect(joan.getByRole('heading', { name: 'Shared with you' })).toBeVisible();
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
  await joan.goto('/accounts');
  await expect(joan.getByText(connectionName)).toHaveCount(0);
  const foreign = await joan.goto(`/accounts/${connectionId}/share`);
  expect(foreign?.status()).toBe(404);

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
  await ines.goto(`/accounts/${connectionId}`);
  await ines.getByRole('button', { name: `Revoke the share to ${E2E_SHARE_TARGET.email}` }).click();
  await expect(ines.getByText('Share revoked', { exact: true })).toBeVisible();
  await expect(
    ines.getByText(
      '1 mission that depended on it is now orphaned and refuses every call, until a share covers it again.',
    ),
  ).toBeVisible();
  await expect(ines.getByText('Not shared.')).toBeVisible();

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
  await joan.goto('/shares');
  await expect(joan.getByText('Nobody has shared a connection with you yet.')).toBeVisible();
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
  await ines.getByRole('link', { name: 'Share', exact: true }).click();
  await ines.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  await ines.getByLabel(`Share risk ${READ_CODE}`).check();
  await ines.getByRole('button', { name: 'Share', exact: true }).click();
  // Nothing is shared yet: the dialog names the mission the share would bring back.
  await expect(ines.getByText('This share brings 1 orphaned mission back')).toBeVisible();
  await expect(ines.getByTestId('share-restores')).toContainText('Read ines-org');
  await expect(ines.getByTestId('share-restores')).toContainText(E2E_SHARE_TARGET.email);
  await expect(ines.getByLabel(`Share risk ${READ_CODE}`)).toBeChecked();
  expect(await read()).toMatchObject({ outcome: 'refused' });
  await snap(ines, 'share-dialog-restores');
  await ines.getByRole('button', { name: 'Share and bring this mission back' }).click();
  await expect(ines.getByText('Shared', { exact: true })).toBeVisible();
  await expect(
    ines.getByText(
      '1 orphaned mission is covered again and serves calls from now on, with its session and counters as they were.',
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
  await expect(joan.getByText('mission-orphaned').first()).toBeVisible();
  await expect(joan.getByText('mission-restored').first()).toBeVisible();

  // ── The owner revokes the share again, then closes the orphaned mission ──
  await ines.goto(`/accounts/${connectionId}`);
  await expect(ines.getByTestId('orphaned-missions')).toHaveCount(0);
  await ines.getByRole('button', { name: `Revoke the share to ${E2E_SHARE_TARGET.email}` }).click();
  await expect(ines.getByText('Share revoked', { exact: true })).toBeVisible();
  const orphanedCard = ines.getByTestId('orphaned-missions');
  await expect(orphanedCard).toContainText('Read ines-org');
  await expect(orphanedCard).toContainText(E2E_SHARE_TARGET.email);
  await expect(orphanedCard).toContainText('its creator no longer holds the risks it accepted');
  await snap(ines, 'connection-orphaned-missions');
  await orphanedCard.getByRole('button', { name: 'Close mission Read ines-org' }).click();
  await ines.getByRole('textbox').last().fill('Read ines-org');
  await snap(ines, 'connection-close-orphaned-confirm');
  await ines.getByRole('button', { name: 'Close mission', exact: true }).click();
  await expect(ines.getByTestId('orphaned-missions')).toHaveCount(0);
  // Revoked for good: the client is refused, and sharing again brings nothing back.
  expect(await read()).toMatchObject({ outcome: 'refused' });
  await joan.goto(missionUrl);
  await expect(joan.getByTestId('mission-state')).toHaveText('stopped');
  await ines.getByRole('link', { name: 'Share', exact: true }).click();
  await ines.getByLabel('Email').fill(E2E_SHARE_TARGET.email);
  await ines.getByLabel(`Share risk ${READ_CODE}`).check();
  await ines.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(ines.getByText('Shared', { exact: true })).toBeVisible();
  await expect(ines.getByText('This share brings')).toHaveCount(0);
  expect(await read()).toMatchObject({ outcome: 'refused' });

  // ── Revoking the connection says what becomes of the access at the provider ──
  await ines.goto(`/accounts/${connectionId}`);
  await ines.getByRole('button', { name: 'Revoke', exact: true }).first().click();
  const revokeDialog = ines.getByRole('dialog');
  // A GitHub App installation is not uninstalled by the gateway: the owner is told so first.
  await expect(revokeDialog).toContainText('The gateway cannot withdraw the access at GitHub');
  await snap(ines, 'connection-revoke-dialog');
  await revokeDialog.getByRole('textbox').fill(connectionName);
  await revokeDialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(ines.getByText('revoked', { exact: true }).first()).toBeVisible();
  await expect(ines.locator('body')).toContainText('by hand');
  await snap(ines, 'connection-revoked-provider-grant');
});

test('transfer to a group; the group empties; the operator reassigns the connection', async ({
  browser,
  request,
}) => {
  const connectionName = 'ines-team-org';
  const group = 'ines-team';
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
  const ines = await browserOf(browser, request, E2E_SHARE_OWNER, `/accounts/${connectionId}`);
  await ines.getByLabel('Group to transfer to').selectOption({ label: group });
  await ines.getByRole('button', { name: 'Transfer' }).click();
  await expect(ines.getByText(`Transferred to group ${group}`)).toBeVisible();
  await expect(ines.getByText(`group ${group}`, { exact: true })).toBeVisible();

  // ── The group loses its only member ─────────────────────────────────────
  await ops.goto('/admin/groups');
  await ops.getByRole('button', { name: `Remove ${E2E_SHARE_OWNER.email} from ${group}` }).click();
  await expect(ops.getByText('1 connection has no owner left', { exact: false })).toBeVisible();

  // Nobody owns it: it left the former owner's list.
  await ines.goto('/accounts');
  await expect(ines.getByText(connectionName)).toHaveCount(0);

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

  await ines.goto(`/accounts/${connectionId}`);
  await expect(ines.getByRole('heading', { name: connectionName, level: 1 })).toBeVisible();
  await expect(ines.getByText(E2E_SHARE_OWNER.email, { exact: true }).first()).toBeVisible();
  await expect(ines.getByRole('link', { name: 'Share', exact: true })).toBeVisible();
});
