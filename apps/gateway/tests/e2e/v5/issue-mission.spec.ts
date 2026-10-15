/**
 * "New mission" in a browser, against an ephemeral instance with a simulated
 * IdP (spec §7.4, §4.2, §4.4).
 *
 * The signed-in person owns a GitHub, a Supabase and a Vercel account (and an
 * experimental Gmail one). The first test creates a three-account mission and
 * checks the screen is the one the redesign asks for — presets first, each
 * saying what it yields; the summary and the one action in a rail that stays
 * in view; the permissions one by one a click away; a confirmation that lists
 * every permission with its limit — then follows the key through its
 * replacement and the mission to its stop; the second covers the two other
 * ways to start: an agent's proposal and a copy; the third reads the
 * reference.
 */
import { expect, test, type Page } from '@playwright/test';

import { checkToken, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';
import {
  confirmByTyping,
  createMission,
  includeWithPreset,
  missionMenu,
  openCreatedMission,
  permissionRow,
  pickPreset,
  presetChoice,
  resourcesButton,
  revealedKey,
  savedKey,
  showPermissions,
} from './mission-pages';

/**
 * The default state of a mission on three accounts — every preset counted,
 * one sentence each — fits in less than two screens at 1280 x 800, the build
 * footer included (spec §4.2 asks for "about two viewports").
 */
const COMPACT_SCREENS = 2;

/** Keeps a screenshot of a step when `E2E_V5_SCREENSHOT_DIR` names a folder (design review). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_V5_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ context, request }) => {
  await routeToInstance(context);
  await signInAs(request, E2E_USER);
});

/** `/missions` behind the IdP: the round trip through the simulated consent screen. */
async function signIn(page: Page): Promise<void> {
  // No session: the page sends the visitor to the sign-in.
  await page.goto('/missions');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/auth/login?return_to=/missions');
  await expect(page.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible();
  await expect(page.getByText(E2E_USER.email)).toBeVisible();
}

test('create a three-account mission on one page, then replace its key and stop it', async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'New mission' }).first().click();
  await expect(page.getByRole('heading', { name: 'New mission', level: 1 })).toBeVisible();

  // Experimental services stay out until the person asks for them.
  await expect(page.getByTestId('connection-gmail')).toHaveCount(0);
  await page.getByLabel('Show experimental services').check();
  await expect(page.getByTestId('connection-gmail')).toBeVisible();
  await page.getByLabel('Show experimental services').uncheck();
  await expect(page.getByTestId('connection-gmail')).toHaveCount(0);

  // Nothing can be created before a name, an account and a preset; the rail says what is missing.
  const create = page.getByRole('button', { name: 'Create mission' });
  await expect(create).toBeDisabled();
  await expect(page.getByTestId('issues')).toContainText('Give the mission a name.');
  await expect(page.getByTestId('issues')).toContainText('Include at least one account.');

  await page.getByLabel('Mission name').fill('Ship the billing page');
  await page.getByLabel('Include GitHub acme-org').check();
  // An account without a preset allows nothing, and the rail says so in the interface's words.
  await expect(page.getByTestId('issues')).toContainText(
    'GitHub · acme-org allows nothing yet: pick a preset or a permission, or leave the account out.',
  );
  await pickPreset(page, 'GitHub acme-org', 'Developer');
  await includeWithPreset(page, 'Supabase Acme Supabase', 'Staging developer');
  await includeWithPreset(page, 'Vercel Acme Vercel', 'Developer');
  await expect(page.getByTestId('issues')).toHaveCount(0);

  // Resources: all selected by default, the list behind "Change".
  await expect(resourcesButton(page, 'GitHub acme-org', '3 of 3')).toBeVisible();
  await expect(page.getByLabel('Resource acme/app')).toHaveCount(0);

  // The rail says, per account, what is allowed, what asks first and what it cannot do.
  const rail = page.getByTestId('summary');
  await expect(page.getByTestId('summary-github')).toContainText('acme/app');
  await expect(page.getByTestId('summary-github')).toContainText('Can');
  await expect(page.getByTestId('summary-github')).toContainText('Asks you');
  await expect(page.getByTestId('summary-github')).toContainText('Cannot');
  await expect(page.getByTestId('summary-github')).toContainText('8 permissions.');
  await expect(page.getByTestId('summary-supabase')).toBeVisible();
  await expect(page.getByTestId('summary-vercel')).toBeVisible();
  await expect(page.getByTestId('summary-carries')).toContainText('explicit permissions');
  await expect(page.getByTestId('summary-carries')).toContainText('limits reset every day');
  await expect(page.getByTestId('summary-carries')).toContainText('never expires');
  await expect(rail).not.toContainText(/\b(risk|quota|budget|gate)\b/i);
  await expect(create).toBeEnabled();

  // A preset says what it means, on the page: one sentence, then the policy counted.
  await expect(page.getByTestId('preset-detail-github')).toContainText(
    'One mission per code repository',
  );
  const digest = page.getByTestId('preset-digest-github');
  await expect(digest).toContainText('8 run freely');
  await expect(digest).toContainText('2 ask you first');
  // Nineteen ids on GitHub (catalog v6): ten chosen, eight left out, and the fallback,
  // which no preset holds and nobody counts as something a preset "left out".
  await expect(digest).toContainText('8 not included');
  await expect(
    page.getByTestId('preset-detail-github').getByRole('link', { name: /In the reference/ }),
  ).toHaveAttribute('href', '/reference/github#preset-developer');
  // The choice itself carries the width of each preset; "Custom" is one of the choices.
  const githubChoices = page.getByRole('group', { name: 'Preset for GitHub acme-org' });
  await expect(githubChoices.getByRole('radio')).toHaveCount(4);
  await expect(githubChoices.locator('[data-choice="developer"]')).toHaveText(/Developer\s*10/);
  await expect(presetChoice(page, 'GitHub acme-org', 'Custom')).not.toBeChecked();

  // Compact by default: no editor is open, there is no wall of checkboxes, the form is
  // under two screens, and the one action is in view without scrolling.
  await expect(page.getByTestId('risks-github')).toHaveCount(0);
  await expect(page.locator('[data-permission]')).toHaveCount(0);
  const layout = await page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].filter((el) =>
      el.checkVisibility(),
    ).length,
  }));
  await snap(page, 'creation-three-accounts');
  expect(layout.pageHeight).toBeLessThanOrEqual(COMPACT_SCREENS * layout.viewport);
  expect(layout.checkboxes).toBeLessThanOrEqual(6);
  await expect(create).toBeInViewport();
  await page.mouse.wheel(0, 2000);
  await expect(create).toBeInViewport();
  await page.mouse.wheel(0, -2000);

  // Deselecting the staging project drops the staging-only entries of the preset, and says so.
  await resourcesButton(page, 'Supabase Acme Supabase', '2 of 2').click();
  await page.getByLabel('Resource stgprojectref').uncheck();
  await expect(page.getByTestId('preset-skipped-supabase')).toContainText('left out here');
  await expect(page.getByTestId('preset-skipped-supabase')).toContainText('labelled "staging"');
  await page.getByLabel('Resource stgprojectref').check();
  await expect(page.getByTestId('preset-skipped-supabase')).toHaveCount(0);

  // The permissions one by one, a click away: the editor opens in place on the preset's values.
  const githubPanel = page.getByTestId('preset-github');
  await githubPanel.getByRole('button', { name: 'Edit the permissions one by one' }).click();
  const editor = page.getByTestId('risks-github');
  await expect(editor).toBeVisible();
  // By default it lists what the person may allow here: on an account they own, everything.
  await expect(editor.locator('[data-permission]')).toHaveCount(19);
  const merge = permissionRow(editor, 'github.merge-protected');
  await expect(merge).toContainText('Write on main / master / release-*');
  // The id is printed as the protocol spells it; the severity is one word.
  await expect(merge).toContainText('github.merge-protected');
  await expect(merge.locator('[data-severity]')).toHaveText(/low|medium|high|critical/);
  // "why?" is closed; behind it, the reason, the six words and the reference in a new tab.
  await expect(editor.getByText('The canonical branch')).toBeHidden();
  await merge.getByRole('button', { name: 'why?' }).click();
  await expect(editor.getByText('The canonical branch')).toBeVisible();
  await expect(editor.getByText('Undo', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(
    editor.getByText('Blast radius', { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  // One "why?" is open: its link is the only one a person can reach.
  const reference = editor.getByRole('link', { name: /Full entry in the reference/ });
  await expect(reference).toHaveAttribute('href', '/reference/github#risk-github.merge-protected');
  await expect(reference).toHaveAttribute('target', '_blank');
  await merge.getByRole('button', { name: 'hide' }).click();
  await expect(page.getByLabel('Allow github.merge-protected')).not.toBeChecked();
  await expect(page.getByLabel('Allow github.read-code')).toBeChecked();
  await expect(page.getByLabel('Limit for github.read-code')).toHaveValue('10000');
  await expect(page.getByLabel('Per minute for github.read-code')).toHaveValue('240');
  await expect(page.getByTestId('risks-count-github')).toHaveText(
    '10 chosen of 19 you may allow here',
  );
  // Adjust one limit and one "ask me first": the choice says it was adjusted, the counts follow.
  await page.getByLabel('Limit for github.read-code').fill('42');
  await page.getByLabel('ask me first: github.create-pr').check();
  await expect(githubChoices.locator('[data-choice="developer"]')).toContainText('adjusted');
  await expect(digest).toContainText('7 run freely');
  await expect(digest).toContainText('3 ask you first');
  // Another preset would drop those edits: the screen asks first, and states the consequence.
  // (a click, not a check: the choice does not move until the person confirms)
  await presetChoice(page, 'GitHub acme-org', 'Read-only').click();
  const discard = page.getByTestId('discard-dialog');
  await expect(discard).toContainText('Discard what you changed?');
  await expect(discard).toContainText('Another preset replaces');
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Limit for github.read-code')).toHaveValue('42');
  await expect(presetChoice(page, 'GitHub acme-org', 'Developer')).toBeChecked();
  await snap(page, 'creation-editor');
  await githubPanel.getByRole('button', { name: 'Hide the permissions' }).click();
  await expect(page.getByTestId('risks-github')).toHaveCount(0);

  // A long catalog is searchable; what no selected resource can carry is one filter away,
  // listed with the reason and without a usable tick.
  await page
    .getByTestId('preset-supabase')
    .getByRole('button', { name: 'Edit the permissions one by one' })
    .click();
  const supabase = page.getByTestId('risks-supabase');
  const available = await supabase.locator('[data-permission]').count();
  await supabase.getByRole('button', { name: 'All', exact: true }).click();
  const all = await supabase.locator('[data-permission]').count();
  expect(all).toBeGreaterThan(available);
  await supabase.getByLabel('Search the permissions of Supabase Acme Supabase').fill('bulk row');
  const found = await supabase.locator('[data-permission]').count();
  expect(found).toBeGreaterThan(0);
  expect(found).toBeLessThan(all);
  await expect(page.getByLabel('Allow supabase[preview].bulk-row-write')).toBeDisabled();
  await expect(permissionRow(supabase, 'supabase[preview].bulk-row-write')).toContainText(
    'Not available: no selected resource is labelled "preview"',
  );
  await supabase.getByLabel('Search the permissions of Supabase Acme Supabase').fill('');
  // A service with several planes can be sliced by one, in the editor too.
  const plane = supabase.getByLabel('Plane of the permissions of Supabase Acme Supabase');
  await plane.selectOption('storage');
  const storage = await supabase.locator('[data-permission]').count();
  expect(storage).toBeGreaterThan(0);
  expect(storage).toBeLessThan(all);
  await expect(supabase.locator('[data-permission*="migration-write"]')).toHaveCount(0);
  await expect(supabase.locator('[data-permission*="storage.object-read"]')).toHaveCount(1);
  await snap(page, 'creation-editor-plane');
  await plane.selectOption('all');
  expect(await supabase.locator('[data-permission]').count()).toBe(all);
  // Untouched, the Supabase policy is still the preset's: nothing says "adjusted".
  await expect(
    page.getByRole('group', { name: 'Preset for Supabase Acme Supabase' }),
  ).not.toContainText('adjusted');
  await page
    .getByTestId('preset-supabase')
    .getByRole('button', { name: 'Hide the permissions' })
    .click();
  // GitHub has one plane: no plane filter there.
  await githubPanel.getByRole('button', { name: 'Edit the permissions one by one' }).click();
  await expect(page.getByLabel('Plane of the permissions of GitHub acme-org')).toHaveCount(0);
  await githubPanel.getByRole('button', { name: 'Hide the permissions' }).click();

  await page.getByLabel('Limits reset').selectOption({ label: 'Every week' });
  await page.getByLabel('Expires', { exact: true }).selectOption({ index: 3 });
  await expect(page.getByTestId('summary-carries')).toContainText('limits reset every week');
  await expect(page.getByTestId('summary-carries')).toContainText(/expires \d+ \w+/);

  // "Create mission" asks once, and what is confirmed is the explicit list: every
  // permission by its name and its id, with its limit, and what asks first.
  await create.click();
  const confirm = page.getByTestId('confirm-create');
  await expect(confirm).toContainText('Create “Ship the billing page”?');
  await expect(confirm).toContainText('This is the explicit list the key will carry');
  const list = confirm.getByTestId('explicit-list');
  const confirmed = await list.locator('[data-permission]').count();
  expect(confirmed).toBeGreaterThan(20);
  const readCodeLine = permissionRow(list, 'github.read-code');
  await expect(readCodeLine).toContainText('Read code, branches, commits, files');
  await expect(readCodeLine).toContainText('42 a week');
  await expect(readCodeLine).toContainText('240 a minute');
  await expect(permissionRow(list, 'github.create-pr')).toContainText('ask me first');
  await expect(permissionRow(list, 'github.read-code')).toContainText('runs freely');
  await snap(page, 'creation-confirm');
  // Nothing was created yet: going back changes nothing.
  await confirm.getByRole('button', { name: 'Back to the form' }).click();
  await expect(confirm).toBeHidden();

  // The key, shown once, on the page that follows, with the kit.
  const token = await createMission(page);
  await expect(
    page.getByRole('heading', { name: 'Ship the billing page', level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId('created')).toContainText('Shown once.');
  await expect(page.getByTestId('created')).toContainText(`${confirmed} permissions on GitHub`);
  await expect(page.getByTestId('kit-mcp')).toContainText('"url": "https://gateway.e2e.test/mcp"');
  await expect(page.getByTestId('kit-mcp')).toContainText('Bearer ${VAUBAAN_MISSION_TOKEN}');
  await expect(page.getByTestId('kit-mcp')).not.toContainText(token);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).toContainText('`github.read-code`');
  await expect(page.getByTestId('kit-instructions')).toContainText('hand `claim_url` to the human');
  await expect(page.getByTestId('kit-instructions')).toContainText('Never work around a refusal');
  await expect(page.getByTestId('kit-verify')).toContainText('"method":"tools/list"');
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'verified' });
  await snap(page, 'created-key-and-kit');

  // The mission page shows the masked key, never the key.
  await openCreatedMission(page, 'Ship the billing page');
  expect(await page.content()).not.toContain(token);
  // A running mission is not labelled: only an exception gets a mark beside the title.
  await expect(page.getByTestId('mission-state')).toHaveCount(0);
  // When it was created, relative, with the instant behind; its short id in the details line.
  await expect(page.locator('p', { has: page.getByTestId('mission-created') })).toContainText(
    /Created by you (just now|\d+ min ago)/,
  );
  await expect(page.getByTestId('mission-created')).toHaveAttribute('title', /\d{2}:\d{2} UTC$/);
  await expect(page.getByTestId('mission-created')).toHaveAttribute('datetime', /^\d{4}-/);
  const missionId = page.url().split('/missions/')[1]?.split(/[?#]/)[0] ?? '';
  await expect(page.getByTestId('mission-details')).toHaveText(`Mission id ${missionId.slice(-8)}`);
  await expect(page.getByTestId('mission-details').locator('[title]')).toHaveAttribute(
    'title',
    missionId,
  );
  await expect(page.getByTestId('mission-allows')).toContainText('Can');
  await expect(page.getByTestId('mission-allows')).toContainText('Asks you first');
  await expect(page.getByTestId('mission-allows')).toContainText('Cannot');
  await expect(page.getByTestId('mission-allows')).toContainText('Nothing is near its limit');
  // The key is a detail of "People and keys".
  const prefix = token.split('_')[2] ?? '';
  await expect(page.getByText(`vbn_live_${prefix}_…`)).toBeHidden();
  await page.getByTestId('team-section').getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByText(`vbn_live_${prefix}_…`).first()).toBeVisible();

  // The explicit list is one click away, with what was used; each row explains itself.
  const permissions = await showPermissions(page);
  await expect(permissions.locator('tr[data-permission]')).toHaveCount(confirmed);
  const readCode = permissionRow(permissions, 'github.read-code');
  await expect(readCode).toContainText('Read code, branches, commits, files');
  await expect(readCode).toContainText('0 / 42');
  await expect(permissionRow(permissions, 'github.create-pr')).toContainText('ask me first');
  await expect(permissions.getByRole('columnheader', { name: 'Used this week' })).toBeVisible();
  await readCode.getByRole('button', { name: 'why?' }).click();
  await expect(permissions.getByText('Reads may leak secrets')).toBeVisible();
  await snap(page, 'mission-detail');
  // "why?" leads to the entry in the reference.
  const missionUrl = page.url();
  await permissions.getByRole('link', { name: 'Full entry in the reference' }).first().click();
  await expect(page).toHaveURL(/\/reference\/github#risk-github\.read-code$/);
  await expect(page.getByTestId('risk-github.read-code')).toBeInViewport();
  await page.goto(missionUrl);
  await expect(
    page.getByRole('heading', { name: 'Ship the billing page', level: 1 }),
  ).toBeVisible();
  // The page remembered that this mission's permissions were open.
  await expect(page.getByTestId('permissions-table')).toBeVisible();

  // The kit is on the mission page, without the key.
  await page.getByRole('button', { name: 'Setup kit' }).click();
  const kit = page.getByTestId('kit-dialog');
  await expect(kit.getByTestId('kit-env')).toContainText(`vbn_live_${prefix}_…`);
  await expect(kit).not.toContainText(token);
  await kit.getByRole('button', { name: 'Close' }).click();

  // Replace key: it asks first and states the consequence; cancelling changes nothing.
  await missionMenu(page, 'Replace my key');
  const replace = page.getByTestId('replace-key-dialog').filter({ hasText: 'Replace your key?' });
  await expect(replace).toContainText('Your current key stops working at once');
  await expect(replace).toContainText('refused from its next call');
  await expect(replace).toContainText('same permissions, same limits, same people');
  await replace.getByRole('button', { name: 'Cancel' }).click();
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'verified' });
  // Confirmed: a new key, shown once; the old one is refused.
  await missionMenu(page, 'Replace my key');
  await replace.getByRole('button', { name: 'Replace key' }).click();
  await expect(page.getByTestId('reveal-dialog')).toContainText('Your new key for');
  const rotated = await revealedKey(page);
  expect(rotated).not.toBe(token);
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'retired', reason: 'rotated' });
  expect(await checkToken(request, rotated)).toMatchObject({ outcome: 'verified' });
  // Escape does not close a dialog whose key cannot be shown again.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('reveal-dialog')).toBeVisible();
  await savedKey(page);

  // Stop the mission, from the zone at the bottom of its page (the "···" item opens the same
  // dialog): the person types its name; every key is refused from then on.
  await page.getByTestId('mission-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Stop the mission' })).toBeVisible();
  await page.keyboard.press('Escape');
  const stopZone = page.getByTestId('mission-stop');
  await expect(stopZone.getByRole('heading', { name: 'Stop this mission' })).toBeVisible();
  await expect(stopZone).toContainText('This cannot be undone');
  await stopZone.getByRole('button', { name: 'Stop the mission' }).click();
  await expect(page.getByRole('dialog')).toContainText('Every key of the mission stops working');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Stop the mission' }),
  ).toBeDisabled();
  await confirmByTyping(page, 'Ship the billing page', 'Stop the mission');
  await expect(page.getByTestId('mission-state')).toHaveText('stopped');
  // A stopped mission offers nothing that would be refused.
  await page.getByTestId('mission-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Replace my key' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Stop the mission' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add people' })).toHaveCount(0);
  await expect(page.getByTestId('mission-stop')).toHaveCount(0);
  expect(await checkToken(request, rotated)).toMatchObject({
    outcome: 'retired',
    reason: 'revoked',
    mission_status: 'revoked',
  });

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Missions' })
    .click();
  await expect(page.getByRole('row', { name: /Ship the billing page/ })).toContainText('stopped');
  // Each row says when its mission was created; four columns by default, the key a detail.
  await expect(page.getByRole('row', { name: /Ship the billing page/ })).toContainText(
    /created (just now|\d+ min ago)/,
  );
  const table = page.getByTestId('missions-created-table');
  await expect(table.locator('thead th:visible')).toHaveCount(4);
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(table.locator('thead th:visible')).toHaveCount(5);
  await page.getByRole('button', { name: 'Hide details' }).click();
});

test('start from an agent’s proposal, then duplicate the mission', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/missions/new');

  await page.getByRole('button', { name: 'Paste an agent’s proposal' }).click();
  await page.getByLabel('Agent proposal (JSON)').fill(
    JSON.stringify({
      name: 'Review the pricing PR',
      connections: [
        {
          provider: 'github',
          preset: 'read-only',
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
        },
        {
          provider: 'supabase',
          policy: [
            {
              risk_id: 'supabase.read-data',
              quota: 50,
              rate_limit: { max: 10, window_seconds: 60 },
            },
            {
              risk_id: 'supabase[preview].bulk-row-write',
              quota: 1,
              rate_limit: { max: 1, window_seconds: 60 },
            },
          ],
        },
      ],
      period: { kind: 'one-off' },
    }),
  );
  await page.getByRole('button', { name: 'Check and load' }).click();

  // What passes fills the form; what cannot resolve is listed, not loaded.
  const report = page.getByTestId('proposal-report');
  await expect(report).toContainText(/Loaded \d+ permissions on 2 accounts/);
  await expect(report).toContainText('no selected resource carries the environment of');
  await expect(report).toContainText('supabase[preview].bulk-row-write');
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR');
  await expect(page.getByLabel('Include GitHub acme-org')).toBeChecked();
  await expect(resourcesButton(page, 'GitHub acme-org', '1 of 3')).toBeVisible();
  // A loaded list is the person's own until they pick a preset over it: the choice names
  // the preset it came from as adjusted, and the editor is closed until asked for.
  await expect(page.getByTestId('preset-digest-github')).toContainText('run freely');
  await expect(page.getByTestId('risks-github')).toHaveCount(0);
  await page
    .getByTestId('preset-github')
    .getByRole('button', { name: 'Edit the permissions one by one' })
    .click();
  await expect(page.getByLabel('Allow github.read-code')).toBeChecked();
  await expect(page.getByLabel('Limits reset')).toHaveValue('one-off');
  await expect(page.getByTestId('summary-carries')).toContainText('limits do not reset');
  // A mission whose limits never reset heads its limit column "In total".
  await expect(
    page.getByTestId('risks-github').getByRole('columnheader', { name: 'In total' }),
  ).toBeVisible();

  const first = await createMission(page);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).not.toContainText('`acme/web`');
  await openCreatedMission(page, 'Review the pricing PR');

  // Duplicate: same policy, its own key.
  await missionMenu(page, 'Duplicate');
  await expect(page.getByTestId('duplicating')).toContainText(
    'Duplicating “Review the pricing PR”',
  );
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR (copy)');
  await expect(page.getByLabel('Include Supabase Acme Supabase')).toBeChecked();
  await expect(resourcesButton(page, 'GitHub acme-org', '1 of 3')).toBeVisible();
  const second = await createMission(page);
  expect(second).not.toBe(first);
  expect(await checkToken(request, first)).toMatchObject({ outcome: 'verified' });
  expect(await checkToken(request, second)).toMatchObject({ outcome: 'verified' });
});

test('the reference explains each service: permissions against presets, tools, model', async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reference' })
    .click();
  await expect(page.getByRole('heading', { name: 'Reference', level: 1 })).toBeVisible();
  // One line per shipped plugin, from the registry; the experimental one says so.
  await expect(page.getByTestId('provider-github')).toContainText('19 permissions');
  await expect(page.getByTestId('provider-github')).toContainText('3 presets');
  await expect(page.getByTestId('provider-github')).toContainText('26 tools');
  await expect(page.getByTestId('provider-gmail')).toContainText('experimental');
  // The services are a local navigation beside the content.
  const services = page.getByRole('navigation', { name: 'Services' });
  await expect(services.getByRole('link', { name: 'All services' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(services.getByRole('link', { name: 'Supabase' })).toBeVisible();
  // The side navigation marks the current section.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Reference' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav.getByRole('link', { name: 'Missions' })).not.toHaveAttribute('aria-current');
  // The person is one control at the foot of the navigation; signing out is behind it.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  await page.getByTestId('user-menu').click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  await snap(page, 'providers-index');

  await page.getByTestId('provider-supabase').getByRole('link', { name: 'Supabase' }).click();
  // The place keeps its title; the service is the heading under it.
  await expect(page.getByRole('heading', { name: 'Reference', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Supabase', level: 2 })).toBeVisible();
  await expect(services.getByRole('link', { name: 'Supabase' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByTestId('provider-summary')).toContainText('one resource is one project');

  // One section in view at a time, behind tabs; the permissions come first.
  const tabs = page.getByRole('tablist', { name: 'Supabase reference' });
  await expect(tabs.getByRole('tab')).toHaveText([/Permissions/, /Tools/, /How it is modelled/]);
  await expect(tabs.getByRole('tab', { name: /Permissions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  // Help is on demand: closed by default, and remembered once opened.
  const help = page.getByTestId('reference-help');
  await expect(help).toBeHidden();
  await page.getByRole('button', { name: 'How to read this page' }).click();
  await expect(help.getByText('can it be undone, and at what price?')).toBeVisible();
  await expect(help).toContainText('runs freely');
  await page.reload();
  await expect(help).toBeVisible();
  await page.getByRole('button', { name: 'Hide how to read this page' }).click();
  await expect(help).toBeHidden();

  // The permissions against the presets: one column each, a cell per limit.
  const matrix = page.getByTestId('preset-matrix');
  const preset = page.getByTestId('preset-staging-developer');
  await expect(preset).toContainText('Staging developer');
  await expect(preset).toContainText(/\d+ permissions|\d+ · \d+ ask/);
  await expect(matrix.getByRole('columnheader')).toHaveText([
    'Permission',
    'Risk',
    /Read-only analyst/,
    /Staging developer/,
    /Migration operator/,
  ]);
  const bulkCell = page.getByTestId('cell-staging-developer-supabase.bulk-row-write');
  await expect(bulkCell).toContainText('staging');
  await expect(bulkCell).toContainText(/\d/);
  await expect(page.getByTestId('cell-read-only-analyst-supabase.bulk-row-write')).toContainText(
    'not included',
  );
  await expect(page.getByTestId('cell-migration-operator-supabase.migration-write')).toContainText(
    'asks first',
  );
  await snap(page, 'provider-presets');

  // A text filter narrows the list in view.
  const rows = matrix.locator('tr[data-risk]');
  const all = await rows.count();
  await page.getByLabel('Filter the permissions').fill('migration');
  await expect(rows.first()).toContainText(/migration/i);
  expect(await rows.count()).toBeLessThan(all);
  await page.getByLabel('Filter the permissions').fill('no such permission');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await page.getByLabel('Filter the permissions').fill('');
  await expect(rows).toHaveCount(all);

  // The parts of the service slice every tab at once.
  const planes = page.getByTestId('plane-control');
  await expect(planes.getByRole('button')).toHaveText([
    'All',
    'db',
    'storage',
    'auth',
    'functions',
    'other',
  ]);
  await planes.getByRole('button', { name: 'storage' }).click();
  await expect(rows).toHaveCount(6);
  await expect(matrix).not.toContainText('Apply a migration');
  await tabs.getByRole('tab', { name: /Tools/ }).click();
  await expect(page).toHaveURL(/#tools$/);
  const tool = (name: string) => page.getByTestId('tool-table').locator(`tr[data-row="${name}"]`);
  await expect(tool('supabase__list_buckets')).toBeVisible();
  await expect(tool('supabase__list_users')).toHaveCount(0);
  await expect(tool('supabase__list_buckets')).toContainText('by arguments');
  // What no part can be read for is under "other", not guessed.
  await planes.getByRole('button', { name: 'other' }).click();
  await expect(tool('supabase__execute_sql')).toBeVisible();
  // The keyboard moves between tabs.
  await tabs.getByRole('tab', { name: /Tools/ }).press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /How it is modelled/ })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: /How it is modelled/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await planes.getByRole('button', { name: 'All' }).click();
  // The model as an outline, with what carries the environment.
  await expect(page.getByRole('region', { name: 'Part db' })).toContainText('schema');
  await expect(page.getByTestId('provider-environment')).toContainText(
    'the label the owner of the account puts on each resource',
  );
  await expect(page.getByText('carries the environment').first()).toBeVisible();
  await snap(page, 'provider-data-model');

  // An anchor of a permission opens Permissions on a part that shows the entry, and unfolds it.
  await planes.getByRole('button', { name: 'auth' }).click();
  await page.goto('/reference/supabase#risk-supabase.bulk-row-write');
  await expect(tabs.getByRole('tab', { name: /Permissions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const entry = page.getByTestId('risk-supabase.bulk-row-write');
  await expect(entry).toBeInViewport();
  await expect(entry.getByRole('button', { name: /Bulk write on a table/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(entry).toContainText('supabase.bulk-row-write');
  const unfolded = page.locator('[id="risk-supabase.bulk-row-write-detail"]');
  await expect(unfolded).toContainText('once per environment');
  await expect(unfolded).toContainText('supabase[staging].bulk-row-write');
  // The six words behind the severity, what it covers, and its limits in each preset.
  await expect(unfolded.getByText('Blast radius').first()).toBeVisible();
  await expect(unfolded).toContainText('Write: project');
  await expect(unfolded).toContainText('supabase.project');
  await expect(unfolded).toContainText('Staging developer');
  await expect(unfolded).toContainText('Migration operator');
  await expect(unfolded).toContainText(/\d+\/min/);
  // The reader was on `auth`, which does not show this entry: its own part was opened.
  await expect(planes.getByRole('button', { name: 'db' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('risk-supabase.auth.generate-link')).toHaveCount(0);
  await planes.getByRole('button', { name: 'All' }).click();
  // A row is compact until asked: folded, what it covers is not on the page.
  const folded = page.getByTestId('risk-supabase.read-data');
  await expect(folded.getByRole('button', { name: /Read data and schema/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByText('Read anything in supabase')).toHaveCount(0);
  await folded.getByRole('button', { name: /Read data and schema/ }).click();
  await expect(page.locator('[id="risk-supabase.read-data-detail"]')).toContainText(
    'Read anything in supabase',
  );
  // "Anything not named" is explained where it is listed, once unfolded.
  const fallback = page.getByTestId('risk-supabase.uncategorized-write');
  await expect(fallback).toContainText('anything not named');
  await fallback.getByRole('button', { name: /Uncategorized Supabase write/ }).click();
  await expect(page.locator('[id="risk-supabase.uncategorized-write-detail"]')).toContainText(
    'Counts only for a write no other entry of the catalog names',
  );
  await snap(page, 'provider-risks');
  // The name of a preset is the link to its column.
  await page.getByTestId('preset-migration-operator').getByRole('link').click();
  await expect(page).toHaveURL(/#preset-migration-operator$/);
  await expect(page.getByTestId('preset-migration-operator')).toBeInViewport();

  // A preset anchor, as mission creation links to it; a service with one part has no filter by part.
  await page.goto('/reference/github#preset-developer');
  await expect(page.getByTestId('preset-developer')).toBeInViewport();
  await expect(page.getByTestId('plane-control')).toHaveCount(0);
  await expect(page.getByTestId('preset-matrix')).toContainText('Modify a GitHub Actions workflow');
  await expect(page.getByTestId('cell-developer-github.workflow-write-via-file')).toContainText(
    'asks first',
  );
  // The earlier sections still lead somewhere: `#risks` and `#presets` open Permissions.
  // Nineteen permissions (catalog v6 added the four of git), folded, read in about two screens.
  await page.goto('/reference/github#risks');
  await expect(page.getByRole('tab', { name: /Permissions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('tr[data-testid^="risk-github."]')).toHaveCount(19);
  const first = await page.getByTestId('risk-github.read-code').boundingBox();
  const last = await page.getByTestId('risk-github.delete-release').boundingBox();
  const viewport = page.viewportSize();
  if (!first || !last || !viewport) throw new Error('the list of permissions is not laid out');
  expect((last.y + last.height - first.y) / viewport.height).toBeLessThan(2.1);
  // The page does not scroll sideways at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  // The one tool that hands a token of the service to the agent, and its permissions, say so.
  await page.goto('/reference/github#tools');
  await expect(page.getByRole('tab', { name: /Tools/ })).toHaveAttribute('aria-selected', 'true');
  const mint = page.getByTestId('tool-table').locator('tr[data-row="github__mint_install_token"]');
  await expect(mint).toContainText('hands a token to the agent');
  await expect(mint.getByRole('link', { name: 'github.mint-install-token-push' })).toHaveAttribute(
    'href',
    '#risk-github.mint-install-token-push',
  );
  await expect(page.getByTestId('token-handout-note')).toContainText(
    'What the agent then does with that token is outside the gateway',
  );
  await expect(page.getByTestId('token-handout-note')).toContainText(
    'a token that can write is handed only after the creator approves the call',
  );
  await mint.getByRole('link', { name: 'github.mint-install-token-push' }).click();
  const push = page.getByTestId('risk-github.mint-install-token-push');
  await expect(push).toBeInViewport();
  // The tag says what the token can do: a preset hands a write token after a yes only.
  await expect(push).toContainText('hands a write token');
  await expect(page.locator('[id="risk-github.mint-install-token-push-detail"]')).toContainText(
    'github__mint_install_token',
  );
  await expect(page.getByTestId('risk-github.mint-install-token-clone')).toContainText(
    'hands a read-only token',
  );
  await expect(page.getByTestId('risk-github.read-code')).not.toContainText('hands a');
  await snap(page, 'provider-token-handouts');
  // An unknown service is not found.
  const missing = await page.goto('/reference/no-such-provider');
  expect(missing?.status()).toBe(404);
});
