/**
 * How a browser test drives the mission pages (the list, "New mission", one
 * mission, its activity): the steps several specs share, written once, with
 * the words and the structure of the interface.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const KEY = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;

/** A trust cran as the interface names it. */
export type Cran = 'Prudent' | 'Confiant' | 'Autonome';

/**
 * Includes an account in the mission being created and ticks macro-actions at a
 * cran, by their labels: `{ Read: 'Confiant', Propose: 'Prudent' }`.
 */
export async function includeWithCrans(
  page: Page,
  account: string,
  crans: Readonly<Record<string, Cran>>,
): Promise<void> {
  await page.getByLabel(`Include ${account}`).check();
  for (const [action, cran] of Object.entries(crans)) await pickCran(page, account, action, cran);
}

/** The radio of one cran of a macro-action of an account. */
export function cranChoice(page: Page, account: string, action: string, cran: Cran): Locator {
  return page
    .getByRole('group', { name: `Cran of ${action} on ${account}` })
    .getByRole('radio', { name: new RegExp(`^${cran}\\b`) });
}

/** Ticks a macro-action at a cran (or moves it there). */
export async function pickCran(
  page: Page,
  account: string,
  action: string,
  cran: Cran,
): Promise<void> {
  await cranChoice(page, account, action, cran).check();
}

/** The Simple or Advanced view of an account's permissions. */
export async function showView(
  page: Page,
  account: string,
  view: 'Simple' | 'Advanced',
): Promise<void> {
  await page
    .getByRole('tablist', { name: `View of the permissions of ${account}` })
    .getByRole('tab', { name: view })
    .click();
}

/** The button that opens the resource list of an account; its name says "N of M resources". */
export function resourcesButton(page: Page, account: string, counted?: string): Locator {
  const pattern = counted
    ? new RegExp(`resources of ${account}: ${counted} resources?$`)
    : new RegExp(`resources of ${account}:`);
  return page.getByRole('button', { name: pattern });
}

/**
 * "Create mission", then the confirmation that lists every permission with
 * its limit, then the key shown once. Returns the key.
 */
export async function createMission(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create mission' }).click();
  const confirm = page.getByTestId('confirm-create');
  await expect(confirm.getByTestId('explicit-list')).toBeVisible();
  await confirm.getByRole('button', { name: 'Create mission' }).click();
  await expect(page.getByTestId('created')).toBeVisible();
  return revealedKey(page);
}

/** The key a page or a dialog shows once, read from the box and checked against the kit. */
export async function revealedKey(page: Page): Promise<string> {
  const shown = (await page.getByTestId('revealed-key').innerText()).trim();
  const match = KEY.exec(shown);
  if (!match) throw new Error(`no key in the box: ${shown}`);
  // The first snippet of the kit carries the same key, and no other snippet does.
  await expect(page.getByTestId('kit-env')).toContainText(match[0]);
  return match[0];
}

/** After a creation: "Open the mission". */
export async function openCreatedMission(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole('link', { name: 'Open the mission' }).click();
  // The page that showed the key carries the same title: wait for the mission's own page.
  await page.waitForURL(/\/missions\/(?!new(?:[?#]|$))[^/?#]+$/);
  await expect(page.getByTestId('created')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** Closes the dialog that shows a key once. */
export async function savedKey(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'I saved the key' }).click();
  await expect(page.getByTestId('reveal-dialog')).toBeHidden();
}

/** Opens "···" on a mission page and chooses an item. */
export async function missionMenu(page: Page, item: string): Promise<void> {
  await page.getByTestId('mission-menu').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Unfolds "Permissions and usage" on a mission page (remembered per mission afterwards). */
export async function showPermissions(page: Page): Promise<Locator> {
  const table = page.getByTestId('permissions-table');
  if (!(await table.isVisible())) {
    await page
      .getByTestId('mission-permissions')
      .getByRole('button', { name: /^All \d+ permissions?/ })
      .click();
  }
  await expect(table).toBeVisible();
  return table;
}

/** The row of one permission, by the id the protocol gives it. */
export function permissionRow(scope: Page | Locator, riskId: string): Locator {
  return scope.locator(`[data-permission="${riskId}"]`);
}

/** The row of a key holder in "People and keys": `member:<email>` or `machine:<name>`. */
export function holderRow(page: Page, id: string): Locator {
  return page.getByTestId('team-table').locator(`tr[data-row="${id}"]`);
}

/** Types the phrase a destructive dialog asks for, then confirms with the button named after the act. */
export async function confirmByTyping(page: Page, phrase: string, act: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(phrase);
  await dialog.getByRole('button', { name: act, exact: true }).click();
}
