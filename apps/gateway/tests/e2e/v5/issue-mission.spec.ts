/**
 * "Issue a mission" in a browser, against an ephemeral instance with a
 * simulated IdP (spec §7.4, §4.2, §4.4).
 *
 * The signed-in user owns a GitHub, a Supabase and a Vercel connection (and
 * an experimental Gmail one). The first test issues a three-connection
 * mission and checks the screen is the one-page flow the spec asks for —
 * compact by default, a preset that says what it contains, the granular
 * Custom editor one click away —, then follows the token through rotation
 * and revocation; the second covers the two other ways to start: an agent's
 * proposal and a duplicate; the third reads the provider reference.
 */
import { expect, test, type Page } from '@playwright/test';

import { checkToken, routeToInstance, signInAs } from './browser';
import { E2E_USER } from './instance';

const TOKEN = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;
/**
 * "About two viewports" (spec §4.2) for the default state of a mission on
 * three connections: every preset described and counted, the one just picked
 * spread out with its quotas. Measured at 1280 x 800, where that state is a
 * little over two screens, the build footer included.
 */
const COMPACT_SCREENS = 2.25;

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

async function includeWithPreset(page: Page, connection: string, preset: string): Promise<void> {
  await page.getByLabel(`Include ${connection}`).check();
  await page
    .getByRole('group', { name: `Preset for ${connection}` })
    .getByRole('radio', { name: new RegExp(`^${preset}\\b`) })
    .check();
}

/** Preset | Custom, the mode switch of one connection. */
async function switchTo(page: Page, connection: string, mode: 'Preset' | 'Custom'): Promise<void> {
  await page
    .getByRole('group', { name: `Policy for ${connection}` })
    .getByRole('radio', { name: mode })
    .click();
}

async function revealedToken(page: Page): Promise<string> {
  const env = await page.getByRole('dialog').getByTestId('kit-env').innerText();
  const match = TOKEN.exec(env);
  if (!match) throw new Error(`no token in the env snippet: ${env}`);
  return match[0];
}

test('issue a three-connection mission on one page, then rotate and revoke', async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole('link', { name: 'New mission' }).first().click();
  await expect(page.getByRole('heading', { name: 'New mission' })).toBeVisible();

  // Experimental plugins stay out of issuance until the creator asks for them.
  await expect(page.getByTestId('connection-gmail')).toHaveCount(0);
  await page.getByLabel('Show experimental providers').check();
  await expect(page.getByTestId('connection-gmail')).toBeVisible();
  await page.getByLabel('Show experimental providers').uncheck();
  await expect(page.getByTestId('connection-gmail')).toHaveCount(0);

  // Nothing is issuable before a name, a connection and a preset.
  const issue = page.getByRole('button', { name: 'Issue mission' });
  await expect(issue).toBeDisabled();

  await page.getByLabel('Mission name').fill('Ship the billing page');
  await includeWithPreset(page, 'GitHub acme-org', 'Developer');
  await includeWithPreset(page, 'Supabase Acme Supabase', 'Staging developer');
  await includeWithPreset(page, 'Vercel Acme Vercel', 'Developer');

  // Resources: all selected by default, folded behind one link per connection.
  await expect(page.getByRole('button', { name: '3 of 3 resources' })).toBeVisible();
  await expect(page.getByLabel('Resource acme/app')).toHaveCount(0);

  // The three-line summary says it all.
  await expect(page.getByTestId('summary-can')).toContainText('GitHub "acme-org"');
  await expect(page.getByTestId('summary-can')).toContainText('Supabase "Acme Supabase"');
  await expect(page.getByTestId('summary-can')).toContainText('Vercel "Acme Vercel"');
  await expect(page.getByTestId('summary-can')).toContainText('on 3 of 3 resources');
  await expect(page.getByTestId('summary-cannot')).toContainText('withheld');
  await expect(page.getByTestId('summary-quantities')).toContainText('per day');
  await expect(page.getByTestId('summary-quantities')).toContainText('never expires');
  await expect(issue).toBeEnabled();

  // A preset says what it means, on the page. The one just picked (Vercel) is
  // spread out; the others keep their description and their counts, and
  // spread out again on one click.
  await expect(page.getByTestId('preset-allowed-vercel')).toContainText('Allowed without asking');
  const digest = page.getByTestId('preset-digest-github');
  await expect(page.getByTestId('preset-detail-github')).toContainText(
    'One mission per code repository',
  );
  await expect(digest).toContainText(
    '8 allowed without asking · 2 need your approval · 5 not included',
  );
  await expect(page.getByTestId('preset-allowed-github')).toHaveCount(0);
  await digest.getByRole('button', { name: 'Show what it allows, with quotas' }).click();
  // What passes, what waits for an approval, what it leaves out: each risk by
  // its human label, with its quota and its rate limit.
  const allowed = page.getByTestId('preset-allowed-github');
  await expect(allowed).toContainText('Allowed without asking (8)');
  await expect(allowed).toContainText('Read code, branches, commits, files');
  await expect(allowed).toContainText('10000 · 240/min');
  const gated = page.getByTestId('preset-approval-github');
  await expect(gated).toContainText('Needs your approval, action by action (2)');
  await expect(gated).toContainText('Modify a GitHub Actions workflow');
  const excluded = page.getByTestId('preset-excluded-github');
  // What it leaves out is counted on the page, and named one click away, in place.
  await expect(excluded.locator('summary')).toContainText('Not included (5)');
  await expect(excluded.getByText('Write on main / master / release-*')).toBeHidden();
  await excluded.locator('summary').click();
  await expect(excluded.getByText('Write on main / master / release-*')).toBeVisible();
  await excluded.locator('summary').click();
  await expect(
    page.getByTestId('preset-detail-github').getByRole('link', { name: /GitHub reference/ }),
  ).toHaveAttribute('href', '/reference/github#preset-developer');
  // The choice itself carries the width of each preset.
  await expect(
    page.getByRole('group', { name: 'Preset for GitHub acme-org' }).getByRole('radio'),
  ).toHaveCount(3);
  await expect(page.getByTestId('preset-github')).toContainText('10 risks · 2 need approval');
  await digest.getByRole('button', { name: 'Hide the lists' }).click();
  await expect(page.getByTestId('preset-allowed-github')).toHaveCount(0);

  // Compact by default: with three connections filled in, no editor is open,
  // there is no wall of checkboxes, and the whole form is about two screens.
  await expect(page.getByTestId('risks-github')).toHaveCount(0);
  await expect(page.locator('[data-risk]')).toHaveCount(0);
  const layout = await page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].filter((el) =>
      el.checkVisibility(),
    ).length,
  }));
  await snap(page, 'creation-three-connections');
  expect(layout.pageHeight).toBeLessThanOrEqual(COMPACT_SCREENS * layout.viewport);
  expect(layout.checkboxes).toBeLessThanOrEqual(6);
  await expect(issue).toBeInViewport();

  // Deselecting the staging project drops the staging-only entries of the preset, and says so.
  await page.getByRole('button', { name: '2 of 2 resources' }).first().click();
  await page.getByLabel('Resource stgprojectref').uncheck();
  const supabaseDigest = page.getByTestId('preset-digest-supabase');
  await expect(supabaseDigest).toContainText('of the preset left out here');
  await supabaseDigest.getByRole('button', { name: 'Show what it allows, with quotas' }).click();
  await expect(page.getByTestId('preset-skipped-supabase')).toContainText('left out here');
  await expect(page.getByTestId('preset-skipped-supabase')).toContainText('labelled "staging"');
  await page.getByLabel('Resource stgprojectref').check();
  await expect(page.getByTestId('preset-skipped-supabase')).toHaveCount(0);
  await expect(supabaseDigest).not.toContainText('left out here');

  // Custom, one click away: the full editor opens in place on the preset's values.
  await switchTo(page, 'GitHub acme-org', 'Custom');
  const editor = page.getByTestId('risks-github');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('preset-detail-github')).toHaveCount(0);
  // Every risk of the catalog is there, by its label, with why it is a risk and its vector.
  await expect(editor.locator('[data-risk]')).toHaveCount(15);
  const merge = editor.locator('[data-risk="github.merge-protected"]');
  await expect(merge).toContainText('Write on main / master / release-*');
  await expect(merge).toContainText('The canonical branch');
  // The vector is a six-cell strip: each cell writes its value and names its axis in full.
  await expect(merge.locator('[aria-label="Reversibility: costly"]')).toHaveText(/costly/);
  // The reason is one line that unfolds in place.
  const why = merge.locator('details');
  await expect(why).not.toHaveAttribute('open', '');
  await why.locator('summary').click();
  await expect(why).toHaveAttribute('open', '');
  await expect(merge.getByRole('link', { name: 'github.merge-protected' })).toHaveAttribute(
    'href',
    '/reference/github#risk-github.merge-protected',
  );
  await expect(page.getByLabel('Accept risk github.merge-protected')).not.toBeChecked();
  await expect(page.getByLabel('Accept risk github.read-code')).toBeChecked();
  await expect(page.getByLabel('Quota for github.read-code')).toHaveValue('10000');
  await expect(page.getByTestId('risks-count-github')).toHaveText(
    '10 accepted of 15 you can accept here',
  );
  // Adjust one quota and one gate.
  await page.getByLabel('Quota for github.read-code').fill('42');
  await page.getByLabel('Gate for github.create-pr').selectOption('approval');
  await expect(page.getByTestId('summary-quantities')).toContainText(
    '3 risks need your approval for each action',
  );
  // Going back to Preset would drop those edits: the screen asks first.
  await switchTo(page, 'GitHub acme-org', 'Preset');
  await expect(page.getByTestId('discard-github')).toContainText('discards what you changed');
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('[data-testid^="discard-"]')).toHaveCount(0);
  await expect(page.getByLabel('Quota for github.read-code')).toHaveValue('42');

  // A long catalog is searchable; what no selected resource can resolve is
  // listed with the reason and cannot be ticked.
  await switchTo(page, 'Supabase Acme Supabase', 'Custom');
  const supabase = page.getByTestId('risks-supabase');
  const all = await supabase.locator('[data-risk]').count();
  await supabase.getByLabel('Search the risks of Supabase Acme Supabase').fill('bulk row');
  const found = await supabase.locator('[data-risk]').count();
  expect(found).toBeGreaterThan(0);
  expect(found).toBeLessThan(all);
  await expect(page.getByLabel('Accept risk supabase[preview].bulk-row-write')).toBeDisabled();
  await expect(supabase.locator('[data-risk="supabase[preview].bulk-row-write"]')).toContainText(
    'Not available: no selected resource is labelled "preview"',
  );
  await supabase.getByLabel('Search the risks of Supabase Acme Supabase').fill('');
  // A provider with several planes can be sliced by one, in the editor too.
  const plane = supabase.getByLabel('Plane of the risks of Supabase Acme Supabase');
  await plane.selectOption('storage');
  const storage = await supabase.locator('[data-risk]').count();
  expect(storage).toBeGreaterThan(0);
  expect(storage).toBeLessThan(all);
  await expect(supabase.locator('[data-risk*="migration-write"]')).toHaveCount(0);
  await expect(supabase.locator('[data-risk*="storage.object-read"]')).toHaveCount(1);
  await snap(page, 'creation-custom-plane');
  await plane.selectOption('all');
  expect(await supabase.locator('[data-risk]').count()).toBe(all);
  // GitHub has one plane: no plane filter there.
  await expect(page.getByLabel('Plane of the risks of GitHub acme-org')).toHaveCount(0);
  // The helper of the editor is one line; the rest is on demand.
  await expect(supabase.getByText('it leaves out deprecated entries')).toBeHidden();
  await snap(page, 'creation-custom-mode');
  // Untouched, the Supabase policy is still the preset's: going back asks nothing.
  await switchTo(page, 'Supabase Acme Supabase', 'Preset');
  await expect(page.locator('[data-testid^="discard-"]')).toHaveCount(0);
  await expect(page.getByTestId('preset-detail-supabase')).toBeVisible();

  await page.getByLabel('Period').selectOption({ label: 'Quotas reload every week' });
  await page.getByLabel('Expiry').selectOption({ label: 'Expires in 30 days' });
  await expect(page.getByTestId('summary-quantities')).toContainText('per week');

  await issue.click();

  // Reveal once, with the bootstrap kit.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Mission “Ship the billing page” issued');
  const token = await revealedToken(page);
  await expect(page.getByTestId('kit-mcp')).toContainText('"url": "https://gateway.e2e.test/mcp"');
  await expect(page.getByTestId('kit-mcp')).toContainText('Bearer ${VAUBAAN_MISSION_TOKEN}');
  await expect(page.getByTestId('kit-mcp')).not.toContainText(token);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).toContainText('`github.read-code`');
  await expect(page.getByTestId('kit-instructions')).toContainText('hand `claim_url` to the human');
  await expect(page.getByTestId('kit-instructions')).toContainText('Never work around a refusal');
  await expect(page.getByTestId('kit-verify')).toContainText('"method":"tools/list"');
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'verified' });
  await snap(page, 'reveal-once-dialog');

  // The revisited page shows the prefix, never the secret.
  await page.getByRole('button', { name: 'I copied the token' }).click();
  await expect(page.getByRole('heading', { name: /Ship the billing page/ })).toBeVisible();
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  const prefix = token.split('_')[2] ?? '';
  await expect(page.getByText(`vbn_live_${prefix}_…`).first()).toBeVisible();
  expect(await page.content()).not.toContain(token);
  const readCode = page.getByRole('row', { name: /github\.read-code/ });
  await expect(readCode).toContainText('42');
  await expect(page.getByRole('row', { name: /github\.create-pr/ })).toContainText('approval');
  // The policy table explains each risk the way the editor did.
  await expect(readCode).toContainText('Read code, branches, commits, files');
  await expect(readCode).toContainText('Reads may leak secrets');
  await expect(readCode.locator('[aria-label="Data: data"]')).toBeVisible();
  // Outside the provider reference too, a name carries the colour of its kind.
  await expect(readCode.getByRole('link', { name: 'github.read-code' })).toHaveAttribute(
    'data-kind',
    'risk',
  );
  await expect(page.locator('[data-kind="resource"]').first()).toContainText('acme/');
  await expect(page.locator('[data-kind="token"]').first()).toContainText('vbn_live_');

  await snap(page, 'mission-detail');

  // Each risk id links to its entry in the provider reference.
  const missionUrl = page.url();
  await readCode.getByRole('link', { name: 'github.read-code' }).click();
  await expect(page).toHaveURL(/\/reference\/github#risk-github\.read-code$/);
  await expect(page.getByTestId('risk-github.read-code')).toBeInViewport();
  await expect(page.getByTestId('risk-github.read-code')).toContainText(
    'Read code, branches, commits, files',
  );
  await page.goto(missionUrl);
  await expect(page.getByRole('heading', { name: /Ship the billing page/ })).toBeVisible();

  // Rotate: a new secret, shown once; the old token is refused.
  await page.getByRole('button', { name: 'Rotate token' }).click();
  await expect(page.getByRole('dialog')).toContainText('New token for');
  const rotated = await revealedToken(page);
  expect(rotated).not.toBe(token);
  expect(await checkToken(request, token)).toMatchObject({ outcome: 'retired', reason: 'rotated' });
  expect(await checkToken(request, rotated)).toMatchObject({ outcome: 'verified' });
  await page.getByRole('button', { name: 'I copied the token' }).click();

  // Revoke: the mission refuses everything from now on.
  await page.getByRole('button', { name: 'Revoke mission' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Ship the billing page');
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('revoked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate token' })).toHaveCount(0);
  expect(await checkToken(request, rotated)).toMatchObject({
    outcome: 'retired',
    reason: 'revoked',
    mission_status: 'revoked',
  });

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Missions' })
    .click();
  await expect(page.getByRole('row', { name: /Ship the billing page/ })).toContainText('revoked');
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
  await expect(page.getByText(/Loaded \d+ risks on 2 connections/)).toBeVisible();
  await expect(
    page.getByText(/No selected resource of "Acme Supabase" is labelled "preview"/),
  ).toBeVisible();
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR');
  await expect(page.getByLabel('Include GitHub acme-org')).toBeChecked();
  await expect(page.getByRole('button', { name: '1 of 3 resources' })).toBeVisible();
  // A loaded policy is a custom one: shown as the explicit list, edited on demand.
  await expect(
    page.getByRole('group', { name: 'Policy for GitHub acme-org' }).getByRole('radio', {
      name: 'Custom',
    }),
  ).toBeChecked();
  await expect(page.getByTestId('custom-github')).toContainText('Custom policy, as loaded');
  await expect(page.getByTestId('custom-github')).toContainText(
    'Read code, branches, commits, files',
  );
  await expect(page.getByTestId('risks-github')).toHaveCount(0);
  await page
    .getByTestId('custom-github')
    .getByRole('button', { name: 'Edit risk by risk' })
    .click();
  await expect(page.getByLabel('Accept risk github.read-code')).toBeChecked();
  await expect(page.getByLabel('Period')).toHaveValue('one-off');
  await expect(page.getByTestId('summary-quantities')).toContainText('in total');

  const issue = page.getByRole('button', { name: 'Issue mission' });
  await expect(issue).toBeEnabled();
  await issue.click();
  const first = await revealedToken(page);
  await expect(page.getByTestId('kit-instructions')).toContainText('`acme/app`');
  await expect(page.getByTestId('kit-instructions')).not.toContainText('`acme/web`');
  await page.getByRole('button', { name: 'I copied the token' }).click();
  await expect(page.getByRole('heading', { name: /Review the pricing PR/ })).toBeVisible();

  // Duplicate: same policy, its own token.
  await page.getByRole('link', { name: 'Duplicate' }).click();
  await expect(page.getByText('Duplicating “Review the pricing PR”')).toBeVisible();
  await expect(page.getByLabel('Mission name')).toHaveValue('Review the pricing PR (copy)');
  await expect(page.getByLabel('Include Supabase Acme Supabase')).toBeChecked();
  await expect(page.getByRole('button', { name: '1 of 3 resources' })).toBeVisible();
  await page.getByRole('button', { name: 'Issue mission' }).click();
  const second = await revealedToken(page);
  expect(second).not.toBe(first);
  expect(await checkToken(request, first)).toMatchObject({ outcome: 'verified' });
  expect(await checkToken(request, second)).toMatchObject({ outcome: 'verified' });
});

test('the provider reference explains each plugin: model, risks, presets, tools', async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reference' })
    .click();
  await expect(page.getByRole('heading', { name: 'Reference', level: 1 })).toBeVisible();
  // One card per shipped plugin, from the registry; the experimental one says so.
  await expect(page.getByTestId('provider-github')).toContainText('App installation');
  await expect(page.getByTestId('provider-github')).toContainText('15 risks');
  await expect(page.getByTestId('provider-github')).toContainText('3 presets');
  // A card says what tells it apart: the planes of its model, the environments it knows.
  await expect(page.getByTestId('provider-supabase').locator('[data-kind="plane"]')).toHaveText([
    /db/,
    /storage/,
    /auth/,
    /functions/,
  ]);
  await expect(page.getByTestId('provider-supabase')).toContainText('staging');
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
  await expect(page.getByTestId('provider-gmail')).toContainText('experimental');
  await snap(page, 'providers-index');

  await page.getByTestId('provider-supabase').click();
  await expect(page.getByRole('heading', { name: 'Supabase', level: 1 })).toBeVisible();
  await expect(page.getByTestId('provider-summary')).toContainText('one resource is one project');

  // One section in view at a time, behind tabs; the presets come first.
  const tabs = page.getByRole('tablist', { name: 'Supabase reference' });
  await expect(tabs.getByRole('tab')).toHaveText([/Presets/, /Risks/, /Data model/, /Tools/]);
  await expect(tabs.getByRole('tab', { name: /Presets/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  // Help is on demand: collapsed by default, and remembered once opened.
  const help = page.getByTestId('reference-help');
  await expect(help).toBeHidden();
  await page.getByRole('button', { name: 'How to read this page' }).click();
  await expect(help.getByText('Can it be undone, and at what price?')).toBeVisible();
  await expect(help.getByTestId('kind-legend').locator('[data-kind]')).toHaveCount(9);
  await page.reload();
  await expect(help).toBeVisible();
  await page.getByRole('button', { name: 'How to read this page' }).click();
  await expect(help).toBeHidden();

  // The presets side by side: one column each against the risks, a cell per budget.
  const matrix = page.getByTestId('preset-matrix');
  const preset = page.getByTestId('preset-staging-developer');
  await expect(preset).toContainText('Staging developer');
  await expect(preset).toHaveAttribute('data-kind', 'preset');
  await expect(preset).toContainText(/\d+ risks · \d+ left out/);
  await expect(matrix.getByRole('columnheader')).toHaveCount(4);
  const bulkCell = page.getByTestId('cell-staging-developer-supabase.bulk-row-write');
  await expect(bulkCell).toContainText('staging');
  await expect(bulkCell).toContainText(/\d+\/min/);
  await expect(page.getByTestId('cell-read-only-analyst-supabase.bulk-row-write')).toContainText(
    'not included',
  );
  await expect(page.getByTestId('cell-migration-operator-supabase.migration-write')).toContainText(
    'approval',
  );
  await snap(page, 'provider-presets');

  // The planes of the data model slice every section at once.
  const planes = page.getByTestId('plane-control');
  await expect(planes.getByRole('radio')).toHaveCount(6);
  await planes.getByRole('radio', { name: /^storage/ }).check();
  await expect(matrix.locator('tr[data-risk]')).toHaveCount(6);
  await expect(matrix).not.toContainText('Apply a migration');
  await tabs.getByRole('tab', { name: /Tools/ }).click();
  await expect(page).toHaveURL(/#tools$/);
  await expect(page.getByTestId('tool-supabase__list_buckets')).toBeVisible();
  await expect(page.getByTestId('tool-supabase__list_users')).toHaveCount(0);
  await expect(page.getByTestId('tool-supabase__list_buckets')).toContainText('by arguments');
  await expect(
    page.getByTestId('tool-supabase__list_buckets').locator('[data-kind="tool"]'),
  ).toHaveText(/supabase__list_buckets/);
  // What no plane can be read for is under "other", not guessed.
  await planes.getByRole('radio', { name: /^other/ }).check();
  await expect(page.getByTestId('tool-supabase__execute_sql')).toBeVisible();
  // The keyboard moves between tabs.
  await tabs.getByRole('tab', { name: /Tools/ }).press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: /Data model/ })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: /Data model/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await planes.getByRole('radio', { name: 'All' }).check();
  // The data model as an outline, with the entity that carries the environment.
  await expect(page.getByRole('region', { name: 'Plane db' })).toContainText('schema');
  await expect(page.getByTestId('provider-environment')).toContainText(
    'the label the connection owner puts on each resource',
  );
  await expect(page.getByText('carries the environment').first()).toBeVisible();
  await snap(page, 'provider-data-model');

  // A risk anchor opens the Risks tab on a plane that shows the entry, and unfolds it.
  await planes.getByRole('radio', { name: /^auth/ }).check();
  await page.goto('/reference/supabase#risk-supabase.bulk-row-write');
  await expect(tabs.getByRole('tab', { name: /Risks/ })).toHaveAttribute('aria-selected', 'true');
  const entry = page.getByTestId('risk-supabase.bulk-row-write');
  await expect(entry).toBeInViewport();
  await expect(entry.getByRole('button', { name: 'Bulk write on a table' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(entry).toContainText('supabase.bulk-row-write');
  await expect(entry).toContainText('Environment-scoped');
  await expect(entry).toContainText('supabase[staging].bulk-row-write');
  await expect(entry.locator('[aria-label^="Reversibility:"]').first()).toBeVisible();
  await expect(entry).toContainText('Write: project');
  await expect(entry).toContainText('supabase.project');
  // It names the presets that include it, and each leads to its column.
  await expect(entry.locator('[data-kind="preset"]')).toHaveText([
    /Staging developer/,
    /Migration operator/,
  ]);
  // The reader was on `auth`, which does not show this entry: its own plane was opened.
  await expect(planes.getByRole('radio', { name: /^db/ })).toBeChecked();
  await expect(page.getByTestId('risk-supabase.auth.generate-link')).toHaveCount(0);
  await planes.getByRole('radio', { name: 'All' }).check();
  // A row is compact until asked: collapsed, the patterns are not on the page.
  const collapsed = page.getByTestId('risk-supabase.read-data');
  await expect(collapsed.getByRole('button', { name: 'Read data and schema' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(collapsed).not.toContainText('Read anything in supabase');
  await collapsed.getByRole('button', { name: 'Read data and schema' }).click();
  await expect(collapsed).toContainText('Read anything in supabase');
  // The fallback is explained where it is listed, in a callout, once unfolded.
  const fallback = page.getByTestId('risk-supabase.uncategorized-write');
  await fallback.getByRole('button', { name: /Uncategorized Supabase write/ }).click();
  await expect(fallback.getByRole('note')).toContainText(
    'Counts only for a write no other entry of the catalog names',
  );
  await snap(page, 'provider-risks');
  await entry.locator('[data-kind="preset"]', { hasText: 'Migration operator' }).click();
  await expect(page).toHaveURL(/#preset-migration-operator$/);
  await expect(page.getByTestId('preset-migration-operator')).toBeInViewport();

  // A preset anchor, as mission creation links to it; a single-plane provider has no plane control.
  await page.goto('/reference/github#preset-developer');
  await expect(page.getByTestId('preset-developer')).toBeInViewport();
  await expect(page.getByTestId('plane-control')).toHaveCount(0);
  await expect(page.getByTestId('preset-matrix')).toContainText('Modify a GitHub Actions workflow');
  await expect(page.getByTestId('cell-developer-github.workflow-write-via-file')).toContainText(
    'approval',
  );
  // Fifteen risks, collapsed, read in about one and a half screens.
  await page.goto('/reference/github#risks');
  await expect(page.locator('article[data-testid^="risk-github."]')).toHaveCount(15);
  const first = await page.getByTestId('risk-github.read-code').boundingBox();
  const last = await page.getByTestId('risk-github.delete-release').boundingBox();
  const viewport = page.viewportSize();
  if (!first || !last || !viewport) throw new Error('the risk list is not laid out');
  expect((last.y + last.height - first.y) / viewport.height).toBeLessThan(1.75);
  // The one tool that hands a provider token to the agent, and its risks, say so.
  await page.goto('/reference/github#tools');
  await expect(page.getByRole('tab', { name: /Tools/ })).toHaveAttribute('aria-selected', 'true');
  const mint = page.getByRole('row', { name: /github__mint_install_token/ });
  await expect(mint).toContainText('hands a token to the agent');
  await expect(mint.getByRole('link', { name: 'github.mint-install-token-push' })).toHaveAttribute(
    'href',
    '/reference/github#risk-github.mint-install-token-push',
  );
  await expect(page.getByTestId('token-handout-note')).toContainText(
    'What the agent then does with that token is outside the gateway',
  );
  await mint.getByRole('link', { name: 'github.mint-install-token-push' }).click();
  const push = page.getByTestId('risk-github.mint-install-token-push');
  await expect(push).toBeInViewport();
  // The badge says what the token can do: a preset hands a write token after approval only.
  await expect(push).toContainText('hands a write token');
  await expect(push.locator('[data-kind="tool"]')).toHaveText(/github__mint_install_token/);
  await expect(page.getByTestId('risk-github.mint-install-token-clone')).toContainText(
    'hands a read-only token',
  );
  await expect(page.getByTestId('risk-github.read-code')).not.toContainText('hands a');
  await snap(page, 'provider-token-handouts');
  await expect(page.getByTestId('token-handout-note')).toContainText(
    'a token that can write is handed only after the creator approves the call',
  );
  // An unknown provider is not found.
  const missing = await page.goto('/reference/no-such-provider');
  expect(missing?.status()).toBe(404);
});
