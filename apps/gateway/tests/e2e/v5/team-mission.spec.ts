/**
 * "Work on a mission as a team" in a browser, against an ephemeral instance
 * with a simulated IdP (spec §7.9 bis, §0 "Mission member" / "Mission token",
 * §4.2 "Missions" / "Mission session" / "Audit", §8).
 *
 * Ines issues a mission and, on its page, adds Joan as a member and creates a
 * named token for the CI. Joan signs in, finds the mission under "Shared with
 * me", reads it — nothing of it is hers to change — and generates her own
 * token, shown once in her browser and never in Ines's. Three MCP clients, one
 * per token, read a file through the door: the catalog tells each whose token
 * it holds, and Ines reads who called in the session and in the audit. Then
 * each way a token stops: Joan rotates hers, Ines removes Joan, Ines revokes
 * the CI's — each refused at the next call with its reason, the others served.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { connectAgent, type Agent } from './agent';
import { routeToInstance, seedShareScenario, signInAs } from './browser';
import { E2E_SHARE_OWNER, E2E_SHARE_TARGET, localOrigin } from './instance';

const TOKEN = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;
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

/** The token of the reveal-once dialog, then "I copied the token". */
async function tokenOfDialog(page: Page, title: string | RegExp): Promise<string> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(title);
  const token = TOKEN.exec(await dialog.getByTestId('kit-env').innerText())?.[0];
  if (!token) throw new Error('no token in the bootstrap kit');
  await dialog.getByRole('button', { name: 'I copied the token' }).click();
  await expect(dialog).toBeHidden();
  return token;
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

/** The row of one holder in "Tokens that work now" (a named token's row also names who created it). */
const tokenRow = (page: Page, holder: string) =>
  page.getByTestId('team-tokens').locator(`tr[data-holder="${holder}"]`);

/** The row of one person in "Members". */
const memberRow = (page: Page, email: string) =>
  page.getByTestId('team-members').locator(`tr[data-member="${email}"]`);

test('a creator adds a member and a named token; each holder is attributed; each token stops on its own', async ({
  browser,
  request,
}) => {
  await seedShareScenario(request, CONNECTION);

  // ── Ines issues the mission ─────────────────────────────────────────────
  const ines = await browserOf(browser, request, E2E_SHARE_OWNER, '/missions/new');
  await ines.getByLabel('Mission name').fill(MISSION);
  await ines.getByLabel(`Include GitHub ${CONNECTION}`).check();
  await ines
    .getByRole('group', { name: new RegExp(`^Policy for GitHub ${CONNECTION}`) })
    .getByRole('radio', { name: 'Custom' })
    .check();
  await ines.getByLabel(`Accept risk ${READ_CODE}`).check();
  await ines.getByRole('button', { name: 'Issue mission' }).click();
  const inesToken = await tokenOfDialog(ines, `Mission “${MISSION}” issued`);
  await expect(ines).toHaveURL(/\/missions\/[^/]+$/);
  const missionUrl = ines.url();

  // ── …and makes it a team: a member, and a named token for the CI ────────
  const team = ines.getByTestId('team-section');
  await expect(team.getByRole('heading', { name: 'Members and tokens' })).toBeVisible();
  await expect(memberRow(ines, E2E_SHARE_OWNER.email)).toContainText('creator');
  await team.getByTestId('member-candidate').selectOption(E2E_SHARE_TARGET.email);
  await team.getByRole('button', { name: 'Add member' }).click();
  const joanRow = memberRow(ines, E2E_SHARE_TARGET.email);
  await expect(joanRow).toContainText('member');
  await expect(joanRow).toContainText('not generated yet');
  // Once on the mission she is no longer offered.
  await expect(
    team.getByTestId('member-candidate').getByRole('option', { name: E2E_SHARE_TARGET.email }),
  ).toHaveCount(0);

  await team.getByTestId('named-token-name').fill(CI);
  await team.getByRole('button', { name: 'Create named token' }).click();
  const ciToken = await tokenOfDialog(ines, `Token “${CI}” for “${MISSION}”`);
  await expect(tokenRow(ines, CI)).toContainText('named token');
  await expect(tokenRow(ines, E2E_SHARE_OWNER.email)).toContainText('you');
  await snap(ines, 'team-creator');

  // ── Joan finds it shared with her, reads it, and generates her own token ─
  const joan = await browserOf(browser, request, E2E_SHARE_TARGET, '/missions');
  const shared = joan.getByTestId('missions-shared');
  const sharedRow = shared.getByRole('row').filter({ hasText: MISSION });
  await expect(sharedRow).toContainText(E2E_SHARE_OWNER.email);
  await expect(sharedRow).toContainText('not generated yet');
  await expect(joan.getByTestId('missions-created').getByText(MISSION)).toHaveCount(0);
  await snap(joan, 'missions-shared-with-me');
  await sharedRow.getByRole('link', { name: MISSION }).click();

  await expect(joan.getByTestId('shared-with-me')).toContainText(E2E_SHARE_OWNER.email);
  await expect(joan.getByTestId('shared-with-me')).toContainText('You cannot change it');
  // Read-only: none of the creator's controls.
  for (const name of ['Revoke mission', 'Rotate token', 'Add member', 'Create named token']) {
    await expect(joan.getByRole('button', { name })).toHaveCount(0);
  }
  await expect(joan.getByRole('link', { name: 'Duplicate' })).toHaveCount(0);
  await expect(joan.getByRole('button', { name: /^(Require approval|Set to auto)/ })).toHaveCount(
    0,
  );
  await expect(joan.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(joan.getByRole('button', { name: /^Revoke the token of / })).toHaveCount(0);
  // She reads the policy and the team.
  await expect(joan.getByTestId(`policy-${READ_CODE}`)).toBeVisible();
  const hers = joan.getByTestId('team-section');
  await expect(tokenRow(joan, CI)).toBeVisible();
  await expect(hers.getByTestId('my-token')).toContainText('you have none yet');
  await expect(hers.getByTestId('my-token')).toContainText(
    'the creator of the mission never sees it',
  );

  await hers.getByRole('button', { name: 'Generate my token' }).click();
  const joanToken = await tokenOfDialog(joan, `Your token for “${MISSION}”`);
  await expect(hers.getByRole('button', { name: 'Rotate my token' })).toBeVisible();
  await expect(hers.getByTestId('my-token')).toContainText(`vbn_live_${joanToken.slice(9, 17)}_…`);
  // The kit below is hers, with her token masked.
  await expect(joan.getByTestId('kit-env')).toContainText(`vbn_live_${joanToken.slice(9, 17)}_…`);
  expect(await joan.content()).not.toContain(secretOf(joanToken));
  await snap(joan, 'team-member');
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

  // ── Ines reads who called: the mission page, the session, the audit ─────
  await ines.reload();
  await expect(memberRow(ines, E2E_SHARE_TARGET.email)).toContainText('generated');
  const joanTokenRow = tokenRow(ines, E2E_SHARE_TARGET.email);
  await expect(joanTokenRow).toContainText('member token');
  await expect(joanTokenRow).not.toContainText('never');
  // Her screen never held Joan's secret: not now, and not in what the page was sent.
  expect(await ines.content()).not.toContain(secretOf(joanToken));
  await snap(ines, 'team-creator-after-calls');

  await ines.getByRole('link', { name: 'Session', exact: true }).click();
  const perHolder = ines.getByTestId('holder-activity');
  await expect(perHolder).toContainText('this is not a budget');
  const cells = async (holder: string) =>
    (
      await perHolder.locator(`tr[data-holder="${holder}"]`).getByRole('cell').allInnerTexts()
    ).slice(0, 3);
  expect(await cells(E2E_SHARE_TARGET.email)).toEqual([E2E_SHARE_TARGET.email, '2', '0']);
  expect(await cells(E2E_SHARE_OWNER.email)).toEqual([E2E_SHARE_OWNER.email, '1', '0']);
  expect((await cells(CI))[0]).toContain(CI);
  expect((await cells(CI))[0]).toContain('named token');
  // One budget: four reads were counted on the one risk, whoever made them.
  await expect(ines.getByRole('row').filter({ hasText: READ_CODE }).first()).toContainText('4');
  // The timeline names the holder and, separately, the label each caller declared.
  const timeline = ines.getByTestId('timeline-table');
  await expect(timeline.getByRole('row').filter({ hasText: 'joan-laptop' }).first()).toContainText(
    E2E_SHARE_TARGET.email,
  );
  await snap(ines, 'session-per-holder');
  await perHolder
    .locator(`tr[data-holder="${E2E_SHARE_TARGET.email}"]`)
    .getByRole('link', { name: 'in the timeline' })
    .click();
  await expect(ines.getByTestId('timeline-filter')).toContainText(E2E_SHARE_TARGET.email);
  await expect(timeline.getByTestId('event-holder')).toHaveText([
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

  // ── Joan reads the session too; the requests stay the creator's ─────────
  await joan.getByRole('link', { name: 'Session', exact: true }).click();
  await expect(joan.getByTestId('holder-activity')).toContainText(E2E_SHARE_OWNER.email);
  // A member reads the audit of a mission shared with them (spec §4.2): every call of
  // it, whoever made it, and never the fingerprint of the arguments.
  await joan.getByRole('link', { name: 'Audit of this mission' }).click();
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

  // ── Each token stops on its own ─────────────────────────────────────────
  // Joan rotates hers: the old one is refused, with the reason; the others are served.
  await joan.getByTestId('team-section').getByRole('button', { name: 'Rotate my token' }).click();
  const joanSecond = await tokenOfDialog(joan, `Your token for “${MISSION}”`);
  expect(joanSecond).not.toBe(joanToken);
  expect(await doorSays(joanToken)).toEqual({ status: 401, reason: 'token-rotated' });
  for (const token of [joanSecond, ciToken, inesToken]) {
    expect(await doorSays(token)).toEqual({ status: 200, reason: null });
  }

  // Ines removes Joan: her token is refused at once, and the mission is gone for her.
  await ines.goto(missionUrl);
  await ines.getByRole('button', { name: `Remove ${E2E_SHARE_TARGET.email}` }).click();
  await expect(memberRow(ines, E2E_SHARE_TARGET.email)).toHaveCount(0);
  expect(await doorSays(joanSecond)).toEqual({ status: 401, reason: 'holder-removed' });
  expect(await doorSays(ciToken)).toEqual({ status: 200, reason: null });
  const gone = await joan.goto(missionUrl);
  expect(gone?.status()).toBe(404);
  await joan.goto('/missions');
  await expect(joan.getByTestId('missions-shared')).toContainText('No mission is shared with you.');

  // Ines revokes the CI's token: refused with its own reason; hers still works.
  await ines.getByRole('button', { name: `Revoke the token of ${CI}` }).click();
  await expect(tokenRow(ines, CI)).toHaveCount(0);
  expect(await doorSays(ciToken)).toEqual({ status: 401, reason: 'token-revoked' });
  expect(await doorSays(inesToken)).toEqual({ status: 200, reason: null });
  await snap(ines, 'team-creator-after-removal');
});
