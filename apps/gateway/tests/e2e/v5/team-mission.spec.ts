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
  addAccount,
  allowOnly,
  confirmByTyping,
  createMission,
  holderRow,
  missionMenu,
  openCreatedMission,
  permissionRow,
  revealedKey,
  savedKey,
  trustLevelChoice,
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
  await addAccount(ines, `GitHub · ${CONNECTION}`);
  // Custom: the permissions of Read one by one, only one of them allowed.
  await allowOnly(ines, `GitHub · ${CONNECTION}`, 'Read', [READ_CODE]);
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

  // ── The acts of a row do not depend on hovering ─────────────────────────
  // With a pointer they are drawn when the row is pointed at — and when the keyboard
  // reaches them: each is a real button, in the tab order, named after its act and its key.
  const revokeMachine = machineRow(ines, CI).getByRole('button', {
    name: `Revoke the machine key ${CI}`,
  });
  const drawn = (button: typeof revokeMachine) =>
    button.evaluate((el) => Number(getComputedStyle(el.parentElement ?? el).opacity));
  await ines.mouse.move(0, 0);
  expect(await drawn(revokeMachine)).toBe(0);
  await revokeMachine.focus();
  await expect(revokeMachine).toBeFocused();
  expect(await drawn(revokeMachine)).toBe(1);
  await ines.keyboard.press('Shift+Tab');
  await expect(
    machineRow(ines, CI).getByRole('button', { name: `Replace the machine key ${CI}` }),
  ).toBeFocused();

  // On a phone there is nothing to hover with: every act of every row is drawn, the table
  // is rows of labelled lines instead of a grid cut word by word, and nothing scrolls sideways.
  await ines.setViewportSize({ width: 390, height: 780 });
  await ines.mouse.move(0, 0);
  for (const button of [
    revokeMachine,
    personRow(ines, E2E_SHARE_TARGET.email).getByRole('button', {
      name: `Remove ${E2E_SHARE_TARGET.email}`,
    }),
    personRow(ines, E2E_SHARE_OWNER.email).getByRole('button', { name: 'Replace my key' }),
  ]) {
    await expect(button).toBeVisible();
    expect(await drawn(button)).toBe(1);
    const box = await button.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  // A cell is as wide as the page allows, not a 60 px column: the sentence of a row
  // ("no key yet", "2 calls today · last call …") reads on one or two lines.
  const callsCell = personRow(ines, E2E_SHARE_TARGET.email).locator('td[data-column="calls"]');
  expect((await callsCell.boundingBox())?.width).toBeGreaterThan(300);
  expect(await ines.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // A dialog is never taller than the screen: its buttons stay in view.
  await ines.getByRole('button', { name: 'Setup kit' }).click();
  const kit = ines.getByRole('dialog');
  await expect(kit).toBeVisible();
  const kitBox = await kit.boundingBox();
  expect(kitBox?.y).toBeGreaterThanOrEqual(0);
  expect((kitBox?.y ?? 0) + (kitBox?.height ?? 0)).toBeLessThanOrEqual(780);
  await expect(kit.getByRole('button', { name: 'Close' })).toBeInViewport();
  await snap(ines, 'team-creator-phone-kit');
  await kit.getByRole('button', { name: 'Close' }).click();
  await snap(ines, 'team-creator-phone');
  // …and neither is it at the size of a small laptop.
  await ines.setViewportSize({ width: 1280, height: 800 });
  await ines.getByRole('button', { name: 'Setup kit' }).click();
  const kitWide = await ines.getByRole('dialog').boundingBox();
  expect(kitWide?.y).toBeGreaterThanOrEqual(0);
  expect((kitWide?.y ?? 0) + (kitWide?.height ?? 0)).toBeLessThanOrEqual(800 - 16);
  await ines.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

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
  // She reads the cards, frozen, and changes none: no "Edit mission" for her.
  await expect(joan.getByLabel(`Read on GitHub · ${CONNECTION}`)).toBeChecked();
  await expect(joan.getByLabel(`Read on GitHub · ${CONNECTION}`)).toBeDisabled();
  await expect(trustLevelChoice(joan, `GitHub · ${CONNECTION}`, 'Read', 'Custom')).toBeDisabled();
  await expect(joan.getByTestId('edit-mission')).toHaveCount(0);
  await expect(joan.getByRole('switch')).toHaveCount(0);
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
  await expect(ines).toHaveURL(/\/activity\/timeline\?mission=/);
  // The timeline names the holder and, separately, the label each caller declared.
  const timeline = ines.getByTestId('timeline-table');
  await expect(timeline.getByRole('row').filter({ hasText: 'joan-laptop' }).first()).toContainText(
    E2E_SHARE_TARGET.email,
  );
  await ines.getByRole('link', { name: 'what waits, who called and what was used' }).click();
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
  await snap(ines, 'activity-per-holder');
  await perHolder
    .getByRole('row')
    .filter({ hasText: E2E_SHARE_TARGET.email })
    .getByRole('link', { name: 'in the timeline' })
    .click();
  // The Timeline of the mission, filtered on the holder's key.
  await expect(ines).toHaveURL(/\/activity\/timeline\?mission=[^&]+&holder=member%3A/);
  await expect(timeline.getByTestId('event-holder')).toHaveCount(2);
  await expect(timeline.getByTestId('event-holder')).toContainText([
    E2E_SHARE_TARGET.email,
    E2E_SHARE_TARGET.email,
  ]);
  // One form for a date, whatever the browser's locale (en-US here): "14 Oct, 01:48:59",
  // never "10/14/2026, 1:48:59 AM".
  const times = await ines.locator('main time').allInnerTexts();
  expect(times.length).toBeGreaterThan(0);
  for (const text of times) {
    expect(text).toMatch(/^\d{1,2} [A-Z][a-z]{2}(?: \d{4})?(?:, \d\d:\d\d(?::\d\d)?)?$/);
  }
  expect(await ines.getByRole('main').innerText()).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|\b[AP]M\b/);

  await ines.goto('/activity');
  // Her audit also holds other missions on her connections: this one only, at once
  // (once the filters are live: before, the form waits for its button).
  await expect(ines.locator('form[data-live="true"]')).toHaveCount(1);
  await ines.locator('select[name="mission"]').selectOption({ label: MISSION });
  await expect(ines).toHaveURL(/\/activity\/record\?mission=/);
  await ines.getByRole('button', { name: 'More filters' }).click();
  await ines.getByLabel(/^Who/).fill(CI);
  await ines.getByLabel(/^Who/).press('Enter');
  await expect(ines).toHaveURL(/[?&]holder=CI/);
  const audit = ines.getByTestId('audit-table');
  // A machine key is said in words, and drawn as a dashed square, not as a person.
  await expect(audit.getByTestId('audit-holder')).toHaveText([/CI runner\s*·\s*machine key/]);
  await ines.getByLabel(/^Who/).fill(E2E_SHARE_TARGET.email);
  await ines.getByLabel(/^Who/).press('Enter');
  await expect(audit.getByTestId('audit-holder')).toHaveText([
    new RegExp(E2E_SHARE_TARGET.email.replace('.', '\\.')),
    new RegExp(E2E_SHARE_TARGET.email.replace('.', '\\.')),
  ]);
  await snap(ines, 'audit-by-holder');

  // ── Joan reads the activity too; the answers stay the creator's ─────────
  await joan.getByRole('link', { name: 'Everything this mission did' }).click();
  await expect(joan.getByTestId('timeline-table')).toContainText(E2E_SHARE_OWNER.email);
  // A member reads the audit of a mission shared with them (spec §4.2): every call of
  // it, whoever made it, and never the fingerprint of the arguments.
  await joan.getByRole('link', { name: 'its record' }).click();
  await expect(joan.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  const memberAudit = joan.getByTestId('audit-table');
  await expect(memberAudit.getByTestId('audit-holder').first()).toBeVisible();
  await expect(memberAudit).toContainText(CI);
  // The detail of a call says its arguments were never stored, and that their fingerprint
  // is not hers to read.
  await memberAudit
    .locator('tbody tr[data-row]')
    .filter({ has: joan.getByTestId('audit-holder') })
    .first()
    .getByTestId('entry-detail-link')
    .click();
  await expect(joan.getByTestId('arguments-hash-hidden')).toContainText(
    'shown to the creator of the mission and to the owners of the account only',
  );
  await expect(joan.getByTestId('arguments-hash')).toHaveCount(0);
  expect(await joan.content()).not.toMatch(/\b[0-9a-f]{64}\b/);
  await snap(joan, 'audit-member');
  // Opening the detail was a navigation of its own.
  await joan.goBack();
  await joan.goBack();
  await expect(joan.getByTestId('timeline-table')).toBeVisible();
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
  // Nothing is shared with her any more (whether the page then shows its empty "Shared
  // with you" region or its one empty state depends on what else she created).
  await expect(joan.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible();
  await expect(joan.getByRole('main')).not.toContainText(MISSION);

  // Ines replaces the CI's key: the consequence is stated, the old key stops, the new one works.
  await ines.getByRole('button', { name: `Replace the machine key ${CI}` }).click();
  const replaceMachine = ines
    .getByTestId('replace-key-dialog')
    .filter({ hasText: `Replace the machine key ${CI}?` });
  await expect(replaceMachine).toContainText('The current key stops working at once');
  await replaceMachine.getByRole('button', { name: 'Replace key' }).click();
  const ciSecond = await keyOfDialog(ines, `Machine key “${CI}” for “${MISSION}”`);
  // One act on the server: the old key was replaced, not revoked then made again.
  expect(await doorSays(ciToken)).toEqual({ status: 401, reason: 'token-rotated' });
  expect(await doorSays(ciSecond)).toEqual({ status: 200, reason: null });

  // …then revokes it: she types its name; refused with its own reason; hers still works.
  await ines.getByRole('button', { name: `Revoke the machine key ${CI}` }).click();
  await confirmByTyping(ines, CI, 'Revoke the key');
  await expect(machineRow(ines, CI)).toHaveCount(0);
  expect(await doorSays(ciSecond)).toEqual({ status: 401, reason: 'token-revoked' });
  expect(await doorSays(inesToken)).toEqual({ status: 200, reason: null });
  await snap(ines, 'team-creator-after-removal');

  // ── A teammate leaves by themselves ─────────────────────────────────────
  // Ines adds Joan again; Joan generates a key, then leaves: she types the mission's
  // name, her key is refused at once, and the mission is gone for her.
  await ines.getByRole('button', { name: 'Add people' }).click();
  await ines
    .getByTestId('add-people-dialog')
    .getByTestId('member-candidate')
    .selectOption(E2E_SHARE_TARGET.email);
  await ines
    .getByTestId('add-people-dialog')
    .getByRole('button', { name: 'Add to the mission' })
    .click();
  await expect(personRow(ines, E2E_SHARE_TARGET.email)).toContainText('no key yet');
  await joan.goto(missionUrl);
  await joan.getByRole('button', { name: 'Generate my key' }).first().click();
  const joanThird = await keyOfDialog(joan, `Your key for “${MISSION}”`);
  expect(await doorSays(joanThird)).toEqual({ status: 200, reason: null });
  // The creator is not offered to leave: she stops the mission instead.
  await ines.getByTestId('mission-menu').click();
  await expect(ines.getByRole('menuitem', { name: 'Leave the mission' })).toHaveCount(0);
  await ines.keyboard.press('Escape');
  await missionMenu(joan, 'Leave the mission');
  await expect(joan.getByRole('dialog')).toContainText('Your key stops working at once');
  await snap(joan, 'team-teammate-leave');
  await confirmByTyping(joan, MISSION, 'Leave the mission');
  await expect(joan).toHaveURL(/\/missions$/);
  expect(await doorSays(joanThird)).toEqual({ status: 401, reason: 'holder-removed' });
  expect(await doorSays(inesToken)).toEqual({ status: 200, reason: null });
  expect((await joan.goto(missionUrl))?.status()).toBe(404);
  await ines.goto(missionUrl);
  await expect(personRow(ines, E2E_SHARE_TARGET.email)).toHaveCount(0);
});
