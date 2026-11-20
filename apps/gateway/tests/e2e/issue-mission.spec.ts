/**
 * "New mission" in a browser, against an ephemeral instance with a simulated
 * IdP (spec §7.4, §4.2, §4.4).
 *
 * The signed-in person owns a GitHub, a Supabase, a Vercel and a Gmail
 * account. The first test creates a mission card by card — "+ Add an account",
 * the resources grouped by environment (two Supabase cards, staging and prod),
 * macro-actions at a trust level, Custom for one of them, a summary bar that
 * stays in view, a confirmation that lists every permission with its limit —
 * then reads the mission page (the screen frozen, with the use of the period),
 * follows the key through its replacement and the mission to its stop and the
 * list's Stopped filter; the second covers the two other ways to start: an
 * agent's proposal and a copy; the third reads the reference.
 */
import { expect, test, type Page } from '@playwright/test';
import { githubPlugin } from '@vaubaan/plugin-github';

import { checkToken, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';
import {
  cardOf,
  confirmByTyping,
  createMission,
  includeWithTrustLevels,
  missionMenu,
  openCreatedMission,
  openCustom,
  pickTrustLevel,
  revealedKey,
  savedKey,
  trustLevelChoice,
} from './mission-pages';

/**
 * What the pages show of the GitHub plugin is read from the plugin itself, so a
 * permission, a macro-action or a tool added to it does not leave this file behind.
 */
const GITHUB = {
  permissions: githubPlugin.catalog.risks.length,
  macroActions: githubPlugin.catalog.macro_actions?.length ?? 0,
  tools: githubPlugin.tools.length,
};

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

test('create a mission card by card on one page, then replace its key and stop it', async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'New mission' }).first().click();
  await expect(page.getByRole('heading', { name: 'New mission', level: 1 })).toBeVisible();

  // Only the mission's cards are shown: none yet. Nothing can be created before a name,
  // an account and a macro-action; the bar says what is missing.
  const cards = page.getByTestId('cards');
  await expect(cards.getByRole('region')).toHaveCount(0);
  const create = page.getByRole('button', { name: 'Create mission' });
  await expect(create).toBeDisabled();
  await expect(page.getByTestId('issues')).toContainText('Give the mission a name.');
  await expect(page.getByTestId('issues')).toContainText('Add at least one account.');
  await page.getByLabel('Mission name').fill('Ship the billing page');

  // "+ Add an account" offers every account, Gmail included: no service is held back.
  await page.getByTestId('add-account').click();
  const picker = page.getByTestId('account-picker');
  await expect(picker.getByRole('button', { name: /^Gmail · ops mailbox/ })).toBeVisible();
  await expect(picker.getByText(/experimental/i)).toHaveCount(0);
  await picker.getByRole('button', { name: /^GitHub · acme-org/ }).click();
  // Step 2: the repositories, none ticked by itself when there are several: ticked one by
  // one, or "Select all"; no "All" scope.
  const step = page.getByTestId('resource-picker');
  await expect(step).toContainText('Which repositories?');
  await expect(step.getByRole('checkbox', { name: 'Resource acme/app' })).not.toBeChecked();
  await expect(step.getByText(/^All$/)).toHaveCount(0);
  await expect(step.getByRole('checkbox', { name: /^\+ future repositories/ })).not.toBeChecked();
  await expect(step.getByRole('button', { name: 'Add card' })).toBeDisabled();
  await step.getByRole('button', { name: /^Select all/ }).click();
  await expect(step.getByRole('checkbox', { name: 'Resource acme/app' })).toBeChecked();
  await step.getByRole('button', { name: 'Add card' }).click();

  const github = 'GitHub · acme-org';
  await expect(cardOf(page, github).getByTestId('card-resources')).toHaveText(
    '3 repositories: acme/app, acme/infra, acme/web',
  );
  // A card with no macro-action ticked allows nothing, and the card says so in the interface's words.
  await expect(cardOf(page, github).getByTestId('card-issues')).toContainText(
    'GitHub · acme-org allows nothing yet: tick a macro-action, or remove the card.',
  );
  // A trust level ticks its macro-action: reads at Trusting, proposing and shipping at Careful.
  await pickTrustLevel(page, github, 'Read', 'Trusting');
  await pickTrustLevel(page, github, 'Propose', 'Careful');
  await pickTrustLevel(page, github, 'Ship', 'Careful');

  // Supabase: one card per environment, the environment read from the projects' labels.
  await includeWithTrustLevels(
    page,
    'Supabase · Acme Supabase',
    { Query: 'Trusting', 'Change data': 'Careful' },
    { env: 'staging' },
    'Supabase · Acme Supabase (staging)',
  );
  await page.getByTestId('add-account').click();
  await expect(picker.getByRole('button', { name: /^Supabase · Acme Supabase/ })).toContainText(
    '1 of 2 projects free',
  );
  await picker.getByRole('button', { name: /^Supabase · Acme Supabase/ }).click();
  // The staging project is in the other card; the prod group is the one left.
  await expect(step.getByTestId('group-staging')).toContainText('in another card');
  await step.getByRole('radio', { name: 'Environment prod' }).check();
  await expect(step.getByRole('checkbox', { name: 'Resource prdprojectref' })).toBeChecked();
  await step.getByRole('button', { name: 'Add card' }).click();
  const prod = 'Supabase · Acme Supabase (prod)';
  await pickTrustLevel(page, prod, 'Query', 'Careful');
  await pickTrustLevel(page, prod, 'Change data', 'Careful');
  await expect(cardOf(page, prod)).toHaveAttribute('data-env', 'prod');
  // Vercel reads the environment from each call: no badge, unlabelled projects welcome.
  await includeWithTrustLevels(page, 'Vercel · Acme Vercel', {
    Watch: 'Careful',
    'Deploy and review': 'Careful',
  });
  await expect(page.getByTestId('issues')).toHaveCount(0);
  await expect(page.getByTestId('card-issues')).toHaveCount(0);
  await expect(cards.getByRole('region')).toHaveCount(4);

  // Each row says its level; Administer is not ticked.
  await expect(page.getByTestId('macro-github-ship').first()).toHaveAttribute(
    'data-level',
    'careful',
  );
  await expect(page.getByLabel(`Administer on ${github}`)).not.toBeChecked();
  await expect(trustLevelChoice(page, github, 'Administer', 'Careful')).not.toBeChecked();
  // The (i) of a row shows the Custom content, read-only, on hover.
  const githubCard = cardOf(page, github);
  await githubCard.getByRole('button', { name: 'About Ship' }).hover();
  const shipInfo = githubCard.getByTestId('info-ship');
  await expect(shipInfo).toBeVisible();
  await expect(shipInfo).toContainText('Asks you first');
  await expect(shipInfo).toContainText('Left out');
  await expect(shipInfo.getByRole('spinbutton')).toHaveCount(0);
  await expect(githubCard.getByTestId('card-digest')).toContainText(
    /\d+ permissions · \d+ run freely · \d+ ask you/,
  );
  await snap(page, 'creation-cards');

  // Custom: the permissions of one macro-action, one by one. Apply lights Custom.
  let modal = await openCustom(page, github, 'Read');
  await modal.getByLabel('Limit for github.read-code').fill('42');
  await modal
    .getByRole('group', { name: 'Behaviour of github.read-meta' })
    .getByRole('radio', { name: 'Asks first' })
    .check();
  await snap(page, 'creation-custom');
  await modal.getByRole('button', { name: 'Apply' }).click();
  await expect(trustLevelChoice(page, github, 'Read', 'Custom')).toBeChecked();
  // "Start from" a level, then single lines; a level clicked again leaves Custom.
  modal = await openCustom(page, github, 'Read');
  await expect(modal.getByLabel('Limit for github.read-code')).toHaveValue('42');
  await modal.getByRole('button', { name: 'Cancel' }).click();

  // On a prod card, what the catalog never accepts in prod is said, never offered; the
  // plane chips only filter the list.
  modal = await openCustom(page, prod, 'Change data');
  await expect(modal).toContainText('never in prod');
  await expect(modal.getByLabel('Limit for supabase[prod].bulk-row-write')).toHaveCount(0);
  const all = await modal.locator('[data-permission], [data-never]').count();
  await modal.getByRole('button', { name: /^storage/ }).click();
  const storage = await modal.locator('[data-permission], [data-never]').count();
  expect(storage).toBeGreaterThan(0);
  expect(storage).toBeLessThan(all);
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(trustLevelChoice(page, prod, 'Change data', 'Careful')).toBeChecked();

  await page.getByLabel('Limits reset').selectOption({ label: 'Every week' });
  await page.getByLabel('Ends', { exact: true }).selectOption({ index: 3 });
  await expect(page.getByTestId('summary')).toContainText(
    /^4 cards · \d+ permissions · \d+ run freely · \d+ ask you$/,
  );
  await expect(create).toBeEnabled();
  await expect(create).toBeInViewport();

  // "Create mission" creates at once, with no confirmation: the key, shown once, on the
  // page that follows, with the kit. The explicit list is on the mission page.
  const token = await createMission(page);
  await expect(
    page.getByRole('heading', { name: 'Ship the billing page', level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId('created')).toContainText('Shown once.');
  const lede = (await page.getByTestId('created').innerText()).match(/(\d+) permissions on GitHub/);
  expect(Number(lede?.[1] ?? 0)).toBeGreaterThan(15);
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
  // The page is the creation screen frozen, plus the use of the period per macro-action.
  const frozen = page.getByTestId('mission-cards');
  await expect(frozen.getByRole('region')).toHaveCount(4);
  await expect(trustLevelChoice(page, github, 'Read', 'Custom')).toBeChecked();
  await expect(trustLevelChoice(page, github, 'Read', 'Custom')).toBeDisabled();
  await expect(trustLevelChoice(page, prod, 'Query', 'Careful')).toBeChecked();
  await expect(cardOf(page, github).getByRole('columnheader', { name: 'This week' })).toBeVisible();
  const gauge = cardOf(page, github).getByTestId('gauge-read');
  await expect(gauge).toContainText(/0 \/ \d+/);
  await gauge.getByRole('button').hover();
  await expect(gauge.locator('[data-permission="github.read-code"]')).toContainText('0 / 42');
  await expect(gauge.getByRole('link', { name: 'Raise this limit' })).toHaveAttribute(
    'href',
    new RegExp(`/missions/${missionId}/edit\\?custom=.+&action=read$`),
  );
  // No list of every permission, no stop zone: stop and duplicate are in "···", the acts on
  // a key in "Keys".
  await expect(page.getByTestId('mission-permissions')).toHaveCount(0);
  await expect(page.getByTestId('mission-stop')).toHaveCount(0);
  await snap(page, 'mission-detail');
  // The key is a detail of "Keys".
  const prefix = token.split('_')[2] ?? '';
  await expect(page.getByText(`vbn_live_${prefix}_…`)).toBeHidden();
  await page.getByTestId('team-section').getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByText(`vbn_live_${prefix}_…`).first()).toBeVisible();

  // The kit is on the mission page, without the key.
  await page.getByRole('button', { name: 'Setup kit' }).click();
  const kit = page.getByTestId('kit-dialog');
  await expect(kit.getByTestId('kit-env')).toContainText(`vbn_live_${prefix}_…`);
  await expect(kit).not.toContainText(token);
  await kit.getByRole('button', { name: 'Close' }).click();

  // Replace key: it asks first and states the consequence; cancelling changes nothing.
  await page.getByTestId('team-section').getByRole('button', { name: 'Replace my key' }).click();
  const replace = page.getByTestId('replace-key-dialog').filter({ hasText: 'Replace your key?' });
  await expect(replace).toContainText('Your current key stops working at once');
  await expect(replace).toContainText('refused from its next call');
  await expect(replace).toContainText('same permissions, same limits, same people');
  await replace.getByRole('button', { name: 'Cancel' }).click();
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'verified' });
  // Confirmed: a new key, shown once; the old one is refused.
  await page.getByTestId('team-section').getByRole('button', { name: 'Replace my key' }).click();
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

  // Stop the mission from "···": the person types its name; every key is refused from then on.
  await missionMenu(page, 'Stop the mission');
  await expect(page.getByRole('dialog')).toContainText('Every key of the mission stops working');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Stop the mission' }),
  ).toBeDisabled();
  await confirmByTyping(page, 'Ship the billing page', 'Stop the mission');
  await expect(page.getByTestId('mission-state')).toHaveText('stopped');
  // A stopped mission offers nothing that would be refused.
  await page.getByTestId('mission-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Stop the mission' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Replace my key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add keys' })).toHaveCount(0);
  await expect(page.getByTestId('edit-mission')).toHaveCount(0);
  expect(await checkToken(request, rotated)).toMatchObject({
    outcome: 'retired',
    reason: 'revoked',
    mission_status: 'revoked',
  });

  // The list hides stopped missions, like closed pull requests: one click away, counted.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Missions' })
    .click();
  await expect(page.getByRole('row', { name: /Ship the billing page/ })).toHaveCount(0);
  await page
    .getByTestId('missions-filter')
    .getByRole('link', { name: /^\d+ Stopped$/ })
    .click();
  await expect(page).toHaveURL(/\/missions\?state=stopped$/);
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
      accounts: [
        {
          service: 'github',
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
          policy: [
            {
              risk_id: 'github.read-code',
              quota: 100,
              rate_limit: { max: 10, window_seconds: 60 },
            },
            {
              risk_id: 'github.read-meta',
              quota: 100,
              rate_limit: { max: 10, window_seconds: 60 },
            },
          ],
        },
        {
          service: 'supabase',
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

  // What passes fills the screen; what cannot resolve is listed, not loaded.
  const report = page.getByTestId('proposal-report');
  await expect(report).toContainText(/Loaded \d+ permissions on 2 accounts/);
  await expect(report).toContainText('supabase[preview].bulk-row-write');
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR');
  // One card per account and environment: GitHub, Supabase staging, Supabase prod.
  const cards = page.getByTestId('cards').getByRole('region');
  await expect(cards).toHaveCount(3);
  await expect(cardOf(page, 'GitHub · acme-org').getByTestId('card-resources')).toHaveText(
    '1 repository: acme/app',
  );
  // A loaded list carries no trust levels: its rows read Custom, the honest word for them.
  await expect(trustLevelChoice(page, 'GitHub · acme-org', 'Read', 'Custom')).toBeChecked();
  await expect(page.getByLabel('Limits reset')).toHaveValue('one-off');
  // A mission whose limits never reset heads its limit column "In total".
  const modal = await openCustom(page, 'GitHub · acme-org', 'Read');
  await expect(modal.getByRole('columnheader', { name: 'In total' })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancel' }).click();

  const first = await createMission(page);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).not.toContainText('`acme/web`');
  await openCreatedMission(page, 'Review the pricing PR');

  // Duplicate: same cards, its own key.
  await missionMenu(page, 'Duplicate');
  await expect(page.getByTestId('duplicating')).toContainText(
    'Duplicating “Review the pricing PR”',
  );
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR (copy)');
  await expect(cards).toHaveCount(3);
  await expect(cardOf(page, 'GitHub · acme-org').getByTestId('card-resources')).toHaveText(
    '1 repository: acme/app',
  );
  const second = await createMission(page);
  expect(second).not.toBe(first);
  expect(await checkToken(request, first)).toMatchObject({ outcome: 'verified' });
  expect(await checkToken(request, second)).toMatchObject({ outcome: 'verified' });
});

test('the reference shows each service’s page, the site’s, for the version this instance runs', async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reference' })
    .click();
  await expect(page.getByRole('heading', { name: 'Reference', level: 1 })).toBeVisible();
  // One line per shipped plugin, from the registry; none is tagged experimental.
  await expect(page.getByTestId('service-github')).toContainText(
    `${GITHUB.permissions} permissions`,
  );
  await expect(page.getByTestId('service-github')).toContainText(
    `${GITHUB.macroActions} macro-actions`,
  );
  await expect(page.getByTestId('service-github')).toContainText(`${GITHUB.tools} tools`);
  // Each line names its plugin's version; a bundled plugin carries no "pinned" tag.
  await expect(page.getByTestId('service-github').getByTestId('service-version')).toHaveText(
    `plugin ${githubPlugin.version}`,
  );
  await expect(page.getByTestId('services').getByTestId('plugin-pinned')).toHaveCount(0);
  await expect(page.getByTestId('service-gmail')).not.toContainText('experimental');
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
  await snap(page, 'services-index');

  await page.getByTestId('service-supabase').getByRole('link', { name: 'Supabase' }).click();
  // The place keeps its title; the service's page is under it, its name the heading.
  await expect(page.getByRole('heading', { name: 'Reference', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Supabase/, level: 2 })).toBeVisible();
  await expect(services.getByRole('link', { name: 'Supabase' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Above the page, what only this instance knows: the version it runs.
  await expect(page.getByTestId('instance-strip')).toContainText('This gateway runs plugin');
  await expect(page.getByTestId('instance-git-remote')).toHaveCount(0);

  // The page is the site's page of the plugin: its sections, in order.
  const sections = page.locator('.plugin-page section');
  await expect(sections).toHaveCount(8);
  await expect(page.locator('.plugin-page .pp-k')).toHaveText([
    /^1 · The model/,
    /^2 · Macro-actions/,
    /^3 · The map/,
    /^4 · A few calls/,
    /^5 · Anything else/,
    /^6 · Tools/,
    /^7 · Retired permissions/,
    /^8 · Connecting an account/,
  ]);
  await snap(page, 'service-model');

  // The map: Careful by default, the trust level and the environment switch without a script.
  const map = page.locator('section#map');
  const bulk = map.locator('li[data-risk-id="supabase.bulk-row-write"]:visible').first();
  await expect(bulk).toBeVisible();
  await map.locator('label[for="lvl-a"]').click();
  await expect(map.locator('label[for="lvl-a"]')).toBeVisible();
  await map.locator('label', { hasText: 'staging' }).click();
  await expect(map.locator('li[data-risk-id="supabase.bulk-row-write"]:visible')).not.toHaveCount(
    0,
  );
  await snap(page, 'service-map');

  // An anchor of a permission lands on its chip in the map.
  await page.goto('/reference/supabase#risk-supabase.bulk-row-write');
  await expect(page.locator('[id="risk-supabase.bulk-row-write"]')).toBeInViewport();

  // A macro-action anchor lands on its card.
  await page.goto('/reference/github#macro-administer');
  await expect(page.locator('#macro-administer')).toBeInViewport();
  await expect(page.locator('#macro-administer')).toContainText(/\d+ permissions?/);
  // The tools, all of them; the mint tool of earlier builds is gone, its risks retired.
  const tools = page.locator('section#tools');
  await expect(tools.locator('tbody tr')).toHaveCount(GITHUB.tools);
  await expect(tools).not.toContainText('github__mint_install_token');
  await expect(page.locator('section#retired')).toContainText('github.mint-install-token-push');
  // Its git remote, on this instance.
  await expect(page.getByTestId('instance-git-remote')).toContainText('/git/github/');
  // The page's links to the docs go under the instance's docs root, never to a path of its own.
  await expect(page.locator('.plugin-page a[href^="/docs/"]')).toHaveCount(0);
  // The page does not scroll sideways at this width: the map scrolls inside its own box.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await snap(page, 'service-tools');
  // An unknown service is not found.
  const missing = await page.goto('/reference/no-such-service');
  expect(missing?.status()).toBe(404);
});
