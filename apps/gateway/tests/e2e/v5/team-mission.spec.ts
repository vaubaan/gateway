/**
 * "Work on a mission as a team" in a browser, against an ephemeral instance
 * with a simulated IdP (spec §7.9 bis, §0 "Mission member" / "Mission token",
 * §4.2 "Missions" / "Mission session" / "Audit", §8).
 *
 * Ines creates a mission and, on its page, adds Joan as a teammate and makes
 * a machine key for the CI. Joan signs in, finds the mission under "Shared
 * with you", reads it — nothing of it is hers to change — and generates her
 * own key, shown once in her browser and never in Ines's. Three MCP clients,
 * one per key, read a file through the door: the catalog tells each whose key
 * it holds, and Ines reads who called on the mission's activity and in the
 * record. Then each way a key stops: Joan replaces hers, Ines removes Joan,
 * Ines revokes the CI's — each refused at the next call with its reason, the
 * others served. Every act that stops something asks first.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { routeToInstance, seedShareScenario, signInAs } from './browser';
import { E2E_SHARE_OWNER, E2E_SHARE_TARGET, localOrigin } from './instance';
import {
  confirmByTyping,
  createMission,
  holderRow,
  missionMenu,
  openCreatedMission,
  permissionRow,
  pickPreset,
  revealedKey,
  savedKey,
  showPermissions,
} from './mission-pages';

const READ_CODE = 'github.read-code';
const MISSION = 'Ship the docs together';
const CONNECTION = 'team-org';
const CI = 'CI runner';
type User = typeof E2E_SHARE_OWNER | typeof E2E_SHARE_TARGET;

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

const agents: Agent[] = [];
const opened: Page[] = [];

test.afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
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

/** The key of the dialog that shows it once, then "I saved the key". */
async function keyOfDialog(page: Page, title: string | RegExp): Promise<string> {
  await expect(page.getByTestId('reveal-dialog')).toContainText(title);
  const key = await revealedKey(page);
  await savedKey(page);
  return key;
}

/** What the door answers `tools/list` with this bearer: 200, or 401 with the reason. */
async function doorSays(token: string): Promise<{ status: number; reason: string | null }> {
  const response = await fetch(`${localOrigin()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = (await response.json()) as { error?: { data?: { reason?: string } } };
  return { status: response.status, reason: body.error?.data?.reason ?? null };
}

/** `GET /mcp/catalog`: whose token it is, on which mission, created by whom. */
async function whoseToken(token: string) {
  const response = await fetch(`${localOrigin()}/mcp/catalog`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    mission: { name: string; creator: string | null };
    token: { kind: string; holder: string };
  };
  return {
    mission: body.mission.name,
    creator: body.mission.creator,
    kind: body.token.kind,
    holder: body.token.holder,
  };
}

const secretOf = (token: string): string => token.slice(token.lastIndexOf('_') + 1);

const personRow = (page: Page, email: string) => holderRow(page, `member:${email}`);
const machineRow = (page: Page, name: string) => holderRow(page, `machine:${name}`);

test('a creator adds a teammate and a machine key; each holder is attributed; each key stops on its own', async ({
  browser,
  request,
}) => {
  await seedShareScenario(request, CONNECTION);

  // ── Ines creates the mission ────────────────────────────────────────────
  const ines = await browserOf(browser, request, E2E_SHARE_OWNER, '/missions/new');
  await ines.getByLabel('Mission name').fill(MISSION);
  await ines.getByLabel(`Include GitHub ${CONNECTION}`).check();
  // Custom starts from an empty list, in the editor.
  await pickPreset(ines, `GitHub ${CONNECTION}`, 'Custom');
  await ines.getByLabel(`Allow ${READ_CODE}`).check();
  const inesToken = await createMission(ines);
  // Right after creating, the page says how to work with others.
  await expect(ines.getByTestId('created')).toContainText('Add a teammate');
  await expect(ines.getByTestId('created')).toContainText('Add a machine key');
  await openCreatedMission(ines, MISSION);
  await expect(ines).toHaveURL(/\/missions\/[^/#]+$/);
  const missionUrl = ines.url();

  // ── …and makes it a team: a teammate, and a machine key for the CI ──────
  const team = ines.getByTestId('team-section');
  await expect(team.getByRole('heading', { name: /People and keys/ })).toBeVisible();
  await expect(personRow(ines, E2E_SHARE_OWNER.email)).toContainText('you · creator');
  await ines.getByRole('button', { name: 'Add people' }).click();
  const addPeople = ines.getByTestId('add-people-dialog');
  await expect(addPeople).toContainText('a key of their own that you never see');
  await addPeople.getByTestId('member-candidate').selectOption(E2E_SHARE_TARGET.email);
  await addPeople.getByRole('button', { name: 'Add to the mission' }).click();
  const joanRow = personRow(ines, E2E_SHARE_TARGET.email);
  await expect(joanRow).toContainText('no key yet');
  // Once on the mission she is no longer offered.
  await ines.getByRole('button', { name: 'Add people' }).click();
  await expect(
    addPeople.getByTestId('member-candidate').getByRole('option', { name: E2E_SHARE_TARGET.email }),
  ).toHaveCount(0);
  await addPeople.getByRole('button', { name: 'Cancel' }).click();

  await missionMenu(ines, 'New machine key');
  const machineKey = ines.getByTestId('machine-key-dialog');
  await expect(machineKey).toContainText('has no account');
  await machineKey.getByTestId('named-token-name').fill(CI);
  await machineKey.getByRole('button', { name: 'Create the key' }).click();
  const ciToken = await keyOfDialog(ines, `Machine key “${CI}” for “${MISSION}”`);
  await expect(machineRow(ines, CI)).toContainText('machine key');
  await expect(team.getByRole('heading', { name: /People and keys/ })).toContainText('3');
  await snap(ines, 'team-creator');

  // ── Joan finds it shared with her, reads it, and generates her own key ──
  const joan = await browserOf(browser, request, E2E_SHARE_TARGET, '/missions');
  const shared = joan.getByTestId('missions-shared');
  const sharedRow = shared.getByRole('row').filter({ hasText: MISSION });
  await expect(sharedRow).toContainText(E2E_SHARE_OWNER.email);
  await joan.getByRole('button', { name: 'Show details' }).click();
  await expect(sharedRow).toContainText('no key yet');
  await expect(joan.getByTestId('missions-created').getByText(MISSION)).toHaveCount(0);
  await snap(joan, 'missions-shared-with-you');
  await sharedRow.getByRole('link', { name: MISSION }).click();

  await expect(joan.getByTestId('shared-with-me')).toContainText(E2E_SHARE_OWNER.email);
  await expect(joan.getByTestId('shared-with-me')).toContainText('with your own key');
  // She sees what she may do and nothing that would be refused: none of the creator's acts.
  await expect(joan.getByRole('button', { name: 'Add people' })).toHaveCount(0);
  await joan.getByTestId('mission-menu').click();
  for (const name of ['Stop the mission', 'New machine key', 'Duplicate', 'Replace my key']) {
    await expect(joan.getByRole('menuitem', { name })).toHaveCount(0);
  }
  await expect(joan.getByRole('menuitem', { name: 'Generate my key' })).toBeVisible();
  await joan.keyboard.press('Escape');
  await expect(joan.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(joan.getByRole('button', { name: /^Revoke the / })).toHaveCount(0);
  await expect(joan.getByRole('button', { name: /^Replace the machine key/ })).toHaveCount(0);
  // She reads the permissions, and changes none: no "ask me first" switch for her.
  const hersPermissions = await showPermissions(joan);
  await expect(permissionRow(hersPermissions, READ_CODE)).toBeVisible();
  await expect(joan.getByRole('switch')).toHaveCount(0);
  // The summary says whose answer a gated action would wait for.
  await expect(joan.getByTestId('mission-permissions')).not.toContainText(
    'You choose what asks you first',
  );
  await expect(machineRow(joan, CI)).toBeVisible();
  await expect(personRow(joan, E2E_SHARE_TARGET.email)).toContainText('no key yet');

  // Her one act is the page's primary action.
  await joan.getByRole('button', { name: 'Generate my key' }).first().click();
  const joanToken = await keyOfDialog(joan, `Your key for “${MISSION}”`);
  await expect(joan.getByRole('button', { name: 'Generate my key' })).toHaveCount(0);
  await joan.getByTestId('team-section').getByRole('button', { name: 'Show details' }).click();
  await expect(personRow(joan, E2E_SHARE_TARGET.email)).toContainText(
    `vbn_live_${joanToken.slice(9, 17)}_…`,
  );
  // The kit is hers, with her key masked.
  await joan.getByRole('button', { name: 'Setup kit' }).click();
  await expect(joan.getByTestId('kit-dialog').getByTestId('kit-env')).toContainText(
    `vbn_live_${joanToken.slice(9, 17)}_…`,
  );
  await joan.getByTestId('kit-dialog').getByRole('button', { name: 'Close' }).click();
  expect(await joan.content()).not.toContain(secretOf(joanToken));
  await snap(joan, 'team-teammate');
  // The creator's mutations are refused to her by the server too, not only hidden.
  const forged = await joan.evaluate(
    async (url) => {
      const post = (path: string, body?: unknown) =>
        fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }).then((r) => r.status);
      return [
        await post('/revoke'),
        await post('/gate', { risk_id: 'github.read-code', gate: 'approval' }),
        await post('/tokens', { name: 'Mine' }),
        await post('/members', { email: 'ops@example.com' }),
      ];
    },
    missionUrl.replace('/missions/', '/api/missions/'),
  );
  expect(forged).toEqual([404, 404, 404, 404]);

  // ── Three holders, one mission: each call is attributed ─────────────────
  expect(await whoseToken(joanToken)).toEqual({
    mission: MISSION,
    creator: E2E_SHARE_OWNER.email,
    kind: 'member',
    holder: E2E_SHARE_TARGET.email,
  });
  expect(await whoseToken(ciToken)).toMatchObject({ kind: 'named', holder: CI });
  expect(await whoseToken(inesToken)).toMatchObject({
    kind: 'member',
    holder: E2E_SHARE_OWNER.email,
  });
  const read = { owner: 'acme', repo: 'app', path: 'README.md' };
  for (const [token, label, times] of [
    [inesToken, 'ines-laptop', 1],
    [joanToken, 'joan-laptop', 2],
    [ciToken, 'pipeline', 1],
  ] as const) {
    const agent = await connectAgent(token, label);
    agents.push(agent);
    for (let i = 0; i < times; i += 1) {
      expect(await agent.call('github__get_file_contents', read)).toMatchObject({
        outcome: 'allowed',
      });
    }
  }

  // ── Ines reads who called: the mission page, its activity, the record ───
  await ines.reload();
  const joanKeyRow = personRow(ines, E2E_SHARE_TARGET.email);
  await expect(joanKeyRow).not.toContainText('no key yet');
  await expect(joanKeyRow).toContainText('2 calls today');
  await expect(machineRow(ines, CI)).toContainText('1 call today');
  await expect(ines.getByTestId('mission-activity')).toContainText('4 calls today');
  // Her screen never held Joan's secret: not now, and not in what the page was sent.
  expect(await ines.content()).not.toContain(secretOf(joanToken));
  await snap(ines, 'team-creator-after-calls');

  await ines.getByRole('link', { name: 'Everything this mission did' }).click();
  await expect(
    ines.getByRole('heading', { name: `Activity of ${MISSION}`, level: 1 }),
  ).toBeVisible();
  const perHolder = ines.getByTestId('holder-activity');
  await expect(perHolder).toContainText('Counts, not limits');
  const counted = (holder: string) =>
    perHolder.getByRole('row').filter({ hasText: holder }).locator('td');
  await expect(counted(E2E_SHARE_TARGET.email).nth(1)).toHaveText('2');
  await expect(counted(E2E_SHARE_TARGET.email).nth(2)).toHaveText('0');
  await expect(counted(E2E_SHARE_OWNER.email).nth(1)).toHaveText('1');
  await expect(counted(CI).first()).toContainText('machine key');
  // One set of limits: four reads were counted on the one permission, whoever made them.
  await ines
    .getByTestId('session-permissions')
    .getByRole('button', { name: /^All \d+ permissions?/ })
    .click();
  await expect(permissionRow(ines.getByTestId('session-permissions'), READ_CODE)).toContainText(
    /^.*4 \/ \d/s,
  );
  // The timeline names the holder and, separately, the label each caller declared.
  const timeline = ines.getByTestId('timeline-table');
  await expect(timeline.getByRole('row').filter({ hasText: 'joan-laptop' }).first()).toContainText(
    E2E_SHARE_TARGET.email,
  );
  await snap(ines, 'activity-per-holder');
  await perHolder
    .getByRole('row')
    .filter({ hasText: E2E_SHARE_TARGET.email })
    .getByRole('link', { name: 'in the timeline' })
    .click();
  await expect(ines.getByTestId('timeline-filter')).toContainText(E2E_SHARE_TARGET.email);
  await expect(timeline.getByTestId('event-holder')).toHaveCount(2);
  await expect(timeline.getByTestId('event-holder')).toContainText([
    E2E_SHARE_TARGET.email,
    E2E_SHARE_TARGET.email,
  ]);

  await ines.goto('/activity');
  // Her audit also holds other missions on her connections: this one only.
  await ines.locator('select[name="mission"]').selectOption({ label: MISSION });
  await ines.getByLabel('Token holder').fill(CI);
  await ines.getByRole('button', { name: 'Search' }).click();
  const audit = ines.getByTestId('audit-table');
  await expect(audit.getByTestId('audit-holder')).toHaveText([/CI runner\s*named token/]);
  await ines.getByLabel('Token holder').fill(E2E_SHARE_TARGET.email);
  await ines.getByRole('button', { name: 'Search' }).click();
  await expect(audit.getByTestId('audit-holder')).toHaveText([
    E2E_SHARE_TARGET.email,
    E2E_SHARE_TARGET.email,
  ]);
  await snap(ines, 'audit-by-holder');

  // ── Joan reads the activity too; the answers stay the creator's ─────────
  await joan.getByRole('link', { name: 'Everything this mission did' }).click();
  await expect(joan.getByTestId('holder-activity')).toContainText(E2E_SHARE_OWNER.email);
  // A member reads the audit of a mission shared with them (spec §4.2): every call of
  // it, whoever made it, and never the fingerprint of the arguments.
  await joan.getByRole('link', { name: 'Full record of this mission' }).click();
  await expect(joan.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  const memberAudit = joan.getByTestId('audit-table');
  await expect(memberAudit.getByTestId('audit-holder').first()).toBeVisible();
  await expect(memberAudit).toContainText(CI);
  await expect(memberAudit).toContainText('fingerprint not shown');
  expect(await joan.content()).not.toMatch(/\b[0-9a-f]{64}\b/);
  await snap(joan, 'audit-member');
  await joan.goBack();
  await expect(joan.getByTestId('holder-activity')).toBeVisible();
  await joan.goBack();

  // ── Each key stops on its own ───────────────────────────────────────────
  // Joan replaces hers: she is asked first, then the old one is refused, with the
  // reason; the others are served.
  await missionMenu(joan, 'Replace my key');
  const replace = joan.getByTestId('replace-key-dialog').filter({ hasText: 'Replace your key?' });
  await expect(replace).toContainText('Your current key stops working at once');
  await expect(replace).toContainText('The 2 other keys keep working.');
  await replace.getByRole('button', { name: 'Replace key' }).click();
  const joanSecond = await keyOfDialog(joan, `Your new key for “${MISSION}”`);
  expect(joanSecond).not.toBe(joanToken);
  expect(await doorSays(joanToken)).toEqual({ status: 401, reason: 'token-rotated' });
  for (const token of [joanSecond, ciToken, inesToken]) {
    expect(await doorSays(token)).toEqual({ status: 200, reason: null });
  }

  // Ines removes Joan: she types the address; Joan's key is refused at once, and the
  // mission is gone for her.
  await ines.goto(missionUrl);
  await ines.getByRole('button', { name: `Remove ${E2E_SHARE_TARGET.email}` }).click();
  await expect(ines.getByRole('dialog')).toContainText('Their key stops working at once');
  await confirmByTyping(ines, E2E_SHARE_TARGET.email, 'Remove from the mission');
  await expect(personRow(ines, E2E_SHARE_TARGET.email)).toHaveCount(0);
  expect(await doorSays(joanSecond)).toEqual({ status: 401, reason: 'holder-removed' });
  expect(await doorSays(ciToken)).toEqual({ status: 200, reason: null });
  const gone = await joan.goto(missionUrl);
  expect(gone?.status()).toBe(404);
  await joan.goto('/missions');
  await expect(joan.getByTestId('missions-shared')).toContainText('No mission is shared with you.');

  // Ines replaces the CI's key: the consequence is stated, the old key stops, the new one works.
  await ines.getByRole('button', { name: `Replace the machine key ${CI}` }).click();
  const replaceMachine = ines
    .getByTestId('replace-key-dialog')
    .filter({ hasText: `Replace the machine key ${CI}?` });
  await expect(replaceMachine).toContainText('The current key stops working at once');
  await replaceMachine.getByRole('button', { name: 'Replace key' }).click();
  const ciSecond = await keyOfDialog(ines, `Machine key “${CI}” for “${MISSION}”`);
  expect(await doorSays(ciToken)).toEqual({ status: 401, reason: 'token-revoked' });
  expect(await doorSays(ciSecond)).toEqual({ status: 200, reason: null });

  // …then revokes it: she types its name; refused with its own reason; hers still works.
  await ines.getByRole('button', { name: `Revoke the machine key ${CI}` }).click();
  await confirmByTyping(ines, CI, 'Revoke the key');
  await expect(machineRow(ines, CI)).toHaveCount(0);
  expect(await doorSays(ciSecond)).toEqual({ status: 401, reason: 'token-revoked' });
  expect(await doorSays(inesToken)).toEqual({ status: 200, reason: null });
  await snap(ines, 'team-creator-after-removal');
});
